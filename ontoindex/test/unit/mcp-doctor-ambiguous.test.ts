import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { createMcpDoctorReport, formatMcpDoctorText } from '../../src/cli/mcp-doctor.js';
import type { DiagnoseReport } from '../../src/mcp/super/diagnose.js';
vi.mock('../../src/storage/git.js', () => ({ getGitRoot: () => null }));
function fakePsProcess(output: string) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.stdout.end(output);
    child.emit('close', 0);
  });
  return child;
}
const baseDiagnose: DiagnoseReport = {
  version: 1,
  classification: {
    evidenceClasses: [],
    resourceContracts: {
      definitions: 0,
      templates: 0,
      total: 0,
      byEvidenceClass: {
        graph_evidence: 0,
        docs_evidence: 0,
        audit_evidence: 0,
        runtime_diagnostic: 0,
        advisory_memory: 0,
        unknown: 0,
      },
      suitability: { auditEligible: 0, docs: 0, diagnostics: 0 },
    },
  },
  setup: {
    mcp: {
      repoFilter: null,
      autoAnalyze: 'unset',
      startupTimeoutMs: 30000,
      startupTrace: false,
    },
    auth: {
      httpApiToken: 'generated-per-process',
      enforcement: 'api-bearer-enforced',
    },
  },
  responseLimits: {
    mcpCypherLimitMax: 5000,
    processDetailStepLimit: 1000,
    httpMcpSessionCap: 32,
    truncationPolicy: 'bounded',
  },
  responseBudgetHealth: {
    guardLimitBytes: 512 * 1024,
    recentOversizedTools: [],
    guardedPreviewAvailable: true,
  },
  runtimeContextSummary: {
    freshness: 'fresh',
    scopeConfidence: 'high',
    dirtyWorktree: false,
    dirtyFileCount: 0,
    embeddings: 'available',
    sidecar: 'unknown',
    qualityMode: 'fast',
    nextRepairCommands: [],
  },
  degradedContext: {
    status: 'ok',
    reasons: [],
    affectedAreas: [],
    confidence: 'full',
  },
  misconfiguration: { status: 'ok' },
  envVars: {},
  recommendations: [],
  warnings: [],
};

async function probe(paths: string[], env: NodeJS.ProcessEnv = {}, reason?: string) {
  return createMcpDoctorReport(
    { projectCwd: '/repo/target' },
    {
      env,
      diagnose: async () => ({
        ...baseDiagnose,
        degradedContext: { ...baseDiagnose.degradedContext, reasons: reason ? [reason] : [] },
      }),
      setupHealth: async () => ({ status: 'ok', issues: [] }),
      spawnPs: vi.fn(() =>
        fakePsProcess(
          paths
            .map(
              (p, i) =>
                `${i + 100} node /opt/ontoindex/ontoindex/dist/cli/index.js mcp --project ${p}\n`,
            )
            .join(''),
        ),
      ) as never,
      readProcessCwd: async () => undefined,
    },
  );
}
describe('doctor candidate ambiguity', () => {
  it.each([
    [[], 'missing', 'DEGRADED'],
    [['/repo/target'], 'ok', 'READY'],
    [['/repo/foreign'], 'mismatch', 'MISCONFIGURED'],
    [['/repo/a', '/repo/b', '/repo/c'], 'ambiguous', 'DEGRADED'],
    [['/repo/a', '/repo/b', '/repo/c', '/repo/target'], 'ok', 'READY'],
  ] as const)('classifies %j', async (paths, status, verdict) => {
    const report = await probe([...paths]);
    expect(report.processLiveness?.status).toBe(status);
    expect(report.verdict).toBe(verdict);
  });
  it('bounds foreign candidate evidence and prints the repair hint', async () => {
    const report = await probe(Array.from({ length: 8 }, (_, i) => `/repo/foreign${i}`));
    expect(report.processLiveness?.reason).toBe(
      '8 running MCP processes, none bound to /repo/target',
    );
    const candidates = (report.processLiveness as unknown as { candidates: unknown[] }).candidates;
    expect(candidates).toHaveLength(5);
    expect(candidates[0]).toEqual({ pid: 100, projectCwd: '/repo/foreign0' });
    expect(formatMcpDoctorText(report)).toContain('Process repair:');
  });
  it('treats enumeration cap as ambiguous even with a visible match', async () => {
    const report = await probe(['/repo/target', ...Array(255).fill('/repo/foreign')]);
    expect(report.processLiveness?.status).toBe('ambiguous');
    expect(report.verdict).toBe('DEGRADED');
  });
  it('keeps unverified bindings unavailable', async () => {
    expect((await probe(['relative'])).processLiveness?.reason).toBe(
      'process-project-binding-unverified',
    );
  });
});
describe('doctor embedding prerequisites', () => {
  it.each(['embeddings-unavailable', 'embeddings-missing'])(
    'explains %s without revealing values',
    async (reason) => {
      for (const env of [
        {},
        { ONTOINDEX_EMBEDDING_URL: 'secret-url' },
        { ONTOINDEX_EMBEDDING_URL: 'secret-url', ONTOINDEX_EMBEDDING_MODEL: 'secret-model' },
      ]) {
        const report = await probe(['/repo/target'], env, reason);
        expect(report.capabilityGaps?.[0].details).toEqual([
          `ONTOINDEX_EMBEDDING_URL: ${env.ONTOINDEX_EMBEDDING_URL ? 'set' : 'unset'}`,
          `ONTOINDEX_EMBEDDING_MODEL: ${env.ONTOINDEX_EMBEDDING_MODEL ? 'set' : 'unset'}`,
          'Vectors appear after ontoindex analyze --embeddings',
        ]);
        expect(JSON.stringify(report.capabilityGaps)).not.toContain('secret');
      }
    },
  );
});
