import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMemoryFile } from '../../src/mcp/memory-parser.js';

const { mockAccess, mockMkdir, mockWriteFile, mockGetGitRoot, mockGetCurrentCommit, mockLoadMeta } =
  vi.hoisted(() => ({
    mockAccess: vi.fn(),
    mockMkdir: vi.fn(),
    mockWriteFile: vi.fn(),
    mockGetGitRoot: vi.fn(),
    mockGetCurrentCommit: vi.fn(),
    mockLoadMeta: vi.fn(),
  }));

vi.mock('fs/promises', () => ({
  default: {
    access: mockAccess,
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
  },
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: mockGetGitRoot,
  getCurrentCommit: mockGetCurrentCommit,
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: (repoPath: string) => ({
    storagePath: `${repoPath}/.ontoindex`,
    lbugPath: `${repoPath}/.ontoindex/lbug`,
    metaPath: `${repoPath}/.ontoindex/meta.json`,
  }),
  loadMeta: mockLoadMeta,
}));

const normalizeForAssert = (value: string) => value.replace(/^[A-Z]:/i, '').replace(/\\/g, '/');

describe('memoryCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'));
    process.exitCode = undefined;

    mockGetGitRoot.mockReturnValue('/repo');
    mockGetCurrentCommit.mockReturnValue('abc123def456');
    mockLoadMeta.mockResolvedValue({
      repoPath: '/repo',
      lastCommit: 'abc123def456',
      indexedAt: '2026-05-20T00:00:00.000Z',
    });
    mockAccess.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a valid advisory memory skeleton', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { memoryCommand } = await import('../../src/cli/memory.js');

    await memoryCommand('team-onboarding', {
      source: ['docs/adr/0023-serena-follow-up-memory-diagnostics-guardrails.md'],
    });

    expect(normalizeForAssert(mockMkdir.mock.calls[0]?.[0])).toBe('/repo/.ontoindex/memories');
    expect(mockMkdir.mock.calls[0]?.[1]).toEqual({ recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]repo[\\/]\.ontoindex[\\/]memories[\\/]team-onboarding\.md$/),
      expect.any(String),
      'utf8',
    );

    const content = mockWriteFile.mock.calls[0]?.[1];
    const parsed = parseMemoryFile('/repo/.ontoindex/memories/team-onboarding.md', content);
    expect(parsed.valid).toBe(true);
    expect(parsed.frontMatter.version).toBe(1);
    expect(parsed.frontMatter.repo).toBe('OntoIndex');
    expect(parsed.frontMatter.created_at).toBe('2026-05-20');
    expect(parsed.frontMatter.source_commit).toBe('abc123def456');
    expect(parsed.frontMatter.indexed_commit).toBe('abc123def456');
    expect(parsed.frontMatter.freshness).toBe('fresh');
    expect(parsed.frontMatter.kind).toBe('advisory');
    expect(parsed.frontMatter.not_audit_evidence).toBe(true);
    expect(parsed.frontMatter.sources).toEqual([
      'docs/adr/0023-serena-follow-up-memory-diagnostics-guardrails.md',
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Created advisory memory skeleton: .*[/\\]repo[/\\]\.ontoindex[/\\]memories[/\\]team-onboarding\.md$/,
      ),
    );
  });

  it('rejects unsafe memory names', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { memoryCommand } = await import('../../src/cli/memory.js');

    await memoryCommand('../secret', {
      source: ['docs/adr/0023-serena-follow-up-memory-diagnostics-guardrails.md'],
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      '  Memory name must be a direct child of .ontoindex/memories/\n',
    );
  });

  it('rejects overwrite by default', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAccess.mockResolvedValue(undefined);
    const { memoryCommand } = await import('../../src/cli/memory.js');

    await memoryCommand('team-onboarding', {
      source: ['docs/adr/0023-serena-follow-up-memory-diagnostics-guardrails.md'],
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith('  Memory already exists: team-onboarding.md');
  });

  it('allows explicit overwrite with --force semantics', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAccess.mockResolvedValue(undefined);
    mockLoadMeta.mockResolvedValue({
      repoPath: '/repo',
      lastCommit: 'def999',
      indexedAt: '2026-05-18T00:00:00.000Z',
    });
    const { memoryCommand } = await import('../../src/cli/memory.js');

    await memoryCommand('team-onboarding', {
      source: ['docs/adr/0023-serena-follow-up-memory-diagnostics-guardrails.md'],
      force: true,
    });

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const content = mockWriteFile.mock.calls[0]?.[1];
    const parsed = parseMemoryFile('/repo/.ontoindex/memories/team-onboarding.md', content);
    expect(parsed.frontMatter.freshness).toBe('stale-index');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Overwrote advisory memory skeleton: .*[/\\]repo[/\\]\.ontoindex[/\\]memories[/\\]team-onboarding\.md$/,
      ),
    );
  });

  it('rejects missing sources', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { memoryCommand } = await import('../../src/cli/memory.js');

    await memoryCommand('team-onboarding');

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith('  At least one --source <path-or-adr> value is required.');
  });

  it('uses unknown index metadata when the repo is not indexed', async () => {
    mockLoadMeta.mockResolvedValue(null);
    const { memoryCommand } = await import('../../src/cli/memory.js');

    await memoryCommand('unindexed-repo', {
      source: ['ADR 0023'],
    });

    const content = mockWriteFile.mock.calls[0]?.[1];
    const parsed = parseMemoryFile('/repo/.ontoindex/memories/unindexed-repo.md', content);
    expect(parsed.valid).toBe(true);
    expect(parsed.frontMatter.indexed_commit).toBe('unknown');
    expect(parsed.frontMatter.freshness).toBe('unknown');
  });
});
