import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMcpDoctorReport, formatMcpDoctorText } from '../../src/cli/mcp-doctor.js';
import type { McpDoctorReport } from '../../src/cli/mcp-doctor.js';
import type { DiagnoseReport } from '../../src/mcp/super/diagnose.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

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
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'not-probed',
          repairCommand,
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

  it('reports matching MCP process liveness and keeps the report ready', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture' },
      {
        diagnose: async () => baseDiagnose,
        processLiveness: async (repo, projectCwd, repairCommand) => {
          expect(repo).toBe('fixture');
          expect(projectCwd).toBe('/repo/fixture');
          expect(repairCommand).toBe("ontoindex mcp --project '/repo/fixture' --repo 'fixture'");
          return {
            status: 'ok',
            pid: 4321,
            command: 'node /repo/ontoindex/dist/cli/index.js mcp --project /repo/fixture',
            projectCwd: '/repo/fixture',
            repairCommand,
          };
        },
      },
    );

    expect(report.verdict).toBe('READY');
    expect(report.processLiveness).toMatchObject({
      status: 'ok',
      pid: 4321,
      projectCwd: '/repo/fixture',
    });
    expect(formatMcpDoctorText(report)).toContain('Freshness: fresh');
    expect(formatMcpDoctorText(report)).toContain('Scope confidence: high');
    expect(formatMcpDoctorText(report)).toContain('Embeddings: available');
    expect(formatMcpDoctorText(report)).toContain('MCP process: ok (PID 4321)');
    expect(formatMcpDoctorText(report)).toContain('Response guard: 524288 bytes');
    expect(formatMcpDoctorText(report)).toContain('Guarded preview: available');
  });

  it('prints recent oversized tools from diagnose response-budget health', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          responseBudgetHealth: {
            ...baseDiagnose.responseBudgetHealth,
            recentOversizedTools: ['impact', 'audit'],
          },
        }),
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'not-probed',
          repairCommand,
        }),
      },
    );

    expect(formatMcpDoctorText(report)).toContain('Recent oversized tools: impact, audit');
  });

  it('marks missing process discovery as DEGRADED with repair guidance', async () => {
    const report = await createMcpDoctorReport(
      { projectCwd: '/repo/fixture' },
      {
        diagnose: async () => baseDiagnose,
        processLiveness: async (_repo, projectCwd, repairCommand) => ({
          status: 'missing',
          reason: `no running MCP process matched ${projectCwd}`,
          repairCommand,
        }),
      },
    );

    expect(report.verdict).toBe('DEGRADED');
    expect(report.nextCommand).toBe("ontoindex mcp --project '/repo/fixture'");
    expect(formatMcpDoctorText(report)).toContain('MCP process: missing');
    expect(formatMcpDoctorText(report)).toContain(
      "Process repair: ontoindex mcp --project '/repo/fixture'",
    );
  });

  it('treats a wrong-project process as MISCONFIGURED and degrades cleanly when discovery is unavailable', async () => {
    const mismatchReport = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture' },
      {
        diagnose: async () => baseDiagnose,
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'mismatch',
          reason: 'found running MCP process for /repo/other',
          pid: 999,
          command: 'node /repo/ontoindex/dist/cli/index.js mcp --project /repo/other',
          projectCwd: '/repo/other',
          repairCommand,
        }),
      },
    );

    expect(mismatchReport.verdict).toBe('MISCONFIGURED');
    expect(formatMcpDoctorText(mismatchReport)).toContain('MCP process: mismatch');
    expect(formatMcpDoctorText(mismatchReport)).toContain(
      'Observed command: node /repo/ontoindex/dist/cli/index.js mcp --project /repo/other',
    );

    const unavailableReport = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture' },
      {
        diagnose: async () => baseDiagnose,
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'process-discovery-unsupported-platform',
          repairCommand,
        }),
      },
    );

    expect(unavailableReport.verdict).toBe('READY');
    expect(formatMcpDoctorText(unavailableReport)).toContain(
      'MCP process: unavailable (process-discovery-unsupported-platform)',
    );
  });

  it('returns DEGRADED for a correct but reduced-quality target', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture' },
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
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'not-probed',
          repairCommand,
        }),
      },
    );

    expect(report.verdict).toBe('DEGRADED');
    expect(formatMcpDoctorText(report)).toContain('Degraded reasons: embeddings-unavailable');
  });

  it('prints audit freshness and MCP resource bridge diagnostics from gn_diagnose', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          degradedContext: {
            status: 'degraded',
            reasons: ['audit-stale'],
            affectedAreas: ['audit-freshness'],
            confidence: 'reduced',
          },
          auditFreshness: {
            status: 'stale',
            targetHead: 'deadbeefdeadbeef',
            currentHead: 'abc123def4567890',
            sessionId: 'session-123',
            repairCommand: 'gn_audit_replay({session: "session-123"})',
          },
          mcpResourceBridge: {
            exposed: true,
            exposedTo: ['Claude Code', 'Codex'],
          },
        }),
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'not-probed',
          repairCommand,
        }),
      },
    );

    const formatted = formatMcpDoctorText(report);
    expect(formatted).toContain('Audit freshness: stale (target deadbeefdead vs current abc123def456)');
    expect(formatted).toContain('Audit repair: gn_audit_replay({session: "session-123"})');
    expect(formatted).toContain('MCP resource bridge: exposed (Claude Code, Codex)');
  });

  it('reuses diagnose support diagnostics in text output', async () => {
    const report = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture' },
      {
        diagnose: async () => ({
          ...baseDiagnose,
          support: {
            lbugStore: {
              path: '/repo/fixture/.ontoindex/lbug',
              exists: true,
              sizeBytes: 2048,
              modifiedAt: '2026-06-27T12:00:00.000Z',
              walPresent: false,
              lockPresent: true,
            },
            ladybugExtensions: {
              hintDir: '/tmp/extensions',
              ftsAvailable: true,
              vectorAvailable: false,
            },
            timeoutHints: {
              nativeGetAllMs: 30000,
            },
          },
          auditFreshness: {
            status: 'dirty',
            targetHead: 'deadbeefdeadbeef',
            currentHead: 'abc123def4567890',
            repairCommand: 'gn_audit_replay({session: "session-123"})',
          },
        }),
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'not-probed',
          repairCommand,
        }),
      },
    );

    const formatted = formatMcpDoctorText(report);
    expect(formatted).toContain(
      'Ladybug store: present (2.0 KB, modified 2026-06-27T12:00:00.000Z)',
    );
    expect(formatted).toContain('Ladybug sidecars: wal absent, lock present');
    expect(formatted).toContain('Ladybug extensions: fts available, vector missing');
    expect(formatted).toContain('Ladybug timeout: native getAll 30000ms');
    expect(formatted).toContain('Ladybug extension hint: /tmp/extensions');
    expect(formatted).toContain('Audit replay: gn_audit_replay({session: "session-123"})');
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
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'not-probed',
          repairCommand,
        }),
      },
    );

    expect(report.verdict).toBe('DEGRADED');
    expect(report.symbolSmoke).toEqual({
      status: 'failed',
      reason: 'context-smoke:symbol not found',
    });
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

    expect(report.nextCommand).toBe("ontoindex mcp --project '/repo/space path' --repo 'fixture'");
  });

  it('flags stale hardcoded repo paths in setup files as MISCONFIGURED', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-mcp-doctor-home-'));
    const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-mcp-doctor-repo-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;

      await fs.mkdir(path.join(tempHome, '.claude', 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempHome, '.agents', 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempHome, '.cursor', 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempHome, '.config', 'opencode', 'skill'), { recursive: true });

      await fs.mkdir(path.join(tempRepo, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tempRepo, '.claude', 'settings.local.json'),
        JSON.stringify(
          {
            permissions: {
              allow: [
                'Bash(git -C /home/er77/_wrk/OntoIndex/.claude/worktrees/agent-a9b3bc4e05bbb89c1 status)',
              ],
            },
          },
          null,
          2,
        ),
      );

      const report = await createMcpDoctorReport(
        { repo: 'fixture', projectCwd: tempRepo },
        {
          cwd: () => tempRepo,
          diagnose: async () => baseDiagnose,
          processLiveness: async (_repo, _projectCwd, repairCommand) => ({
            status: 'unavailable',
            reason: 'not-probed',
            repairCommand,
          }),
        },
      );

      expect(report.verdict).toBe('MISCONFIGURED');
      expect(report.setupHealth?.status).toBe('misconfigured');
      expect(formatMcpDoctorText(report)).toContain(
        'Setup issue: .claude/settings.local.json contains stale repo path(s): /home/er77/_wrk/OntoIndex/.claude/worktrees/agent-a9b3bc4e05bbb89c1',
      );
      expect(formatMcpDoctorText(report)).toContain('Setup repair: ontoindex setup');
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempRepo, { recursive: true, force: true });
    }
  });

  it('flags missing generated skill directories as DEGRADED', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-mcp-doctor-home-'));
    const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-mcp-doctor-repo-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;

      await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });
      await fs.mkdir(path.join(tempHome, '.agents', 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempHome, '.cursor', 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempHome, '.config', 'opencode', 'skill'), {
        recursive: true,
      });

      const report = await createMcpDoctorReport(
        { repo: 'fixture', projectCwd: tempRepo },
        {
          cwd: () => tempRepo,
          diagnose: async () => baseDiagnose,
          processLiveness: async (_repo, _projectCwd, repairCommand) => ({
            status: 'unavailable',
            reason: 'not-probed',
            repairCommand,
          }),
        },
      );

      expect(report.verdict).toBe('DEGRADED');
      expect(report.setupHealth?.status).toBe('degraded');
      expect(formatMcpDoctorText(report)).toContain(
        `Setup issue: missing generated skill directory: ${path.join(
          tempHome,
          '.claude',
          'skills',
        )}`,
      );
      expect(formatMcpDoctorText(report)).toContain('Setup repair: ontoindex setup');
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempRepo, { recursive: true, force: true });
    }
  });

  it('keeps JSON output stable enough for issue reports', async () => {
    const report: McpDoctorReport = await createMcpDoctorReport(
      { repo: 'fixture', projectCwd: '/repo/fixture', symbol: 'main' },
      {
        diagnose: async () => baseDiagnose,
        smokeSymbol: async () => {},
        processLiveness: async (_repo, _projectCwd, repairCommand) => ({
          status: 'unavailable',
          reason: 'not-probed',
          repairCommand,
        }),
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
