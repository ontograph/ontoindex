import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';
import { resetOverlaySnapshotCache } from '../../src/mcp/local/backend-overlay.js';
import { moveSymbol } from '../../src/mcp/local/backend-move-symbol.js';
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
        // Body updates currently read filePath directly, unlike move/extract.
        filePath: operation === 'update' || operation === 'delete' ? source : 'src/a.ts',
        startLine: overlay ? 4 : 1,
        endLine: overlay ? 6 : 3,
        ...(overlay ? { source: 'overlay' as const } : {}),
      },
    });
  }

  function mutate(operation: Operation, dry_run = false) {
    const params = { uid, dry_run, confirm: true };
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
          first.replace('first', 'helper') +
          '\n\nexport function first() {\n  return helper(...arguments);\n}\n' +
          after;
        break;
      case 'update':
        expectedSource = leading + 'replacement\n' + after;
        break;
      case 'delete':
        expectedSource = leading + '\n' + after;
        break;
      case 'replace':
        // replaceSymbol is still a gate-only tool; updateSymbolBody owns writes.
        expectedSource = leading + original;
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
        /Dirty file .*src\/a\.ts:.*Commit\/stash.*ontoindex analyze.*retry/,
      );
      expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(source)).toEqual(sourceBefore);
      expect(await fs.readFile(target)).toEqual(targetBefore);
    },
  );

  it.each(operations)('warns on a dirty %s dry run without writing', async (operation) => {
    await fs.writeFile(source, prefix + original);
    resolve(operation);
    const result = await mutate(operation, true);
    expect(result).toMatchObject({
      success: true,
      dry_run: true,
      warnings: [expect.stringMatching(/src\/a\.ts:.*line range may be stale/)],
    });
    expect(await fs.readFile(source, 'utf8')).toBe(prefix + original);
    expect(await fs.readFile(target, 'utf8')).toBe('// target\n');
  });

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
          preview: 'Would extract first as helper to src/a.ts',
        },
        update: { success: true, dry_run: true, uid },
        delete: { success: true, dry_run: true, uid },
        replace: { success: true, dry_run: true, uid },
      };
      expect(result).toEqual(expected[operation]);
      await expectContents('replace');
    },
  );

  it.each(operations)('allows clean %s writes with unchanged output', async (operation) => {
    resolve(operation);
    const result = await mutate(operation);
    expect(result).toMatchObject({ success: true, uid });
    expect(result).not.toHaveProperty('warnings');
    await expectContents(operation);
  });

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
    await expectContents('replace', true);
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
      await expectContents('replace', true);
    },
  );

  it('does not create a missing move target when the source range is stale', async () => {
    await fs.writeFile(source, prefix + original);
    await fs.unlink(target);
    await expect(mutate('move')).rejects.toThrow(/line range may be stale/);
    expect(await fs.readFile(source, 'utf8')).toBe(prefix + original);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
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
    await expectContents('replace');
  });
});
