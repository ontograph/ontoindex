import { describe, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { dispatchSuper, type SuperTool } from '../../src/mcp/super/dispatch.js';

vi.mock('../../src/mcp/super/audit-ingest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/super/audit-ingest.js')>()),
  resolveAuditRepoHandle: async () => ({ id: 'fixture', repoPath: '/tmp/inline-a-fixture' }),
}));

const backend = {
  resolveRepo: async () => ({ id: 'fixture', repoPath: '/tmp/inline-a-fixture' }),
} as unknown as LocalBackend;

const routes = {
  pr_marker_scan: 'gn_audit_pr_marker_scan',
  trace_boundary: 'gn_trace_boundary',
  test_suggestions: 'gn_test_suggestions',
} as const satisfies Record<string, SuperTool>;
type Route = keyof typeof routes;

function withoutRepoIdentity(value: Record<string, unknown>): Record<string, unknown> {
  const { repoLabel, repoPath, ...report } = value;
  expect({ repoLabel, repoPath }).toEqual({
    repoLabel: 'fixture',
    repoPath: '/tmp/inline-a-fixture',
  });
  return report;
}

async function parity(action: Route, args: Record<string, unknown>) {
  const direct = await dispatchSuper(routes[action], args, 'fixture');
  const facade = await dispatchFacade('audit', action, args, backend);
  expect(withoutRepoIdentity(facade as Record<string, unknown>)).toEqual(direct);
  return direct as Record<string, unknown>;
}

async function errorParity(action: Route, args: Record<string, unknown>, message: string) {
  const direct = await dispatchSuper(routes[action], args, 'fixture').catch(
    (error: unknown) => error,
  );
  const facade = await dispatchFacade('audit', action, args, backend).catch(
    (error: unknown) => error,
  );
  expect(direct).toBeInstanceOf(Error);
  expect(facade).toBeInstanceOf(Error);
  const directError = direct as Error;
  const facadeError = facade as Error;
  expect(directError.message).toBe(message);
  expect(facadeError.message).toBe(message);
  expect(facadeError.name).toBe(directError.name);
  expect(withoutRepoIdentity({ ...facadeError })).toEqual({ ...directError });
}

const boundary = {
  resource: 'fd:inline-a',
  start: 'inline-a-sender',
  end: 'inline-a-receiver',
  facts: [
    {
      kind: 'send',
      mechanism: 'SCM_RIGHTS',
      resourceInstanceId: 'fd:inline-a',
      processId: 'inline-a-sender',
      handle: 3,
    },
    {
      kind: 'receive',
      mechanism: 'SCM_RIGHTS',
      resourceInstanceId: 'fd:inline-a',
      processId: 'inline-a-receiver',
      handle: 7,
    },
  ],
};

describe('real inline audit handlers through facade and direct dispatch', () => {
  // normalizeFacadeArgs defines no aliases for these three audit routes;
  // sourceText/source, kind/mechanism and risk/claimPattern belong to the real handlers.
  describe('pr_marker_scan', () => {
    it('preserves inline TODO evidence and sourceText precedence over source', async () => {
      const report = await parity('pr_marker_scan', {
        path: 'inline-a.ts',
        sourceText: '// TODO: inline-a repair\nconst inlineA = 1;\n// clean',
        source: '// clean\nconst inlineA = 1;\n// clean',
        evidenceLine: 2,
      });
      expect(report).toMatchObject({
        action: 'audit-pr-marker-scan',
        suggestedStatus: 'HOLD',
        markers: [{ markerKind: 'TODO', line: 1 }],
        evidenceWindow: { before: 3, after: 3, startLine: 1, endLine: 3 },
      });
    });

    it('preserves zero windows and the source alias without including adjacent markers', async () => {
      const report = await parity('pr_marker_scan', {
        path: 'inline-a.ts',
        source: '// TODO: inline-a repair\nconst inlineA = 1;\n// FIXME: inline-a repair',
        evidenceLine: 2,
        windowBefore: 0,
        windowAfter: 0,
      });
      expect(report).toMatchObject({
        markers: [],
        evidenceWindow: { before: 0, after: 0, startLine: 2, endLine: 2 },
      });
    });

    it('rejects fractional evidence lines identically', async () => {
      await errorParity(
        'pr_marker_scan',
        { source: '// TODO', evidenceLine: 1.5 },
        'evidenceLine must be a positive integer',
      );
    });

    it('rejects missing source and path identically before file access', async () => {
      await errorParity('pr_marker_scan', { evidenceLine: 1 }, 'path or sourceText is required');
    });
  });

  describe('trace_boundary', () => {
    it('preserves explicit resource and process identities with agreeing mechanism aliases', async () => {
      const report = await parity('trace_boundary', {
        ...boundary,
        kind: 'SCM_RIGHTS',
        mechanism: 'SCM_RIGHTS',
      });
      expect(report).toMatchObject({
        status: 'ok',
        segments: [
          {
            resourceInstanceId: 'fd:inline-a',
            senderProcessId: 'inline-a-sender',
            receiverProcessId: 'inline-a-receiver',
            senderHandle: 3,
            receiverHandle: 7,
            mechanism: 'SCM_RIGHTS',
          },
        ],
      });
    });

    it('rejects conflicting mechanism aliases identically', async () => {
      await errorParity(
        'trace_boundary',
        { ...boundary, kind: 'fork', mechanism: 'SCM_RIGHTS' },
        'kind and mechanism must identify the same boundary mechanism',
      );
    });

    it('rejects an invalid evidence line in a fact identically', async () => {
      await errorParity(
        'trace_boundary',
        {
          resource: boundary.resource,
          start: boundary.start,
          facts: [{ kind: 'send', line: 0 }],
        },
        'Fact line must be a positive integer',
      );
    });

    it('reports missing facts as unresolved without analyzing source', async () => {
      const report = await parity('trace_boundary', {
        resource: boundary.resource,
        start: boundary.start,
        source: 'private inline-a source',
      });
      expect(report).toMatchObject({
        status: 'unresolved',
        segments: [],
        warnings: [
          'Source text is not analyzed; boundary tracing consumes caller-supplied facts only.',
          'No boundary segments match the supplied facts and endpoint identities.',
        ],
        skipReasons: ['source-analysis-unavailable', 'no-matching-boundary-evidence'],
      });
      expect(JSON.stringify(report)).not.toContain('private inline-a source');
    });
  });

  describe('test_suggestions', () => {
    it('preserves supplied evidence and risk precedence over claimPattern', async () => {
      const report = await parity('test_suggestions', {
        symbol: 'InlineA::handoff',
        path: 'test/unused.test.ts',
        evidence: [{ testFile: 'test/inline-a.test.ts' }],
        risk: 'fd-handoff',
        claimPattern: 'ignored-risk',
      });
      expect(report.suggestions).toEqual([
        {
          file: 'test/inline-a.test.ts',
          case: 'test_InlineA_handoff_fd_handoff',
          target: 'InlineA::handoff',
          assertion: 'Assert the fd-handoff invariant remains true for InlineA::handoff.',
          required: false,
        },
      ]);
    });

    it.each([undefined, '  \t  '])(
      'keeps absent or whitespace-only path advisory (%j)',
      async (path) => {
        const report = await parity('test_suggestions', {
          symbol: 'InlineA::handoff',
          claimPattern: 'fd-handoff',
          ...(path === undefined ? {} : { path }),
        });
        expect(report).toMatchObject({
          suggestions: [{ file: null, case: 'test_InlineA_handoff_fd_handoff' }],
          warnings: [
            'Suggestions are advisory; supplied test paths and coverage are not independently verified.',
            'No test path supplied; provide path or evidence[].testFile to locate this advisory suggestion.',
          ],
          skipReasons: ['test file unavailable: no supplied test path'],
        });
      },
    );

    it('rejects a non-string path identically', async () => {
      await errorParity(
        'test_suggestions',
        { path: 1 },
        'Invalid arguments for gn_test_suggestions: path: expected string',
      );
    });

    it('rejects malformed evidence identically', async () => {
      await errorParity(
        'test_suggestions',
        { evidence: [1] },
        'Invalid arguments for gn_test_suggestions: evidence[0]: expected object',
      );
    });
  });
});
