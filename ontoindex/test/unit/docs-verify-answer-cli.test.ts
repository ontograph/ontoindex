import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'fs/promises';
import { verifyAnswerCommand } from '../../src/cli/docs.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import * as git from '../../src/storage/git.js';
import { closeLbug, initLbug } from '../../src/core/lbug/pool-adapter.js';
import { verifyAnswer } from '../../src/core/ingestion/enrichment/markdown-answer-verify.js';
import type { AnswerGroundingResult } from '../../src/core/ingestion/enrichment/markdown-answer-grounding.js';

vi.mock('../../src/storage/repo-manager.js');
vi.mock('../../src/storage/git.js');
vi.mock('../../src/core/lbug/pool-adapter.js');
vi.mock('node:child_process');
vi.mock('fs/promises');
vi.mock('node:fs/promises');
vi.mock('../../src/core/ingestion/enrichment/markdown-answer-verify.js', () => ({
  verifyAnswer: vi.fn(),
}));

const repoPath = '/test/repo';
const file = '/test/answer.md';
const answer = 'See `src/cli/docs.ts` and `verifyAnswerCommand`.';
const report = {
  status: 'grounded',
  grounded: [{ kind: 'path', text: 'src/cli/docs.ts' }],
  ungrounded: [],
  unverifiable: [],
  truncated: false,
  symbolCheck: 'ok',
  pathsKnown: 2,
} satisfies AnswerGroundingResult & { symbolCheck: 'ok'; pathsKnown: number };

describe('docs verify-answer CLI', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockLog: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('mockExit');
    });
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(git.isGitRepo).mockReturnValue(true);
    vi.mocked(git.getGitRoot).mockReturnValue(repoPath);
    vi.mocked(repoManager.findRepo).mockResolvedValue({
      repoPath,
      meta: {
        repoPath,
        indexedAt: '2026-01-01T00:00:00.000Z',
        lastCommit: 'abc1234',
        stats: { nodes: 10, relationships: 20, processes: 3 },
      },
    });
    vi.mocked(repoManager.getStoragePaths).mockReturnValue({
      storagePath: `${repoPath}/.ontoindex`,
      lbugPath: '',
      metaPath: '',
    });
    vi.mocked(repoManager.resolveActiveLbugPath).mockResolvedValue(`${repoPath}/.ontoindex/lbug`);
    vi.mocked(readFile).mockResolvedValue(answer);
    vi.mocked(execFileSync).mockReturnValue('src/cli/docs.ts\nREADME.md\n');
    vi.mocked(initLbug).mockResolvedValue(undefined);
    vi.mocked(closeLbug).mockResolvedValue(undefined);
    vi.mocked(verifyAnswer).mockResolvedValue(report);
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockLog.mockRestore();
    mockError.mockRestore();
  });

  it('AV2-A: prints the mocked report fields and warnings as JSON', async () => {
    await verifyAnswerCommand(file, { json: true, repo: repoPath });

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockLog.mock.calls[0][0])).toEqual({ ...report, warnings: [] });
    expect(readFile).toHaveBeenCalledWith(file, 'utf8');
    expect(execFileSync).toHaveBeenCalledWith('git', ['ls-files'], {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(verifyAnswer).toHaveBeenCalledWith({
      answer,
      paths: ['src/cli/docs.ts', 'README.md'],
      provider: expect.objectContaining({ findSymbols: expect.any(Function) }),
    });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('AV2-B: exits 1 for an ungrounded report only with strict enabled', async () => {
    vi.mocked(verifyAnswer).mockResolvedValue({
      ...report,
      status: 'ungrounded',
      ungrounded: [{ kind: 'path', text: 'missing.ts' }],
    });

    await verifyAnswerCommand(file, { json: true });
    expect(mockExit).not.toHaveBeenCalled();

    await expect(verifyAnswerCommand(file, { json: true, strict: true })).rejects.toThrow(
      'mockExit',
    );
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('AV2-C: reports graph failure with no provider and a warning', async () => {
    vi.mocked(initLbug).mockRejectedValue(new Error('graph offline'));
    const skippedReport = { ...report, symbolCheck: 'skipped' as const };
    vi.mocked(verifyAnswer).mockResolvedValue(skippedReport);

    await verifyAnswerCommand(file, { json: true });

    expect(verifyAnswer).toHaveBeenCalledWith({
      answer,
      paths: ['src/cli/docs.ts', 'README.md'],
      provider: undefined,
    });
    expect(JSON.parse(mockLog.mock.calls[0][0])).toEqual({
      ...skippedReport,
      warnings: ['graph unavailable: graph offline; symbol check skipped'],
    });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('AV2-D: prints Cannot read and exits 1 for an unreadable answer', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('permission denied'));

    await expect(verifyAnswerCommand(file, { json: true })).rejects.toThrow('mockExit');

    expect(mockError).toHaveBeenCalledWith(`Cannot read ${file}: permission denied`);
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(verifyAnswer).not.toHaveBeenCalled();
    expect(initLbug).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'AV2-E: closes the opened graph once (verification rejects: %s)',
    async (rejects) => {
      const failure = new Error('verification failed');
      vi.mocked(verifyAnswer).mockImplementation(async () => {
        expect(closeLbug).not.toHaveBeenCalled();
        if (rejects) throw failure;
        return report;
      });

      const command = verifyAnswerCommand(file, { json: true });
      if (rejects) await expect(command).rejects.toThrow(failure);
      else await command;

      expect(initLbug).toHaveBeenCalledWith(repoPath, `${repoPath}/.ontoindex/lbug`);
      expect(closeLbug).toHaveBeenCalledTimes(1);
      expect(closeLbug).toHaveBeenCalledWith(repoPath);
    },
  );
});
