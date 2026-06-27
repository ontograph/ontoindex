import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoManagerMocks = vi.hoisted(() => ({
  getStoragePaths: vi.fn((repoPath: string) => ({
    storagePath: `${repoPath}/.ontoindex`,
    lbugPath: `${repoPath}/.ontoindex/lbug`,
    metaPath: `${repoPath}/.ontoindex/meta.json`,
  })),
  loadMeta: vi.fn().mockResolvedValue({
    repoPath: '.',
    indexedAt: '2026-06-27T00:00:00.000Z',
    lastCommit: 'abc123def456',
  }),
}));

const gitMocks = vi.hoisted(() => ({
  getGitRoot: vi.fn().mockReturnValue('/repo'),
  isGitRepo: vi.fn().mockReturnValue(true),
  getCurrentCommit: vi.fn().mockReturnValue('abc123def456'),
}));

const poolMocks = vi.hoisted(() => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  closeLbug: vi.fn().mockResolvedValue(undefined),
}));

const auditReportMocks = vi.hoisted(() => ({
  runAuditReport: vi.fn(),
  formatAuditReport: vi.fn().mockReturnValue('# report\n'),
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const diagnoseMocks = vi.hoisted(() => ({
  gnDiagnose: vi.fn().mockResolvedValue({
    support: {
      lbugStore: {
        path: '/repo/.ontoindex/lbug',
        exists: true,
        sizeBytes: 2048,
        modifiedAt: '2026-06-27T12:00:00.000Z',
        walPresent: false,
        lockPresent: false,
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
      status: 'stale',
      repairCommand: 'gn_audit_replay({session: "session-123"})',
    },
  }),
}));

vi.mock('../../src/storage/repo-manager.js', () => repoManagerMocks);
vi.mock('../../src/storage/git.js', () => gitMocks);
vi.mock('../../src/core/lbug/pool-adapter.js', () => poolMocks);
vi.mock('../../src/mcp/local/backend-audit-report.js', () => auditReportMocks);
vi.mock('fs/promises', () => fsMocks);
vi.mock('../../src/mcp/super/diagnose.js', () => diagnoseMocks);

import { auditCommand, collectAuditFailureSupportLines } from '../../src/cli/audit.js';

describe('audit command support hints', () => {
  const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    repoManagerMocks.loadMeta.mockResolvedValue({
      repoPath: '.',
      indexedAt: '2026-06-27T00:00:00.000Z',
      lastCommit: 'abc123def456',
    });
    gitMocks.getGitRoot.mockReturnValue('/repo');
    gitMocks.isGitRepo.mockReturnValue(true);
    poolMocks.initLbug.mockResolvedValue(undefined);
    poolMocks.closeLbug.mockResolvedValue(undefined);
    auditReportMocks.formatAuditReport.mockReturnValue('# report\n');
    diagnoseMocks.gnDiagnose.mockResolvedValue({
      support: {
        lbugStore: {
          path: '/repo/.ontoindex/lbug',
          exists: true,
          sizeBytes: 2048,
          modifiedAt: '2026-06-27T12:00:00.000Z',
          walPresent: false,
          lockPresent: false,
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
        status: 'stale',
        repairCommand: 'gn_audit_replay({session: "session-123"})',
      },
    });
    process.exitCode = undefined;
  });

  it('collects bounded support lines from diagnose', async () => {
    await expect(collectAuditFailureSupportLines('/repo')).resolves.toEqual([
      'Ladybug store: present (2.0 KB, modified 2026-06-27T12:00:00.000Z)',
      'Ladybug sidecars: wal absent, lock absent',
      'Ladybug extensions: fts available, vector missing',
      'Ladybug timeout: native getAll 30000ms',
      'Ladybug extension hint: /tmp/extensions',
      'Audit replay: gn_audit_replay({session: "session-123"})',
    ]);
  });

  it('prints support hints when audit report generation fails', async () => {
    auditReportMocks.runAuditReport.mockRejectedValue(new Error('CREATE_FTS_INDEX timed out'));

    await auditCommand();

    expect(mockError.mock.calls.map(([line]) => String(line))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Error: CREATE_FTS_INDEX timed out'),
        '  Support hints:',
        '  - Ladybug store: present (2.0 KB, modified 2026-06-27T12:00:00.000Z)',
        '  - Ladybug sidecars: wal absent, lock absent',
        '  - Ladybug extensions: fts available, vector missing',
        '  - Ladybug timeout: native getAll 30000ms',
        '  - Ladybug extension hint: /tmp/extensions',
        '  - Audit replay: gn_audit_replay({session: "session-123"})',
      ]),
    );
    expect(poolMocks.closeLbug).toHaveBeenCalledWith('repo');
    expect(process.exitCode).toBe(1);
  });

  it('keeps failure output minimal when diagnose support lookup fails', async () => {
    auditReportMocks.runAuditReport.mockRejectedValue(new Error('CREATE_FTS_INDEX timed out'));
    diagnoseMocks.gnDiagnose.mockRejectedValue(new Error('diagnose unavailable'));

    await auditCommand();

    expect(mockError.mock.calls.map(([line]) => String(line))).not.toContain('  Support hints:');
    expect(process.exitCode).toBe(1);
  });
});
