import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { createMcpDoctorReport } from '../../src/cli/mcp-doctor.js';
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

async function probe(lines: string[], cwdByPid: Record<number, string | undefined> = {}) {
  return createMcpDoctorReport(
    { projectCwd: '/repo/target' },
    {
      diagnose: async () => baseDiagnose,
      setupHealth: async () => ({ status: 'ok', issues: [] }),
      spawnPs: vi.fn(() => fakePsProcess(lines.join('')) as never),
      readProcessCwd: async (pid: number) => cwdByPid[pid],
    },
  );
}
function explicit(pid: number, project = '/repo/target') {
  return `${pid} node /opt/ontoindex/ontoindex/dist/cli/index.js mcp --project ${project}\n`;
}
function cwdBound(pid: number) {
  return `${pid} node /opt/ontoindex/ontoindex/dist/cli/index.js mcp\n`;
}

describe('doctor explicit project bindings', () => {
  it('prefers an explicit target among cwd-bound matching servers', async () => {
    const report = await probe([explicit(100), ...[101, 102, 103, 104, 105].map(cwdBound)], {
      101: '/repo/target',
      102: '/repo/target',
      103: '/repo/target',
      104: '/repo/target',
      105: '/repo/target',
    });
    expect(report.processLiveness).toMatchObject({
      status: 'ok',
      pid: 100,
      reason: '6 servers bound to /repo/target (1 by explicit --project, 5 by working directory)',
    });
  });
  it('accepts multiple explicit target bindings', async () => {
    const report = await probe([explicit(100), explicit(101)]);
    expect(report.processLiveness).toMatchObject({
      status: 'ok',
      pid: 100,
      reason: '2 servers bound to /repo/target (2 by explicit --project, 0 by working directory)',
    });
  });
  it('does not treat an unverified process as an additional target match', async () => {
    const report = await probe([explicit(100), cwdBound(101)], { 101: undefined });
    expect(report.processLiveness).toMatchObject({ status: 'ok', pid: 100 });
  });
  it('accepts a visible explicit match when the enumeration is full of foreign servers', async () => {
    const report = await probe([
      ...Array.from({ length: 21 }, (_, i) => explicit(200 + i, `/repo/foreign${i}`)),
      explicit(100),
    ]);
    expect(report.processLiveness).toMatchObject({ status: 'ok', pid: 100 });
  });
  it('preserves ambiguity for foreign candidates with no target match', async () => {
    const report = await probe([
      explicit(200, '/repo/foreign'),
      explicit(201, '/repo/elsewhere'),
      explicit(202, '/repo/other'),
    ]);
    expect(report.processLiveness).toMatchObject({
      status: 'ambiguous',
      reason: '3 running MCP processes, none bound to /repo/target',
    });
  });
});
