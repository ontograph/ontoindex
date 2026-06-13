import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphRelationship } from 'ontoindex-shared';
import {
  buildGraphHtmlPayload,
  createGraphOverviewHtml,
} from '../../src/core/graph/graph-html-export.js';

function node(
  id: string,
  label: GraphNode['label'],
  name: string,
  filePath?: string,
  extra: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    label,
    properties: {
      name,
      filePath: filePath ?? '',
      ...extra,
    },
  };
}

function relationship(
  sourceId: string,
  type: GraphRelationship['type'],
  targetId: string,
): GraphRelationship {
  return {
    id: `${sourceId}_${type}_${targetId}`,
    sourceId,
    targetId,
    type,
    confidence: 1,
    reason: type,
  };
}

describe('graph-html-export', () => {
  const graph = {
    nodes: [
      node('file:auth', 'File', 'auth.ts', 'src/auth/auth.ts'),
      node('fn:login', 'Function', 'login', 'src/auth/auth.ts'),
      node('fn:save', 'Function', 'saveSession', 'src/storage/session.ts'),
      node('proc:login', 'Process', 'LoginFlow', '', { heuristicLabel: 'LoginFlow' }),
      node('comm:auth', 'Community', 'Auth', '', { heuristicLabel: 'Auth' }),
      node('comm:storage', 'Community', 'Storage', '', { heuristicLabel: 'Storage' }),
    ],
    relationships: [
      relationship('file:auth', 'CONTAINS', 'fn:login'),
      relationship('fn:login', 'CALLS', 'fn:save'),
      relationship('fn:login', 'STEP_IN_PROCESS', 'proc:login'),
      relationship('fn:login', 'MEMBER_OF', 'comm:auth'),
      relationship('fn:save', 'MEMBER_OF', 'comm:storage'),
    ],
  };

  it('derives functional slices from graph evidence', () => {
    const payload = buildGraphHtmlPayload(graph, {
      repoId: 'ontoindex',
      repoPath: '/repo',
      generatedAt: '2026-06-13T00:00:00.000Z',
      indexedAt: '2026-06-13T00:00:00.000Z',
      indexedHead: 'abc1234',
      summary: false,
    });

    expect(payload.counts).toEqual({ nodes: 6, relationships: 5 });
    expect(payload.slices.processes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'proc:login', count: 1 })]),
    );
    expect(payload.slices.communities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'comm:auth', count: 1 }),
        expect.objectContaining({ id: 'comm:storage', count: 1 }),
      ]),
    );
    expect(payload.slices.areas).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'src', count: 6 })]),
    );
    const loginNode = payload.nodes.find((entry) => entry.id === 'fn:login');
    expect(loginNode).toMatchObject({
      processIds: ['proc:login'],
      communityIds: ['comm:auth'],
      areaIds: ['src'],
    });
  });

  it('renders a self-contained HTML artifact with slice controls', () => {
    const html = createGraphOverviewHtml(graph, {
      repoId: 'ontoindex',
      repoPath: '/repo',
      generatedAt: '2026-06-13T00:00:00.000Z',
      indexedAt: '2026-06-13T00:00:00.000Z',
      indexedHead: 'abc1234',
      summary: true,
    });

    expect(html).toContain('Interactive architecture graph for modules, execution flows, and functional areas.');
    expect(html).toContain('How To Read This Graph');
    expect(html).toContain('Reset Filters');
    expect(html).toContain('id="process-filter"');
    expect(html).toContain('id="process-search"');
    expect(html).toContain('id="community-filter"');
    expect(html).toContain('id="area-filter"');
    expect(html).toContain('id="anchor-filter"');
    expect(html).toContain('"repoId":"ontoindex"');
    expect(html).toContain('"summary":true');
    expect(html).toContain('Graph Overview');
  });
});
