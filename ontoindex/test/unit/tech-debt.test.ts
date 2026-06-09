import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { runTechDebt } from '../../src/mcp/local/backend-tech-debt.js';

const execMock = executeParameterized as unknown as ReturnType<typeof vi.fn>;

describe('tech_debt', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-tech-debt-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@x'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });

    async function touch(relFiles: Record<string, string>, msg: string) {
      for (const [rel, body] of Object.entries(relFiles)) {
        const abs = path.join(tmpDir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, body, 'utf8');
      }
      execFileSync('git', ['add', '.'], { cwd: tmpDir });
      execFileSync('git', ['commit', '-m', msg], {
        cwd: tmpDir,
        env: { ...process.env, GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@x' },
      });
    }
    // 3 commits to src/hot.ts (high churn), 1 to src/cool.ts.
    await touch({ 'src/hot.ts': '1' }, 'c1');
    await touch({ 'src/hot.ts': '2' }, 'c2');
    await touch({ 'src/hot.ts': '3', 'src/cool.ts': '1' }, 'c3');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    execMock.mockReset();
  });

  function makeRepo(): any {
    return { id: 'tech-debt-test', name: 'tech-debt-test', repoPath: tmpDir };
  }

  it('ranks symbols by composite score and respects limit', async () => {
    // 1st call: loadStructuralSymbols. 2nd call: callerCountsByName.
    execMock.mockImplementation(async (_repoId, query) => {
      if (query.includes('parameterCount')) {
        return [
          {
            name: 'hotFn',
            type: 'Function',
            filePath: 'src/hot.ts',
            startLine: 1,
            endLine: 120, // 120 lines
            parameterCount: 6,
          },
          {
            name: 'coolFn',
            type: 'Function',
            filePath: 'src/cool.ts',
            startLine: 1,
            endLine: 40,
            parameterCount: 2,
          },
        ];
      }
      // caller counts
      return [
        { name: 'hotFn', filePath: 'src/hot.ts', callerCount: 10 },
        { name: 'coolFn', filePath: 'src/cool.ts', callerCount: 1 },
      ];
    });

    const result = await runTechDebt(makeRepo(), { since: '10 years' });
    expect(result.status).toBe('success');
    expect(result.symbol_count).toBe(2);
    expect(result.symbols[0].name).toBe('hotFn');
    expect(result.symbols[0].lineCount).toBe(120);
    expect(result.symbols[0].callerCount).toBe(10);
    expect(result.symbols[0].commits).toBe(3);
    expect(result.symbols[0].score).toBeGreaterThan(result.symbols[1].score);

    const limited = await runTechDebt(makeRepo(), { since: '10 years', limit: 1 });
    expect(limited.symbols).toHaveLength(1);
    expect(limited.symbol_count).toBe(2);
  });

  it('filters by min_lines', async () => {
    execMock.mockImplementation(async (_repoId, query) => {
      if (query.includes('parameterCount')) {
        // 15-line symbol is skipped when min_lines=50, 80-line symbol survives.
        // We still return both to simulate that the DB-side filter works too,
        // but our assertion is that the caller saw the min_lines clamp.
        return [
          {
            name: 'big',
            type: 'Function',
            filePath: 'src/hot.ts',
            startLine: 1,
            endLine: 80,
            parameterCount: 1,
          },
        ];
      }
      return [];
    });
    const result = await runTechDebt(makeRepo(), { since: '10 years', min_lines: 50 });
    expect(result.min_lines).toBe(50);
    expect(result.symbol_count).toBe(1);
    expect(result.symbols[0].lineCount).toBe(80);
    expect(execMock).toHaveBeenCalledWith(
      'tech-debt-test',
      expect.stringContaining('MATCH (n:Function)'),
      expect.objectContaining({ minLines: 50 }),
    );
    expect(execMock.mock.calls[0]?.[1]).toContain('MATCH (n:Method)');
    expect(execMock.mock.calls[0]?.[1]).toContain('MATCH (n:Constructor)');
    expect(execMock.mock.calls[0]?.[1]).not.toContain('labels(n)[0]');
  });

  it('degrades gracefully when DB is unreachable', async () => {
    execMock.mockRejectedValue(new Error('pool not initialised'));
    const result = await runTechDebt(makeRepo(), { since: '10 years' });
    // Both queries fail, so the symbol list is empty — but the tool itself
    // must still report success with a 0-count list, not crash.
    expect(result.status).toBe('success');
    expect(result.symbol_count).toBe(0);
  });

  it('falls back when parameterCount is unavailable in the graph schema', async () => {
    execMock.mockImplementation(async (_repoId, query) => {
      if (query.includes('count(*) AS callerCount')) return [];
      if (query.includes('n.parameterCount')) {
        throw new Error(
          'Prepare failed: Binder exception: Cannot find property parameterCount for n.',
        );
      }
      if (query.includes('0 AS parameterCount')) {
        return [
          {
            name: 'fallbackFn',
            type: 'Function',
            filePath: 'src/hot.ts',
            startLine: 1,
            endLine: 20,
            parameterCount: 0,
          },
        ];
      }
      return [];
    });

    const result = await runTechDebt(makeRepo(), { since: '10 years' });
    expect(result.status).toBe('success');
    expect(result.symbol_count).toBe(1);
    expect(result.symbols[0].name).toBe('fallbackFn');
    expect(result.symbols[0].parameterCount).toBe(0);
    const queries = execMock.mock.calls.map((call) => String(call[1]));
    expect(queries.some((query) => query.includes('n.parameterCount'))).toBe(true);
    expect(queries.some((query) => query.includes('0 AS parameterCount'))).toBe(true);
  });

  it('honors default since + limit when no params passed', async () => {
    execMock.mockImplementation(async (_repoId, query) => {
      if (query.includes('parameterCount')) return [];
      return [];
    });
    const result = await runTechDebt(makeRepo(), {});
    expect(result.since).toBe('6 months');
    expect(result.min_lines).toBe(10);
  });

  it('produces zero churn count when repo has no git history in window', async () => {
    execMock.mockImplementation(async (_repoId, query) => {
      if (query.includes('parameterCount')) {
        return [
          {
            name: 'hotFn',
            type: 'Function',
            filePath: 'src/hot.ts',
            startLine: 1,
            endLine: 120,
            parameterCount: 6,
          },
        ];
      }
      return [];
    });
    // Pick a window in the future — no commits since then.
    const result = await runTechDebt(makeRepo(), { since: '2099-01-01' });
    expect(result.status).toBe('success');
    expect(result.symbols[0].commits).toBe(0);
  });
});
