import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMcpDoctorReport,
  formatMcpDoctorText,
  type McpDoctorReport,
} from '../../src/cli/mcp-doctor.js';
import type { DiagnoseReport } from '../../src/mcp/super/diagnose.js';

const localBackendMock = vi.hoisted(() => ({
  ctor: vi.fn(),
  init: vi.fn(),
  callTool: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    constructor(options: unknown) {
      localBackendMock.ctor(options);
    }

    init = localBackendMock.init;

    callTool = localBackendMock.callTool;

    dispose = localBackendMock.dispose;
  },
}));

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
      enforcement: 'metadata-only',
    },
  },
  responseLimits: {
    mcpCypherLimitMax: 5000,
    processDetailStepLimit: 1000,
    httpMcpSessionCap: 32,
    truncationPolicy: 'bounded',
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

beforeEach(() => {
  localBackendMock.ctor.mockReset();
  localBackendMock.init.mockReset().mockResolvedValue(true);
  localBackendMock.callTool.mockReset();
  localBackendMock.dispose.mockReset().mockResolvedValue(undefined);
});

describe('mcp-doctor', () => {
  it('runs production symbol smoke checks when no injected smokeSymbol is provided', async () => {
    localBackendMock.callTool
      .mockResolvedValueOnce({
        status: 'found',
        symbol: { name: 'main', filePath: 'src/index.ts' },
      })
      .mockResolvedValueOnce({
        impactedCount: 1,
        target: { name: 'main' },
      });

    const report = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture', symbol: 'main' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          targetContext: {
            version: 1,
            status: 'ok',
            repoKey: 'fixture',
            repoLabel: 'fixture',
            repoPath: '/repo/fixture',
            targetRef: 'HEAD',
            dirtyWorktree: false,
            changedSinceIndex: false,
            snapshotMode: 'committed-head',
            qualityMode: 'fast',
            embeddings: { status: 'available', count: 1 },
            lsp: { status: 'unknown', reason: 'not-probed' },
            sidecar: { status: 'unknown', reason: 'not-probed' },
            policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
            warnings: [],
          },
        }),
      },
    );

    expect(report.verdict).toBe('READY');
    expect(report.symbolSmoke).toEqual({ status: 'ok' });
    expect(localBackendMock.ctor).toHaveBeenCalledWith({
      repoFilter: 'fixture',
      preferredProjectPath: '/repo/fixture',
    });
    expect(localBackendMock.callTool).toHaveBeenNthCalledWith(1, 'context', {
      repo: 'fixture',
      name: 'main',
      depth: 1,
      limit: 1,
    });
    expect(localBackendMock.callTool).toHaveBeenNthCalledWith(2, 'impact', {
      repo: 'fixture',
      target: 'main',
      direction: 'upstream',
      maxDepth: 1,
      includeTests: false,
    });
  });

  it('returns DEGRADED for a correct but reduced-quality target', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'fixture' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          degradedContext: {
            status: 'degraded',
            reasons: ['embeddings-unavailable'],
            affectedAreas: ['retrieval'],
            confidence: 'reduced',
          },
        }),
      },
    );

    expect(report.verdict).toBe('DEGRADED');
    expect(formatMcpDoctorText(report)).toContain('Degraded reasons: embeddings-unavailable');
  });

  it('marks production smoke failures as DEGRADED when diagnose is otherwise healthy', async () => {
    localBackendMock.callTool.mockResolvedValueOnce({
      error: 'symbol not found',
      status: 'error',
    });

    const report = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture', symbol: 'main' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          targetContext: {
            version: 1,
            status: 'ok',
            repoKey: 'fixture',
            repoLabel: 'fixture',
            repoPath: '/repo/fixture',
            targetRef: 'HEAD',
            dirtyWorktree: false,
            changedSinceIndex: false,
            snapshotMode: 'committed-head',
            qualityMode: 'fast',
            embeddings: { status: 'available', count: 1 },
            lsp: { status: 'unknown', reason: 'not-probed' },
            sidecar: { status: 'unknown', reason: 'not-probed' },
            policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
            warnings: [],
          },
        }),
      },
    );

    expect(report.verdict).toBe('DEGRADED');
    expect(report.symbolSmoke).toEqual({ status: 'failed', reason: 'context-smoke:symbol not found' });
  });

  it('returns MISCONFIGURED for P1 repo-target mismatch', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'ontoindex' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          degradedContext: {
            status: 'degraded',
            reasons: ['mcp-service-target-mismatch'],
            affectedAreas: ['repo-targeting'],
            confidence: 'reduced',
          },
          misconfiguration: {
            status: 'fail',
            severity: 'P1',
            reason: 'mcp-service-target-mismatch',
            requestedRepo: 'ontoindex',
            activeRepoLabel: 'codex',
            activeRepoPath: '/repo/codex',
            recommendedCommand: 'ontoindex mcp --project /repo/codex --repo ontoindex',
          },
        }),
      },
    );

    expect(report.verdict).toBe('MISCONFIGURED');
    expect(report.nextCommand).toContain('ontoindex mcp --project /repo/codex --repo ontoindex');
  });

  it('quotes fallback restart paths that contain spaces', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'fixture' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          misconfiguration: {
            status: 'fail',
            severity: 'P1',
            reason: 'mcp-service-target-mismatch',
            requestedRepo: 'fixture',
            activeRepoLabel: 'fixture',
            activeRepoPath: '/repo/space path',
          },
        }),
      },
    );

    expect(report.nextCommand).toBe(
      "ontoindex mcp --project '/repo/space path' --repo 'fixture'",
    );
  });

  it('keeps JSON output stable enough for issue reports', async () => {
    const report: McpDoctorReport = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture', symbol: 'main' },
      {
        diagnose: async () => baseDiagnose,
        smokeSymbol: async () => {},
      },
    );

    expect(localBackendMock.ctor).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({
      version: 1,
      verdict: 'READY',
      repoSelector: 'fixture',
      projectCwd: '/repo/fixture',
      symbol: 'main',
      symbolSmoke: { status: 'ok' },
    });
  });
});
