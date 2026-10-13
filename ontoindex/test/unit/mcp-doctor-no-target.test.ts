import { describe, expect, it, vi } from 'vitest';
import { createMcpDoctorReport, formatMcpDoctorText } from '../../src/cli/mcp-doctor.js';
import type { DiagnoseReport } from '../../src/mcp/super/diagnose.js';
vi.mock('../../src/storage/git.js', () => ({ getGitRoot: () => null }));
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

async function probe(
  status: 'ok' | 'not-found' | 'ambiguous',
  options = {},
  env: NodeJS.ProcessEnv = {},
) {
  const diagnose: DiagnoseReport = {
    ...baseDiagnose,
    targetContext: {
      version: 1,
      status,
      targetRef: 'HEAD',
      dirtyWorktree: null,
      changedSinceIndex: null,
      snapshotMode: 'unknown',
      qualityMode: 'fast',
      embeddings: { status: 'unknown' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
      availableRepos: [{ key: 'registered', path: '/registered' }],
    },
    misconfiguration:
      status === 'ok'
        ? { status: 'ok' }
        : {
            status: 'fail',
            reason: 'mcp-service-target-mismatch',
            recommendedCommand: "ontoindex mcp --project '/absolute/path/to/project'",
          },
    degradedContext:
      status === 'ok'
        ? baseDiagnose.degradedContext
        : {
            status: 'degraded',
            confidence: 'reduced',
            affectedAreas: ['repo-targeting'],
            reasons: ['mcp-service-target-mismatch', `target-context-${status}`],
          },
  };
  const report = await createMcpDoctorReport(options, {
    cwd: () => '/unregistered',
    env,
    diagnose: async () => diagnose,
    processLiveness: async () => ({ status: 'ok' }),
    setupHealth: async () => ({ status: 'ok', issues: [] }),
  });
  return { report, diagnose };
}
describe('doctor implicit repository target', () => {
  it('reports an implicit missing target as degraded with an actionable selector', async () => {
    const { report, diagnose } = await probe('not-found');
    expect(report.verdict).toBe('DEGRADED');
    expect(report.diagnose.degradedContext.reasons).toContain('no-target-repo');
    expect(report.diagnose.degradedContext.reasons).not.toContain('mcp-service-target-mismatch');
    expect(report.diagnose.misconfiguration.status).toBe('ok');
    expect(report.nextCommand).toBe('ontoindex mcp-doctor --repo <name>');
    expect(formatMcpDoctorText(report)).toContain(
      'current directory is not an indexed repository; run from an indexed repo or pass --repo <name|path>',
    );
    expect(formatMcpDoctorText(report)).toContain('registered');
    expect(formatMcpDoctorText(report)).not.toContain('/absolute/path/to/project');
    expect(diagnose.misconfiguration.status).toBe('fail');
  });
  it.each([
    [{ repo: 'missing' }, {}],
    [{ projectCwd: '/missing' }, {}],
    [{}, { ONTOINDEX_MCP_PROJECT_CWD: '/missing' }],
  ])('keeps explicit missing targets misconfigured', async (options, env) => {
    expect((await probe('not-found', options, env)).report.verdict).toBe('MISCONFIGURED');
  });
  it('keeps ambiguous targets misconfigured', async () => {
    expect((await probe('ambiguous')).report.verdict).toBe('MISCONFIGURED');
  });
  it('keeps resolved targets ready', async () => {
    const { report, diagnose } = await probe('ok');
    expect(report.verdict).toBe('READY');
    expect(report.diagnose).toBe(diagnose);
  });
});
