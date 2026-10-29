import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { attachWorkspaceSearchWarning } from '../../src/mcp/shared/workspace-search-warning.js';
import {
  dirtyWorkspaceSearchWarning,
  resolveTargetContext,
} from '../../src/mcp/shared/target-context.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import type { TargetContextDirtyWorkspace } from '../../src/mcp/shared/target-context.js';

vi.mock('../../src/mcp/shared/target-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/shared/target-context.js')>()),
  resolveTargetContext: vi.fn(),
}));
vi.mock('../../src/mcp/super/dispatch.js', () => ({
  dispatchSuper: vi.fn(async () => ({ warnings: ['existing'], definitions: [] })),
}));
vi.mock('../../src/mcp/super/names.js', () => ({
  withPreparedSuperRead: vi.fn(async (_name, _args, _repo, _backend, _options, run) => run()),
}));

function workspace(
  overrides: Partial<TargetContextDirtyWorkspace> = {},
): TargetContextDirtyWorkspace {
  return {
    state: 'unknown-untracked',
    fileCount: 8,
    sourceFileCount: 8,
    stagedSourceFileCount: 0,
    unstagedSourceFileCount: 0,
    untrackedSourceFileCount: 8,
    unknownGraphCoverageCount: 8,
    dirtyPaths: Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(resolveTargetContext).mockResolvedValue({ dirtyWorkspace: workspace() } as never);
});

describe('facade dirty search warnings', () => {
  it.each([
    ['inspect', 'explore'],
    ['inspect', 'related'],
  ] as const)(
    'warns once for %s/%s even when results contain no dirty files',
    async (tool, action) => {
      const backend = {
        resolveRepo: vi.fn(async () => ({ id: 'fixture', repoPath: '/tmp/fixture' })),
        callTool: vi.fn(async () => ({ warnings: ['existing'], definitions: [] })),
      } as unknown as LocalBackend;
      const result = (await dispatchFacade(
        tool,
        action,
        { repo: 'fixture', query: 'f7.ts' },
        backend,
      )) as any;
      expect(result.warnings).toEqual([
        'existing',
        '8 untracked source file(s) are not in the graph; results may omit changes: src/f7.ts, src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, +3 more',
      ]);
      expect(resolveTargetContext).toHaveBeenCalledTimes(1);
      vi.mocked(resolveTargetContext).mockClear();
    },
  );

  it('keeps clean workspace warnings unchanged', async () => {
    vi.mocked(resolveTargetContext).mockResolvedValue({
      dirtyWorkspace: workspace({ sourceFileCount: 0 }),
    } as never);
    const original = { warnings: ['existing'] };
    expect(await attachWorkspaceSearchWarning(original, {}, 'fixture')).toBe(original);
  });

  it('keeps admitted workspace graph results unchanged', async () => {
    vi.mocked(resolveTargetContext).mockResolvedValue({
      dirtyWorkspace: workspace(),
      graphAuthority: { state: 'authoritative', capability: 'workspace-graph' },
    } as never);
    const original = { warnings: [] };
    expect(await attachWorkspaceSearchWarning(original, {}, 'fixture')).toBe(original);
  });

  it('prioritizes full paths and preserves the capped summary remainder', () => {
    expect(
      dirtyWorkspaceSearchWarning(
        workspace({
          fileCount: 60,
          sourceFileCount: 60,
          untrackedSourceFileCount: 60,
          dirtyPathsTruncated: true,
        }),
        'inspect `src/f6.ts`',
      ),
    ).toBe(
      '60 untracked source file(s) are not in the graph; results may omit changes: src/f6.ts, src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, +55 more',
    );
  });

  it('warns about unstaged tracked source changes', () => {
    expect(
      dirtyWorkspaceSearchWarning(
        workspace({
          state: 'dirty-file',
          sourceFileCount: 1,
          fileCount: 1,
          unstagedSourceFileCount: 1,
          untrackedSourceFileCount: 0,
          dirtyPaths: ['src/a.ts'],
        }),
        'a.ts',
      ),
    ).toBe('1 dirty source file(s) are not in the graph; results may omit changes: src/a.ts');
  });

  it('omits non-source paths from the preview and remainder', () => {
    expect(
      dirtyWorkspaceSearchWarning(
        workspace({
          sourceFileCount: 1,
          untrackedSourceFileCount: 1,
          fileCount: 2,
          dirtyPaths: ['notes.txt', 'src/a.ts'],
        }),
        'notes.txt',
      ),
    ).toBe('1 untracked source file(s) are not in the graph; results may omit changes: src/a.ts');
  });
});
