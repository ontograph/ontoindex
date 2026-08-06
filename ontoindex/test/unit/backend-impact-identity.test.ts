import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { lbugMocks, resolveMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeParameterized: vi.fn(),
    executeQuery: vi.fn(),
  },
  resolveMocks: {
    resolveSymbolCandidates: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/mcp/local/backend-symbol-resolution.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...resolveMocks };
});

describe('backend impact identity ergonomics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lbugMocks.executeParameterized.mockResolvedValue([]);
    lbugMocks.executeQuery.mockResolvedValue([]);
  });

  it('accepts nodeId as a target_uid alias', async () => {
    resolveMocks.resolveSymbolCandidates.mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Function',
      symbol: {
        id: 'Function:src/auth.ts:login',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
        startLine: 10,
        endLine: 20,
      },
    });

    const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
    const result = await runImpact(
      { id: 'repo', name: 'repo' },
      {
        target: 'login',
        nodeId: 'Function:src/auth.ts:login',
        direction: 'upstream',
      },
    );

    expect(resolveMocks.resolveSymbolCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: 'Function:src/auth.ts:login', name: 'login' }),
      expect.anything(),
    );
    expect(result).toMatchObject({
      target: {
        id: 'Function:src/auth.ts:login',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
      },
    });
  });

  it('normalizes ambiguous candidates with nodeId and retry calls', async () => {
    resolveMocks.resolveSymbolCandidates.mockResolvedValue({
      kind: 'ambiguous',
      candidates: [
        {
          id: 'Function:src/auth.ts:login',
          name: 'login',
          type: 'Function',
          filePath: 'src/auth.ts',
          startLine: 10,
          endLine: 20,
          score: 0.91,
        },
      ],
    });

    const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
    const result = await runImpact(
      { id: 'repo', name: 'repo' },
      {
        target: 'login',
        direction: 'upstream',
      },
    );

    expect(result).toMatchObject({
      status: 'ambiguous',
      candidates: [
        {
          nodeId: 'Function:src/auth.ts:login',
          uid: 'Function:src/auth.ts:login',
          displayName: 'login',
          name: 'login',
          kind: 'Function',
          suggestedNextCalls: expect.arrayContaining([
            'impact({ action: "symbol", repo: "repo", target_uid: "Function:src/auth.ts:login", target: "login" })',
          ]),
        },
      ],
    });
  });

  it('returns source-only identity for an untracked file without claiming graph impact', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-impact-source-only-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoPath });
      await fs.mkdir(path.join(repoPath, 'src'));
      await fs.writeFile(
        path.join(repoPath, 'src/new-feature.ts'),
        'export function initializeEditableView(): void {}\n',
      );
      resolveMocks.resolveSymbolCandidates.mockResolvedValue({ kind: 'not_found' });

      const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
      const result = await runImpact(
        { id: 'repo', name: 'repo', repoPath },
        {
          target: 'initializeEditableView',
          file_path: 'src/new-feature.ts',
          direction: 'upstream',
        },
      );

      expect(result).toMatchObject({
        risk: 'UNKNOWN',
        impactedCount: 0,
        resolutionStatus: 'source-only',
        graphImpactAvailable: false,
        resolutionReason: 'untracked-file-not-indexed',
        sourceIdentity: {
          name: 'initializeEditableView',
          kind: 'Function',
          filePath: 'src/new-feature.ts',
          sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(lbugMocks.executeParameterized).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('uses current dirty source before a matching graph symbol', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-impact-dirty-source-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
      await fs.mkdir(path.join(repoPath, 'src'));
      const filePath = path.join(repoPath, 'src/feature.ts');
      await fs.writeFile(filePath, 'export function initializeEditableView(): void {}\n');
      execFileSync('git', ['add', 'src/feature.ts'], { cwd: repoPath });
      execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoPath });
      await fs.writeFile(
        filePath,
        'export function initializeEditableView(): number { return 1; }\n',
      );
      resolveMocks.resolveSymbolCandidates.mockResolvedValue({
        kind: 'ok',
        resolvedLabel: 'Function',
        symbol: {
          id: 'Function:src/feature.ts:initializeEditableView',
          name: 'initializeEditableView',
          type: 'Function',
          filePath: 'src/feature.ts',
        },
      });

      const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
      const result = await runImpact(
        { id: 'repo', name: 'repo', repoPath },
        {
          target: 'initializeEditableView',
          file_path: 'src/feature.ts',
          direction: 'upstream',
        },
      );

      expect(result).toMatchObject({
        resolutionStatus: 'source-only',
        resolutionReason: 'dirty-file-not-indexed',
        graphImpactAvailable: false,
      });
      expect(resolveMocks.resolveSymbolCandidates).not.toHaveBeenCalled();
      expect(lbugMocks.executeParameterized).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it.each(['target_uid', 'nodeId'] as const)(
    'uses current dirty source when %s is supplied',
    async (selector) => {
      const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-impact-dirty-uid-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repoPath });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
        await fs.mkdir(path.join(repoPath, 'src'));
        const filePath = path.join(repoPath, 'src/feature.ts');
        await fs.writeFile(filePath, 'export function initializeEditableView(): void {}\n');
        execFileSync('git', ['add', 'src/feature.ts'], { cwd: repoPath });
        execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoPath });
        await fs.writeFile(
          filePath,
          'export function initializeEditableView(): number { return 1; }\n',
        );

        const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
        const result = await runImpact(
          { id: 'repo', name: 'repo', repoPath },
          {
            target: 'initializeEditableView',
            file_path: 'src/feature.ts',
            [selector]: 'Function:src/feature.ts:initializeEditableView',
            direction: 'upstream',
          },
        );

        expect(result).toMatchObject({
          resolutionStatus: 'source-only',
          resolutionReason: 'dirty-file-not-indexed',
          graphImpactAvailable: false,
        });
        expect(resolveMocks.resolveSymbolCandidates).not.toHaveBeenCalled();
        expect(lbugMocks.executeParameterized).not.toHaveBeenCalled();
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    },
  );

  it('resolves dirty source by nodeId when the display target is empty', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-impact-dirty-node-id-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoPath });
      await fs.mkdir(path.join(repoPath, 'src'));
      await fs.writeFile(
        path.join(repoPath, 'src/feature.ts'),
        'export function initializeEditableView(): void {}\n',
      );

      const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
      const result = await runImpact(
        { id: 'repo', name: 'repo', repoPath },
        {
          target: '',
          nodeId: 'Function:src/feature.ts:initializeEditableView',
          file_path: 'src/feature.ts',
          direction: 'upstream',
        },
      );

      expect(result).toMatchObject({
        resolutionStatus: 'source-only',
        resolutionReason: 'untracked-file-not-indexed',
        sourceIdentity: { name: 'initializeEditableView' },
      });
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
