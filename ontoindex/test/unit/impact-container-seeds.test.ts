import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphQuery = vi.hoisted(() => ({
  impl: (async () => []) as (
    repo: string,
    query: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown[]>,
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (repo: string, query: string, params?: Record<string, unknown>) =>
    graphQuery.impl(repo, query, params),
  executeQuery: vi.fn(),
  isLbugReady: vi.fn().mockReturnValue(true),
  isWriteQuery: vi.fn().mockReturnValue(false),
}));

import {
  MAX_CONTAINER_MEMBER_SEEDS,
  resolveImpactTargetKind,
  runImpactKernel,
} from '../../src/core/impact/impact-kernel.js';
import { runImpactBFS } from '../../src/mcp/local/backend-impact.js';

const FILE = 'crates/mcp/src/connection_manager.rs';
const IMPL = `Impl:${FILE}:Manager`;
const STRUCT = `Struct:${FILE}:Manager`;
const NEW = `Function:${FILE}:Manager.new`;
const LIST = `Function:${FILE}:Manager.list_tools`;
const DROP = `Function:${FILE}:Manager.drop`;

type Params = Record<string, unknown>;
interface Graph {
  members: Record<string, Array<{ id: string; type: string }>>;
  callers: Record<string, Array<{ id: string; name: string; filePath: string }>>;
  typesByName?: Record<string, string[]>;
  implsByName?: Record<string, string[]>;
}

function installGraph(graph: Graph) {
  graphQuery.impl = async (_repo: string, query: string, params?: Params) => {
    const p = params ?? {};
    if (query.includes("hm.type = 'HAS_METHOD'")) {
      return (p.ownerIds as string[]).flatMap((id) => graph.members[id] ?? []);
    }
    if (query.includes('MATCH (i:Impl)')) {
      return (graph.implsByName?.[p.name as string] ?? []).map((id) => ({ id }));
    }
    if (query.includes("label(t) = 'Struct'")) {
      return (graph.typesByName?.[p.name as string] ?? []).map((id) => ({ id }));
    }
    if (query.includes('$frontierIds')) {
      return (p.frontierIds as string[]).flatMap((target) =>
        (graph.callers[target] ?? []).map((c) => ({
          sourceId: target,
          id: c.id,
          name: c.name,
          type: 'Function',
          filePath: c.filePath,
          relType: 'CALLS',
          confidence: 0.9,
        })),
      );
    }
    return [];
  };
}

const rustGraph: Graph = {
  members: {
    [IMPL]: [
      { id: NEW, type: 'Function' },
      { id: LIST, type: 'Function' },
    ],
    [STRUCT]: [{ id: DROP, type: 'Function' }],
  },
  callers: {
    [NEW]: [
      { id: LIST, name: 'list_tools', filePath: FILE },
      { id: 'Function:core/session.rs:Session.new', name: 'new', filePath: 'core/session.rs' },
      { id: 'Function:core/mcp.rs:refresh', name: 'refresh', filePath: 'core/mcp.rs' },
    ],
  },
};

describe('impact container seed expansion (Rust Impl/Struct)', () => {
  beforeEach(() => {
    graphQuery.impl = async () => [];
  });

  it('derives the kind from the id prefix when the label is empty', () => {
    expect(resolveImpactTargetKind('', IMPL)).toBe('Impl');
    expect(resolveImpactTargetKind('', STRUCT)).toBe('Struct');
    expect(resolveImpactTargetKind('', `Function:${FILE}:f`)).toBe('');
    expect(resolveImpactTargetKind('Class', IMPL)).toBe('Class');
  });

  it('seeds an Impl target with its methods and the same-file Struct methods', async () => {
    installGraph(rustGraph);
    const result = await runImpactKernel(
      { id: 'repo' },
      { id: IMPL, name: 'Manager', type: '', filePath: FILE },
      { direction: 'upstream', maxDepth: 1 },
    );
    expect(result.rawCounts.seedUids).toEqual([IMPL, NEW, LIST, DROP]);
    expect(result.rawCounts.seedExpansion).toMatchObject({
      kind: 'Impl',
      ownedMethods: 3,
      seededMembers: 3,
      unseededMembers: 0,
    });
    // Sibling methods are seeds, so they are not reported as callers.
    expect(result.impacted.map((n) => n.id).sort()).toEqual([
      'Function:core/mcp.rs:refresh',
      'Function:core/session.rs:Session.new',
    ]);
    expect(result.unknownReason).toBeUndefined();
  });

  it('seeds a Struct target with the same-file Impl and a unique impl in another file', async () => {
    const otherImpl = 'Impl:crates/mcp/src/manager_ext.rs:Manager';
    const ext = 'Function:crates/mcp/src/manager_ext.rs:Manager.ext';
    installGraph({
      ...rustGraph,
      members: { ...rustGraph.members, [otherImpl]: [{ id: ext, type: 'Function' }] },
      typesByName: { Manager: [STRUCT] },
      implsByName: { Manager: [IMPL, otherImpl] },
    });
    const result = await runImpactKernel(
      { id: 'repo' },
      { id: STRUCT, name: 'Manager', type: 'Struct', filePath: FILE },
      { direction: 'upstream', maxDepth: 1 },
    );
    expect(result.rawCounts.seedExpansion?.ownerUids).toEqual([STRUCT, IMPL, otherImpl]);
    expect(result.rawCounts.seedUids).toEqual(expect.arrayContaining([NEW, LIST, DROP, ext]));
    expect(result.impacted).toHaveLength(2);
  });

  it('skips impls in other files when several types share the name', async () => {
    const otherImpl = 'Impl:other/crate/lib.rs:Manager';
    installGraph({
      ...rustGraph,
      typesByName: { Manager: [STRUCT, 'Struct:other/crate/lib.rs:Manager'] },
      implsByName: { Manager: [IMPL, otherImpl] },
    });
    const result = await runImpactKernel(
      { id: 'repo' },
      { id: STRUCT, name: 'Manager', type: 'Struct', filePath: FILE },
      { direction: 'upstream', maxDepth: 1 },
    );
    expect(result.rawCounts.seedExpansion?.ownerUids).toEqual([STRUCT, IMPL]);
    expect(result.warnings.join('\n')).toMatch(/1 impl block\(s\) named Manager .* not expanded/);
  });

  it('caps member seeds, marks the result partial, and says so', async () => {
    const many = Array.from({ length: MAX_CONTAINER_MEMBER_SEEDS + 5 }, (_, i) => ({
      id: `Function:${FILE}:Manager.m${i}`,
      type: 'Function',
    }));
    installGraph({ members: { [IMPL]: many }, callers: {} });
    const result = await runImpactKernel(
      { id: 'repo' },
      { id: IMPL, name: 'Manager', type: 'Impl', filePath: FILE },
      { direction: 'upstream', maxDepth: 1 },
    );
    expect(result.rawCounts.seedUids).toHaveLength(MAX_CONTAINER_MEMBER_SEEDS + 1);
    expect(result.partial).toBe(true);
    expect(result.warnings.join('\n')).toContain(
      `capped at ${MAX_CONTAINER_MEMBER_SEEDS} of ${MAX_CONTAINER_MEMBER_SEEDS + 5} members`,
    );
    expect(result.unknownReason).toBe('container_members_not_traversed:5');
  });
});

describe('impact risk when callers could not be seen', () => {
  beforeEach(() => {
    graphQuery.impl = async () => [];
  });

  it('reports UNKNOWN for a class with methods and no traversed callers', async () => {
    const cls = 'Class:src/a.ts:Widget';
    installGraph({
      members: {
        [cls]: [
          { id: 'Method:src/a.ts:Widget.render', type: 'Method' },
          { id: 'Method:src/a.ts:Widget.update', type: 'Method' },
        ],
      },
      callers: {},
    });
    const result = await runImpactBFS(
      { id: 'repo' } as never,
      { id: cls, name: 'Widget', filePath: 'src/a.ts' },
      'Class',
      'upstream',
      { maxDepth: 1, relationTypes: ['CALLS'], includeTests: false, minConfidence: 0 },
    );
    expect(result.risk).toBe('UNKNOWN');
    expect(result.rawCounts.riskReasons).toContain('container_members_not_traversed:2');
    expect(result.warnings?.join('\n')).toMatch(/owns 2 method\(s\) that were not traversed/);
  });

  it('keeps LOW for a function with no callers and records the reason', async () => {
    installGraph({ members: {}, callers: {} });
    const result = await runImpactBFS(
      { id: 'repo' } as never,
      { id: 'Function:src/a.ts:unused', name: 'unused', filePath: 'src/a.ts' },
      'Function',
      'upstream',
      { maxDepth: 1, relationTypes: ['CALLS'], includeTests: false, minConfidence: 0 },
    );
    expect(result.risk).toBe('LOW');
    expect(result.rawCounts.riskReasons).toContain('no_impacted_nodes');
  });

  it('reports a Rust Impl with an empty label by its callers instead of LOW 0', async () => {
    installGraph(rustGraph);
    const result = await runImpactBFS(
      { id: 'repo' } as never,
      { id: IMPL, name: 'Manager', filePath: FILE },
      '',
      'upstream',
      { maxDepth: 1, relationTypes: ['CALLS'], includeTests: false, minConfidence: 0 },
    );
    expect(result.impactedCount).toBe(2);
    expect(result.rawCounts.seedExpansion?.kind).toBe('Impl');
  });
});
