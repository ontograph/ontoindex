import { describe, expect, it, vi } from 'vitest';
import { dispatchFacade, type FacadeTool } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import {
  getHiddenStartupProfileToolNames,
  getPublicToolRegistry,
  getRegisteredSuperToolNames,
} from '../../src/mcp/shared/tool-registry.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

const { dispatchSuperMock } = vi.hoisted(() => ({ dispatchSuperMock: vi.fn() }));
vi.mock('../../src/mcp/super/dispatch.js', () => ({ dispatchSuper: dispatchSuperMock }));

type Route = readonly [FacadeTool, readonly string[], string, 'super' | 'backend' | 'docs'];

// Independent compatibility oracle: do not derive these rows from dispatch or definitions.
const ROUTES: readonly Route[] = [
  ['inspect', ['explore'], 'gn_explore', 'super'],
  ['inspect', ['module'], 'gn_explain_module', 'super'],
  ['inspect', ['related'], 'gn_find_related', 'super'],
  ['inspect', ['propose_location'], 'gn_propose_location', 'super'],
  ['inspect', ['graph_walk'], 'gn_graph_walk', 'super'],
  ['audit', ['safe_edit_check'], 'gn_safe_edit_check', 'super'],
  ['audit', ['can_delete'], 'gn_can_delete', 'super'],
  ['audit', ['pre_commit_audit'], 'gn_pre_commit_audit', 'super'],
  ['audit', ['review_diff'], 'gn_review_diff', 'super'],
  ['audit', ['ingest'], 'gn_audit_ingest', 'super'],
  ['audit', ['verify'], 'gn_audit_verify', 'super'],
  ['audit', ['fix_history'], 'gn_fix_history', 'super'],
  ['audit', ['bundle'], 'gn_audit_bundle', 'super'],
  ['audit', ['lint'], 'gn_audit_lint', 'super'],
  ['audit', ['logic'], 'gn_audit_logic', 'super'],
  ['audit', ['dedupe'], 'gn_audit_dedupe', 'super'],
  ['audit', ['dispatch_prompt'], 'gn_dispatch_prompt', 'super'],
  ['audit', ['tombstone_create'], 'gn_audit_tombstone_create', 'super'],
  ['audit', ['session_start'], 'gn_audit_session_start', 'super'],
  ['audit', ['session_verify'], 'gn_audit_session_verify', 'super'],
  ['audit', ['session_dedupe'], 'gn_audit_session_dedupe', 'super'],
  ['audit', ['session_bundle'], 'gn_audit_session_bundle', 'super'],
  ['audit', ['session_dispatch'], 'gn_audit_session_dispatch', 'super'],
  ['audit', ['session_review_worker'], 'gn_audit_session_review_worker', 'super'],
  ['audit', ['session_lock'], 'gn_audit_session_lock', 'super'],
  ['audit', ['pr_marker_scan'], 'gn_audit_pr_marker_scan', 'super'],
  ['audit', ['diff'], 'gn_audit_diff', 'super'],
  ['audit', ['replay'], 'gn_audit_replay', 'super'],
  ['audit', ['export'], 'gn_audit_export', 'super'],
  ['audit', ['scope_guard'], 'gn_scope_guard', 'super'],
  ['audit', ['bundle_conflicts'], 'gn_bundle_conflicts', 'super'],
  ['audit', ['verify_diff'], 'gn_verify_diff', 'super'],
  ['audit', ['test_gap'], 'gn_test_gap', 'super'],
  ['audit', ['worker_scope_review'], 'gn_worker_scope_review', 'super'],
  ['audit', ['resource_trace'], 'gn_resource_trace', 'super'],
  ['audit', ['path_verify'], 'gn_path_verify', 'super'],
  ['audit', ['test_suggestions'], 'gn_test_suggestions', 'super'],
  ['audit', ['trace_boundary'], 'gn_trace_boundary', 'super'],
  ['audit', ['extract_fsm'], 'gn_extract_fsm', 'super'],
  ['audit', ['error_topology'], 'gn_error_topology', 'super'],
  ['audit', ['concurrency'], 'gn_concurrency_audit', 'super'],
  ['audit', ['pressure'], 'gn_pressure_impact', 'super'],
  ['audit', ['taint'], 'gn_taint_trace', 'super'],
  ['audit', ['abi'], 'gn_abi_diff', 'super'],
  ['audit', ['simulate_fault'], 'gn_simulate_fault', 'super'],
  ['refactor', ['safe_refactor'], 'gn_safe_refactor', 'super'],
  ['manage', ['ensure_fresh'], 'gn_ensure_fresh', 'super'],
  ['manage', ['analyze_job'], 'gn_analyze_job', 'super'],
  ['manage', ['quality_mode'], 'gn_quality_mode', 'backend'],
  ['manage', ['diagnose'], 'gn_diagnose', 'backend'],
  ['impact', ['diff_impact'], 'gn_diff_impact', 'super'],
  ['discover', ['help'], 'gn_help', 'backend'],
  ['discover', ['tool_contract'], 'gn_tool_contract', 'backend'],
  ['docs', ['trace', 'drift', 'context', 'readiness'], 'gn_docs', 'docs'],
];

const NON_GN_ACTIONS = [
  ['discover', ['repos', 'routes', 'tools', 'packs', 'groups', 'sync']],
  ['search', ['semantic', 'cypher', 'repomap']],
  ['inspect', ['context', 'evidence', 'shape', 'ipc']],
  ['impact', ['symbol', 'batch', 'route', 'diff']],
  [
    'audit',
    [
      'report',
      'dead_code',
      'tech_debt',
      'hotspots',
      'cycles',
      'coupling',
      'violations',
      'coverage',
      'migration',
      'drift',
      'build',
      'graph_diff',
      'requirements',
      'patterns',
      'rerun',
    ],
  ],
  ['refactor', ['rename', 'replace', 'sandbox']],
  ['manage', ['session', 'route_map']],
] as const;

const routePairs = ROUTES.flatMap(([tool, actions]) =>
  actions.map((action) => `${tool}/${action}`),
);
const nonGnPairs = NON_GN_ACTIONS.flatMap(([tool, actions]) =>
  actions.map((action) => `${tool}/${action}`),
);

// The same routing oracle covers the shared docs backend and nested operation selectors.
const cases = ROUTES.flatMap(([tool, actions, legacy, kind]) =>
  actions.flatMap((action) => {
    const selectors =
      action === 'graph_walk'
        ? ['start', 'step', 'status']
        : action === 'session_lock'
          ? [undefined, 'create', 'load', 'validate']
          : action === 'analyze_job'
            ? [undefined, 'status', 'cancel']
            : [undefined];
    return selectors.map((selector) => ({ tool, action, legacy, kind, selector }));
  }),
);

describe('facade legacy route parity', () => {
  it('accounts for exactly all 54 registered legacy definitions once', () => {
    const names = ROUTES.map(([, , legacy]) => legacy).sort();
    expect(ROUTES).toHaveLength(54);
    expect(new Set(names).size).toBe(54);
    expect(names).toEqual(getRegisteredSuperToolNames().sort());
    expect(names).toEqual(ONTOINDEX_SUPER_TOOLS.map((tool) => tool.name).sort());
    expect(ROUTES.filter(([, , , kind]) => kind === 'super')).toHaveLength(49);
    expect(ROUTES.filter(([, , , kind]) => kind === 'backend')).toHaveLength(4);
    expect(ROUTES.filter(([, , , kind]) => kind === 'docs')).toHaveLength(1);
  });

  it('keeps core-hidden compatibility names callable in the full public registry', () => {
    const names = ROUTES.map(([, , legacy]) => legacy).sort();
    const core = getPublicToolRegistry({ startupProfile: 'core', includeFacades: false });
    const full = getPublicToolRegistry({ startupProfile: 'public-full', includeFacades: false });
    expect(full.map((entry) => entry.name).sort()).toEqual(names);
    expect(
      getHiddenStartupProfileToolNames({ startupProfile: 'core', includeFacades: false }),
    ).toEqual(names.filter((name) => !core.some((entry) => entry.name === name)));
  });

  it('partitions every declared facade action into an oracle route or explicit non-legacy action', () => {
    const declared = ONTOINDEX_FACADE_TOOLS.flatMap((tool) =>
      (tool.inputSchema.properties.action.enum as string[]).map(
        (action) => `${tool.name}/${action}`,
      ),
    );
    expect(nonGnPairs).toHaveLength(37);
    expect(new Set(routePairs).size).toBe(routePairs.length);
    expect(new Set(nonGnPairs).size).toBe(nonGnPairs.length);
    expect(routePairs.filter((pair) => nonGnPairs.includes(pair))).toEqual([]);
    expect([...routePairs, ...nonGnPairs].sort()).toEqual(declared.sort());
  });

  it.each(cases)(
    '$tool/$action ($selector) reaches $legacy via $kind',
    async ({ tool, action, legacy, kind, selector }) => {
      dispatchSuperMock.mockReset().mockResolvedValue({ ok: true });
      const backend = {
        resolveRepo: vi.fn().mockResolvedValue({ id: 'fixture', repoPath: '/tmp/fixture' }),
        ensureRepoInitialized: vi.fn(async () => {}),
        withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
        withCommittedGraphNotice: vi.fn(async (result) => result),
        callTool: vi.fn(function (this: unknown) {
          return this;
        }),
      };
      const args: Record<string, unknown> = { repo: 'fixture', extra: { preserved: true } };
      if (kind !== 'docs') args.action = action;
      if (action === 'explore') args.query = 'selected';
      if (action === 'module') args.filePath = 'src/selected.ts';
      if (action === 'related' || action === 'safe_edit_check' || action === 'can_delete')
        args.symbol = 'selected';
      if (action === 'propose_location') args.intent = 'add selected behavior';
      if (action === 'safe_refactor')
        Object.assign(args, { intent: 'modify-body', symbol: 'selected', params: {} });
      if (action === 'quality_mode') args.level = 'balanced';
      if (action === 'graph_walk')
        Object.assign(args, {
          walk_action: selector,
          ...(selector === 'start' ? { seedSymbol: 'selected' } : { walkId: 'walk-1' }),
        });
      if (action === 'analyze_job')
        Object.assign(args, { jobId: 'job-1', ...(selector ? { job_action: selector } : {}) });
      if (action === 'session_lock' && selector) args.lock_action = selector;
      const original = structuredClone(args);
      const forwarded = structuredClone(args);
      if (action === 'graph_walk') {
        forwarded.action = selector;
        delete forwarded.walk_action;
      }
      if (action === 'analyze_job') {
        forwarded.action = selector ?? 'status';
        delete forwarded.job_action;
      }
      if (action === 'session_lock') {
        delete forwarded.lock_action;
        if (selector === undefined) delete forwarded.action;
        else forwarded.action = selector;
      }
      if (kind === 'docs') forwarded.action = action;

      await dispatchFacade(tool, action, args, backend as unknown as LocalBackend);

      if (kind !== 'super') {
        expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(
          kind === 'docs' ? 'docs' : legacy,
          forwarded,
        );
        expect(dispatchSuperMock).not.toHaveBeenCalled();
        expect(backend.resolveRepo).not.toHaveBeenCalled();
      } else {
        const expected: unknown[] = [legacy, forwarded, 'fixture'];
        // Logic uses the fifth argument; safe_refactor owns the fourth argument.
        if (action === 'logic') expected.push(undefined, { repoPath: '/tmp/fixture' });
        if (action === 'verify_diff' || action === 'test_gap')
          expected.push(undefined, undefined, backend);
        if (action === 'safe_refactor')
          expected.push({ repoPath: '/tmp/fixture', callTool: expect.any(Function) });
        expect(dispatchSuperMock).toHaveBeenCalledExactlyOnceWith(...expected);
        if (action === 'safe_refactor') {
          expect(dispatchSuperMock.mock.calls[0][3].callTool('sentinel', {})).toBe(backend);
        } else expect(backend.callTool).not.toHaveBeenCalled();
        if (action === 'ensure_fresh') expect(backend.resolveRepo).not.toHaveBeenCalled();
        else expect(backend.resolveRepo).toHaveBeenCalledExactlyOnceWith('fixture');
      }
      expect(args).toEqual(original);
    },
  );
});
