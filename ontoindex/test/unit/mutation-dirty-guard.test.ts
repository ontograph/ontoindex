import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';
import {
  getOverlaySnapshot,
  resetOverlaySnapshotCache,
} from '../../src/mcp/local/backend-overlay.js';
import { guardMutationRange, moveSymbol } from '../../src/mcp/local/backend-move-symbol.js';
import { extractFunction } from '../../src/mcp/local/backend-extract-function.js';
import {
  extractFunctionByUid,
  moveSymbolByUid,
  replaceSymbol,
  updateSymbolBody,
} from '../../src/mcp/local/backend-symbol-mutations.js';

vi.mock('../../src/mcp/local/backend-symbol-resolution.js', () => ({
  resolveSymbolCandidates: vi.fn(),
}));

const original =
  'export function first() {\n  return 1;\n}\n\nexport function second() {\n  return 2;\n}\n';
const prefix = '// added one\n// added two\n// added three\n';
const uid = 'Function:src/a.ts:first';
const initialize = vi.fn().mockResolvedValue(undefined);
const operations = ['move', 'extract', 'update', 'delete', 'replace'] as const;
type Operation = (typeof operations)[number];

describe('mutation dirty guard', () => {
  let repo: { id: string; repoPath: string; storagePath: string };
  let source: string;
  let target: string;

  function resolve(operation: Operation, overlay = false) {
    vi.mocked(resolveSymbolCandidates).mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Function',
      symbol: {
        id: uid,
        name: 'first',
        type: 'Function',
        filePath:
          operation === 'update' || operation === 'delete'
            ? path.relative(repo.repoPath, source)
            : 'src/a.ts',
        startLine: overlay ? 3 : 0,
        endLine: overlay ? 5 : 2,
        ...(overlay ? { source: 'overlay' as const } : {}),
      },
    });
  }

  function mutate(operation: Operation, dry_run = false, confirm: unknown = true) {
    const params = { uid, dry_run, confirm: confirm as boolean };
    switch (operation) {
      case 'move':
        return moveSymbolByUid(repo, { ...params, target_file: 'src/target.ts' }, true, initialize);
      case 'extract':
        return extractFunctionByUid(repo, { ...params, new_name: 'helper' }, true, initialize);
      case 'update':
      case 'delete':
        return updateSymbolBody(
          repo,
          { ...params, new_body: operation === 'delete' ? '' : 'replacement' },
          true,
          initialize,
        );
      case 'replace':
        return replaceSymbol(repo, { ...params, new_body: 'replacement' }, true);
    }
  }

  async function expectContents(operation: Operation, overlay = false) {
    const leading = overlay ? prefix : '';
    const after = '\nexport function second() {\n  return 2;\n}\n';
    const first = 'export function first() {\n  return 1;\n}';
    let expectedSource: string;
    switch (operation) {
      case 'move':
        expectedSource = leading + after;
        break;
      case 'extract':
        expectedSource =
          leading +
          first.replace('export function first', 'function helper') +
          '\n\nexport function first() {\n  return helper.apply(undefined, arguments as unknown as Parameters<typeof helper>);\n}' +
          '\n' +
          after;
        break;
      case 'update':
        expectedSource = leading + 'replacement\n' + after;
        break;
      case 'delete':
        expectedSource = leading + '\n' + after;
        break;
      case 'replace':
        expectedSource = leading + first.replace('return 1;', 'replacement') + '\n' + after;
        break;
    }
    expect(await fs.readFile(source, 'utf8')).toBe(expectedSource);
    expect(await fs.readFile(target, 'utf8')).toBe(
      operation === 'move' ? '// target\n\n' + first + '\n' : '// target\n',
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetOverlaySnapshotCache();
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-mutation-'));
    repo = { id: repoPath, repoPath, storagePath: path.join(repoPath, '.ontoindex') };
    source = path.join(repoPath, 'src/a.ts');
    target = path.join(repoPath, 'src/target.ts');
    await fs.mkdir(path.dirname(source));
    await fs.writeFile(source, original);
    await fs.writeFile(target, '// target\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath });
    git('init', '-q');
    git('add', 'src');
    git(
      '-c',
      'user.name=Mutation Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'baseline',
    );
    // Model the committed graph's range without building a native index.
    resolve('move');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetOverlaySnapshotCache();
    await fs.rm(repo.repoPath, { recursive: true, force: true });
  });

  // Before the guard, this fixture moved prefix (lines 1..3) and left first()
  // behind. That wrong-write assertion passed against the unmodified modules.
  it.each(operations)(
    'refuses %s using the stale base range before any write',
    async (operation) => {
      await fs.writeFile(source, prefix + original);
      resolve(operation);
      const sourceBefore = await fs.readFile(source);
      const targetBefore = await fs.readFile(target);
      const write = vi.spyOn(fs, 'writeFile');
      await expect(mutate(operation)).rejects.toThrow(
        /Dirty file .*src[\\/]a\.ts:.*Commit\/stash.*ontoindex analyze.*retry/,
      );
      expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(source)).toEqual(sourceBefore);
      expect(await fs.readFile(target)).toEqual(targetBefore);
    },
  );

  it.each(operations)('warns on a dirty %s dry run without writing', async (operation) => {
    await fs.writeFile(source, prefix + original);
    resolve(operation);
    if (operation === 'extract') {
      const result = await mutate(operation, true);
      expect(result).toMatchObject({
        success: true,
        dry_run: true,
        warnings: [expect.stringMatching(/src[\\/]a\.ts:.*line range may be stale/)],
      });
    } else {
      const result = await mutate(operation, true);
      expect(result).toMatchObject({
        success: true,
        dry_run: true,
        warnings: [expect.stringMatching(/src[\\/]a\.ts:.*line range may be stale/)],
      });
    }
    expect(await fs.readFile(source, 'utf8')).toBe(prefix + original);
    expect(await fs.readFile(target, 'utf8')).toBe('// target\n');
  });

  it('rejects a dirty extract dry run when multiple top-level declarations have the same name', async () => {
    await fs.writeFile(source, prefix + original + '\nexport function first() {\n  return 3;\n}\n');
    resolve('extract');

    await expect(mutate('extract', true)).rejects.toThrow(
      'Stale range or unsupported function declaration',
    );
    expect(await fs.readFile(target, 'utf8')).toBe('// target\n');
  });

  // RT-22: guardMutationRange relativizes with the host `path`. A Windows absolute path
  // (C:\repo\src\a.ts) is only recognised as absolute on win32, where the windows-latest CI
  // job runs the host-native case above. On POSIX the same string is a relative name, so the
  // dirty-path lookup does not match. The production relative-path logic is reported, not changed.
  it('documents that a Windows absolute path is only resolved on a win32 host', () => {
    const repoRoot = 'C:\\work\\repo';
    const absolute = 'C:\\work\\repo\\src\\a.ts';
    expect(path.win32.relative(repoRoot, absolute)).toBe('src\\a.ts');
    expect(path.win32.isAbsolute(absolute)).toBe(true);
    expect(path.posix.isAbsolute(absolute)).toBe(false);
    expect(path.posix.relative(repoRoot, absolute).replace(/\\/g, '/')).not.toBe('src/a.ts');
  });

  it.each(['host-native absolute path', 'backslash-relative path'])(
    'detects a dirty file with a %s',
    async (pathKind) => {
      const filePath =
        pathKind === 'host-native absolute path'
          ? path.join(repo.repoPath, 'src', 'a.ts')
          : 'src\\a.ts';
      const snapshot = {
        usable: false,
        reason: 'test snapshot',
        dirtyPaths: new Set(['src/a.ts']),
        overlayPaths: new Set<string>(),
        tombstones: new Set<string>(),
      };
      vi.spyOn(
        await import('../../src/mcp/local/backend-overlay.js'),
        'getOverlaySnapshot',
      ).mockResolvedValue(snapshot);

      await expect(guardMutationRange(repo, { filePath }, false)).rejects.toThrow(
        /Dirty file .*src[\\/]a\.ts:.*line range may be stale/,
      );
      expect(getOverlaySnapshot).toHaveBeenCalledWith({
        id: repo.id,
        repoPath: repo.repoPath,
        storagePath: repo.storagePath,
      });
    },
  );

  it.each(operations)(
    'preserves clean %s dry-run results without a warnings field',
    async (operation) => {
      resolve(operation);
      const result = await mutate(operation, true);
      const expected = {
        move: { success: true, dry_run: true, uid, from: 'src/a.ts', to: 'src/target.ts' },
        extract: {
          success: true,
          dry_run: true,
          uid,
          new_name: 'helper',
          preview:
            'function helper() {\n  return 1;\n}\n\nexport function first() {\n  return helper.apply(undefined, arguments as unknown as Parameters<typeof helper>);\n}\n\nexport function second() {\n  return 2;\n}\n',
        },
        update: { success: true, dry_run: true, uid },
        delete: { success: true, dry_run: true, uid },
        replace: { success: true, dry_run: true, uid },
      };
      expect(result).toEqual(expected[operation]);
      expect(await fs.readFile(source, 'utf8')).toBe(original);
    },
  );

  it.each(operations)('allows clean %s writes with unchanged output', async (operation) => {
    resolve(operation);
    const result = await mutate(operation);
    expect(result).toMatchObject({ success: true, uid });
    expect(result).not.toHaveProperty('warnings');
    await expectContents(operation);
  });

  it.each([
    [-1, 2],
    [0.5, 2],
    [0, 99],
    [2, 1],
  ])(
    'refuses invalid line endpoints %s..%s before line-based writes',
    async (startLine, endLine) => {
      vi.mocked(resolveSymbolCandidates).mockResolvedValue({
        kind: 'ok',
        resolvedLabel: 'Function',
        symbol: {
          id: uid,
          name: 'first',
          type: 'Function',
          filePath: 'src/a.ts',
          startLine,
          endLine,
        },
      });
      const write = vi.spyOn(fs, 'writeFile');
      for (const operation of ['move', 'update'] as const) {
        await expect(mutate(operation)).rejects.toThrow('Invalid symbol line range');
      }
      expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(source, 'utf8')).toBe(original);
      expect(await fs.readFile(target, 'utf8')).toBe('// target\n');
    },
  );

  it.each([
    { content: 'function first() {\n  return (;\n}', error: 'Source has syntax errors' },
    {
      content: 'function first() {\n  return 1;\n} /* comment\ncontinued */',
      error: 'one complete top-level declaration',
    },
  ])('refuses unsafe live source before line-based writes: $error', async ({ content, error }) => {
    await fs.writeFile(source, content);
    vi.mocked(resolveSymbolCandidates).mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Function',
      symbol: {
        id: uid,
        name: 'first',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 0,
        endLine: 2,
        source: 'overlay',
      },
    });
    const write = vi.spyOn(fs, 'writeFile');
    for (const operation of ['move', 'update'] as const) {
      await expect(mutate(operation)).rejects.toThrow(error);
    }
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readFile(source, 'utf8')).toBe(content);
    expect(await fs.readFile(target, 'utf8')).toBe('// target\n');
  });

  it('refuses a separate-line export before an intervening comment', async () => {
    const content = 'export\n// declaration comment\nfunction first() {\n  return 1;\n}\n';
    await fs.writeFile(source, content);
    vi.mocked(resolveSymbolCandidates).mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Function',
      symbol: {
        id: uid,
        name: 'first',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 2,
        endLine: 4,
        source: 'overlay',
      },
    });
    const write = vi.spyOn(fs, 'writeFile');
    for (const operation of ['move', 'update'] as const) {
      await expect(mutate(operation)).rejects.toThrow('one complete top-level declaration');
    }
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readFile(source, 'utf8')).toBe(content);
    expect(await fs.readFile(target, 'utf8')).toBe('// target\n');
  });

  it.each(['false', 'true', 1])(
    'rejects non-boolean confirmation %j before a %s write',
    async (confirm) => {
      for (const operation of ['update', 'extract', 'move'] as const) {
        resolve(operation);
        const sourceBefore = await fs.readFile(source);
        const targetBefore = await fs.readFile(target);
        const write = vi.spyOn(fs, 'writeFile');
        await expect(mutate(operation, false, confirm)).rejects.toThrow(
          'Explicit confirmation required (set confirm: true)',
        );
        expect(write).not.toHaveBeenCalled();
        expect(await fs.readFile(source)).toEqual(sourceBefore);
        expect(await fs.readFile(target)).toEqual(targetBefore);
        write.mockRestore();
      }
    },
  );

  it.each(operations)('allows %s with a current overlay range', async (operation) => {
    await fs.writeFile(source, prefix + original);
    resolve(operation, true);
    const result = await mutate(operation);
    expect(result).toMatchObject({ success: true, uid });
    expect(result).not.toHaveProperty('warnings');
    await expectContents(operation, true);
  });

  it.each(operations)('does not warn on %s dry runs using an overlay range', async (operation) => {
    await fs.writeFile(source, prefix + original);
    resolve(operation, true);
    expect(await mutate(operation, true)).not.toHaveProperty('warnings');
    expect(await fs.readFile(source, 'utf8')).toBe(prefix + original);
  });

  it.each(['move', 'extract'] as const)(
    'guards the direct %s implementation too',
    async (operation) => {
      await fs.writeFile(source, prefix + original);
      resolve(operation);
      const params = { uid, dry_run: false, confirm: true };
      await expect(
        operation === 'move'
          ? moveSymbol(repo, { ...params, target_file: 'src/target.ts' })
          : extractFunction(repo, { ...params, new_name: 'helper' }),
      ).rejects.toThrow(/line range may be stale/);
      expect(await fs.readFile(source, 'utf8')).toBe(prefix + original);
    },
  );

  it('does not create a missing move target when the source range is stale', async () => {
    await fs.writeFile(source, prefix + original);
    await fs.unlink(target);
    await expect(mutate('move')).rejects.toThrow(/line range may be stale/);
    expect(await fs.readFile(source, 'utf8')).toBe(prefix + original);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an outside symlink target before changing the source', async () => {
    const outside = path.join(path.dirname(repo.repoPath), 'mutation-outside-target.ts');
    await fs.writeFile(outside, 'outside\n');
    await fs.symlink(outside, path.join(repo.repoPath, 'src', 'escape.ts'));
    resolve('move');
    const before = await fs.readFile(source);
    await expect(
      moveSymbol(repo, {
        uid,
        target_file: 'src/escape.ts',
        dry_run: false,
        confirm: true,
      }),
    ).rejects.toThrow(/escapes repository/);
    expect(await fs.readFile(source)).toEqual(before);
    await fs.rm(outside, { force: true });
  });

  it('rejects an outside symlink source before updating it', async () => {
    const outside = path.join(path.dirname(repo.repoPath), 'mutation-outside-source.ts');
    await fs.writeFile(outside, original);
    await fs.rm(source);
    await fs.symlink(outside, source);
    resolve('update', true);
    await expect(mutate('update')).rejects.toThrow(/escapes repository/);
    expect(await fs.readFile(outside, 'utf8')).toBe(original);
    await fs.rm(outside, { force: true });
  });

  it('updates a symbol when the process cwd differs from the repository', async () => {
    resolve('update');
    const cwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      await expect(mutate('update')).resolves.toMatchObject({
        success: true,
        filePath: 'src/a.ts',
      });
    } finally {
      process.chdir(cwd);
    }
    await expectContents('update');
  });

  it('leaves source unchanged when the move target cannot be read', async () => {
    const targetDir = path.join(repo.repoPath, 'src', 'target-dir');
    await fs.mkdir(targetDir);
    await fs.rm(target);
    await fs.symlink(targetDir, target);
    const before = await fs.readFile(source);
    await expect(mutate('move')).rejects.toThrow();
    expect(await fs.readFile(source)).toEqual(before);
    await fs.rm(target, { force: true });
  });

  it('leaves source unchanged when the move target parent is missing', async () => {
    const before = await fs.readFile(source);
    await expect(
      moveSymbol(repo, {
        uid,
        target_file: 'src/missing/target.ts',
        dry_run: false,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(source)).toEqual(before);
  });

  it('restores the target when writing the source fails', async () => {
    const targetBefore = await fs.readFile(target);
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile')
      .mockImplementationOnce((...args) => Reflect.apply(writeFile, undefined, args))
      .mockRejectedValueOnce(Object.assign(new Error('source write failed'), { code: 'EACCES' }));
    await expect(mutate('move')).rejects.toThrow('source write failed');
    expect(await fs.readFile(source, 'utf8')).toBe(original);
    expect(await fs.readFile(target)).toEqual(targetBefore);
  });

  it('restores both files after a partial source write', async () => {
    const targetBefore = await fs.readFile(target);
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile')
      .mockImplementationOnce((...args) => Reflect.apply(writeFile, undefined, args))
      .mockImplementationOnce(async () => {
        await writeFile(source, 'partial', 'utf8');
        throw new Error('partial source write');
      });
    await expect(mutate('move')).rejects.toThrow('partial source write');
    expect(await fs.readFile(source, 'utf8')).toBe(original);
    expect(await fs.readFile(target)).toEqual(targetBefore);
  });

  it('rejects a move when source and target resolve to the same file', async () => {
    await expect(
      moveSymbol(repo, {
        uid,
        target_file: 'src/a.ts',
        dry_run: false,
        confirm: true,
      }),
    ).rejects.toThrow(/same file/);
    expect(await fs.readFile(source, 'utf8')).toBe(original);
  });

  it('keeps compatibility for a handle without storagePath', async () => {
    await fs.writeFile(source, prefix + original);
    const { storagePath: _storagePath, ...legacyRepo } = repo;
    expect(await moveSymbol(legacyRepo, { uid, target_file: 'src/target.ts' })).toEqual({
      success: true,
      dry_run: true,
      uid,
      from: 'src/a.ts',
      to: 'src/target.ts',
    });
  });

  it('keeps the server and confirmation gates on writes', async () => {
    const params = { uid, target_file: 'src/target.ts', dry_run: false, confirm: true };
    await expect(moveSymbolByUid(repo, params, false, initialize)).rejects.toThrow(
      /Write operations are disabled/,
    );
    await expect(
      moveSymbolByUid(repo, { ...params, confirm: false }, true, initialize),
    ).rejects.toThrow(/Explicit confirmation required/);
    expect(await fs.readFile(source, 'utf8')).toBe(original);
  });
});
