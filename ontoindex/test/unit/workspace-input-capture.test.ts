import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  captureWorkspaceInputs,
  workspaceConfigurationIdentity,
  type WorkspaceInputCapture,
} from '../../src/core/analyze-delta.js';
import {
  computeSourceManifest,
  manifestsMatch,
  sourceManifestDigest,
} from '../../src/core/indexing/source-manifest.js';

const roots: string[] = [];
const captures: WorkspaceInputCapture[] = [];

async function makeRepo(git = false): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-capture-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/main.ts'), 'export const value = 1;\n');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'src/main.ts'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Capture test',
        '-c',
        'user.email=capture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: root },
    );
  }
  return root;
}

async function capture(root: string, options: Parameters<typeof captureWorkspaceInputs>[1] = {}) {
  const result = await captureWorkspaceInputs(root, {
    parserIdentity: 'test-parser-v1',
    ...options,
  });
  captures.push(result);
  return result;
}

async function pendingCaptures(root: string): Promise<string[]> {
  return fs.readdir(path.join(root, '.ontoindex/workspace-inputs'));
}

afterEach(async () => {
  await Promise.all(captures.splice(0).map((result) => result.dispose()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('workspace input capture', () => {
  it('materializes the complete eligible universe with private modes and idempotent cleanup', async () => {
    const root = await makeRepo();
    for (let index = 0; index < 55; index++) {
      await fs.writeFile(
        path.join(root, `src/file-${index}.ts`),
        `export const item = ${index};\n`,
      );
    }
    await fs.chmod(path.join(root, 'src/main.ts'), 0o755);
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
    await fs.writeFile(path.join(root, 'ignored.ts'), 'ignored');
    const result = await capture(root);
    expect(result.canonicalRepoPath).toBe(await fs.realpath(root));
    expect(result.capturedPaths).toHaveLength(57);
    expect(result.capturedPaths).not.toContain('ignored.ts');
    expect(
      result.manifest.workspaceCapture!.entries.find((entry) => entry.path === 'src/main.ts')!
        .executable,
    ).toBe(true);
    expect((await fs.stat(result.captureRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(result.captureRoot, 'src'))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(result.captureRoot, 'src/main.ts'))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(result.captureRoot, 'src/main.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );
    await fs.writeFile(path.join(root, 'src/main.ts'), 'export const value = 2;\n');
    expect(await fs.readFile(path.join(result.captureRoot, 'src/main.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );
    expect(result.totalBytes).toBe(
      result.manifest.workspaceCapture!.entries.reduce((sum, entry) => sum + entry.byteLength, 0),
    );
    expect(result.manifestDigest).toBe(sourceManifestDigest(result.manifest));
    await Promise.all([result.dispose(), result.dispose()]);
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('changes content identity for equal-size equal-mtime edits and executable intent', async () => {
    const root = await makeRepo();
    const source = path.join(root, 'src/main.ts');
    const stat = await fs.stat(source);
    const first = await capture(root);
    await fs.writeFile(source, 'export const value = 2;\n');
    await fs.utimes(source, stat.atime, stat.mtime);
    const second = await capture(root);
    expect(second.manifestDigest).not.toBe(first.manifestDigest);
    await fs.chmod(source, 0o755);
    const third = await capture(root);
    expect(third.manifestDigest).not.toBe(second.manifestDigest);
  });

  it('captures working-file bytes across staged, unstaged and untracked rename/delete changes', async () => {
    const root = await makeRepo(true);
    const initial = await capture(root);
    execFileSync('git', ['mv', 'src/main.ts', 'src/renamed.ts'], { cwd: root });
    await fs.writeFile(path.join(root, 'src/renamed.ts'), 'export const value = 9;\n');
    await fs.writeFile(path.join(root, 'src/new.ts'), 'export const added = 1;\n');
    const renamed = await capture(root);
    expect(renamed.head).toBe(initial.head);
    expect(renamed.tombstones).toEqual(['src/main.ts']);
    expect(renamed.capturedPaths).toEqual(['src/new.ts', 'src/renamed.ts']);
    expect(renamed.manifestDigest).not.toBe(initial.manifestDigest);
    await fs.rm(path.join(root, 'src/renamed.ts'));
    const deleted = await capture(root);
    expect(deleted.manifestDigest).not.toBe(renamed.manifestDigest);
  });

  it('binds resolver/ignore configuration and parser identity without upgrading legacy manifests', async () => {
    const root = await makeRepo();
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    );
    const first = await capture(root);
    expect(first.capturedPaths).toContain('tsconfig.json');
    const legacy = await computeSourceManifest(root);
    expect(legacy.workspaceCapture).toBeUndefined();
    expect(manifestsMatch(first.manifest, legacy)).toBe(false);
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["other/*"]}}}',
    );
    const configured = await capture(root);
    expect(configured.configurationDigest).not.toBe(first.configurationDigest);
    expect(configured.manifestDigest).not.toBe(first.manifestDigest);
    const parser = await capture(root, { parserIdentity: 'test-parser-v2' });
    expect(parser.manifestDigest).not.toBe(configured.manifestDigest);
    await fs.writeFile(path.join(root, '.ontoindexignore'), 'src/main.ts\n');
    const ignored = await capture(root);
    expect(ignored.configurationDigest).not.toBe(parser.configurationDigest);
    expect(ignored.capturedPaths).not.toContain('src/main.ts');
  });

  it.each(['tsconfig.json', 'jsconfig.json'])(
    'preserves JSONC strings, comments and trailing commas in %s',
    async (filename) => {
      const root = await makeRepo();
      const configuration = String.raw`{
      "$schema": "https://json.schemastore.org/tsconfig",
      // Resolver roots stay inside the repository.
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["src/*", /* trailing array comma */], },
      },
      "description": "literal // and /* text */ with escaped \"quotes\" and backslash \\",
    }`;
      await fs.writeFile(path.join(root, filename), configuration);
      const result = await capture(root);
      expect(result.capturedPaths).toContain(filename);
      expect(await fs.readFile(path.join(result.captureRoot, filename), 'utf8')).toBe(
        configuration,
      );
    },
  );

  it.each([
    {},
    { compilerOptions: { strict: true } },
    { compilerOptions: { paths: { '@/*': ['src/*'] } } },
    { compilerOptions: { baseUrl: 'src', paths: { '@/*': ['../shared/*'] } } },
  ])(
    'captures valid resolver configuration without requiring baseUrl: %j',
    async (configuration) => {
      const root = await makeRepo();
      const source = JSON.stringify(configuration);
      await fs.writeFile(path.join(root, 'tsconfig.json'), source);
      const result = await capture(root);
      expect(result.capturedPaths).toContain('tsconfig.json');
      expect(await fs.readFile(path.join(result.captureRoot, 'tsconfig.json'), 'utf8')).toBe(
        source,
      );
    },
  );

  it.each([
    { compilerOptions: { baseUrl: 'src' }, extends: '../outside' },
    { compilerOptions: { baseUrl: 'src' }, extends: ['../outside'] },
    { compilerOptions: { baseUrl: 'src' }, references: [{ path: '../outside' }] },
    { compilerOptions: { baseUrl: 'src', rootDirs: ['../outside'] } },
    { compilerOptions: { baseUrl: 'src', typeRoots: ['../outside'] } },
    { compilerOptions: { paths: { '@/*': ['../outside/*'] } } },
  ])('rejects resolver escapes using the correct resolution base: %j', async (configuration) => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify(configuration));
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it.each(['tsconfig.json', 'jsconfig.json'])(
    'resolves nested configuration roots separately from path mappings in %s',
    async (filename) => {
      const root = await makeRepo();
      const relativePath = `apps/web/${filename}`;
      const source = JSON.stringify({
        extends: '../tsconfig.base.json',
        references: [{ path: '../shared' }],
        compilerOptions: {
          baseUrl: '../..',
          rootDirs: ['../shared/src'],
          typeRoots: ['../types'],
          paths: { '@/*': ['src/*'] },
        },
      });
      await fs.mkdir(path.join(root, 'apps/web'), { recursive: true });
      await fs.writeFile(path.join(root, relativePath), source);
      const result = await capture(root);
      expect(result.capturedPaths).toContain(relativePath);
      expect(await fs.readFile(path.join(result.captureRoot, relativePath), 'utf8')).toBe(source);
    },
  );

  it.each([
    { compilerOptions: { baseUrl: '../../..' } },
    { compilerOptions: { baseUrl: 'src/deep' }, extends: '../../../outside.json' },
    { compilerOptions: { baseUrl: 'src/deep' }, extends: ['../../../outside.json'] },
    { compilerOptions: { baseUrl: 'src/deep' }, references: [{ path: '../../../outside' }] },
    { compilerOptions: { baseUrl: 'src/deep', rootDirs: ['../../../outside'] } },
    { compilerOptions: { baseUrl: 'src/deep', typeRoots: ['../../../outside'] } },
    { compilerOptions: { baseUrl: '../..', paths: { '@/*': ['../outside/*'] } } },
  ])('rejects nested resolver escapes using category-specific bases: %j', async (configuration) => {
    const root = await makeRepo();
    await fs.mkdir(path.join(root, 'apps/web'), { recursive: true });
    await fs.writeFile(path.join(root, 'apps/web/tsconfig.json'), JSON.stringify(configuration));
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it.each([
    null,
    [],
    true,
    { compilerOptions: null },
    { compilerOptions: [] },
    { compilerOptions: { baseUrl: null } },
    { compilerOptions: { baseUrl: 1 } },
    { compilerOptions: { rootDirs: 'src' } },
    { compilerOptions: { rootDirs: [1] } },
    { compilerOptions: { typeRoots: null } },
    { compilerOptions: { typeRoots: [false] } },
    { compilerOptions: { paths: [] } },
    { compilerOptions: { paths: null } },
    { compilerOptions: { paths: { '@/*': 'src/*' } } },
    { compilerOptions: { paths: { '@/*': [null] } } },
    { extends: null },
    { extends: 1 },
    { extends: [false] },
    { references: null },
    { references: {} },
    { references: [null] },
    { references: [{}] },
    { references: [{ path: 1 }] },
  ])('rejects malformed resolver fields with cleanup: %j', async (configuration) => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify(configuration));
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it.each([
    '{"compilerOptions":{"baseUrl":"."}, /* unterminated',
    '{"compilerOptions":{"baseUrl":".",,"paths":{}}}',
    '{"compilerOptions":{"baseUrl":".","rootDirs":[,]}}',
    '{"compilerOptions":{"baseUrl":"."},"empty":{,}}',
    '{"compilerOptions":{"baseUrl":"."},"value":tr/* split token */ue}',
    '{"compilerOptions":{"baseUrl":"."},"value":"unterminated}',
  ])('rejects malformed JSONC without retaining a capture: %s', async (configuration) => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'tsconfig.json'), configuration);
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('retries once after a raced same-mtime edit and removes only its failed tree', async () => {
    const root = await makeRepo();
    let attempts = 0;
    const failed: string[] = [];
    const result = await capture(root, {
      hooks: {
        afterCopy: async ({ attempt, captureRoot }) => {
          attempts++;
          if (attempt === 1) {
            failed.push(captureRoot);
            const source = path.join(root, 'src/main.ts');
            const stat = await fs.stat(source);
            await fs.writeFile(source, 'export const value = 2;\n');
            await fs.utimes(source, stat.atime, stat.mtime);
          }
        },
      },
    });
    expect(attempts).toBe(2);
    await expect(fs.stat(failed[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(result.captureRoot, 'src/main.ts'), 'utf8')).toContain(
      'value = 2',
    );
    expect(await pendingCaptures(root)).toEqual([path.basename(result.captureRoot)]);
  });

  it('rejects after two changed-input attempts and removes owned failures without touching a borrowed tree', async () => {
    const root = await makeRepo();
    const borrowed = await capture(root);
    let attempts = 0;
    await expect(
      capture(root, {
        hooks: {
          afterCopy: async ({ attempt }) => {
            attempts++;
            await fs.writeFile(
              path.join(root, 'src/main.ts'),
              `export const value = ${attempt + 1};\n`,
            );
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'changed-input' });
    expect(attempts).toBe(2);
    expect(await pendingCaptures(root)).toEqual([path.basename(borrowed.captureRoot)]);
  });

  it('rejects tampered copied bytes and detects base changes during capture', async () => {
    const root = await makeRepo();
    await expect(
      capture(root, {
        hooks: {
          afterCopy: async ({ captureRoot }) => {
            await fs.writeFile(path.join(captureRoot, 'src/main.ts'), 'export const value = 8;\n');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'changed-input' });
    await expect(
      capture(root, {
        hooks: {
          afterCopy: async ({ attempt }) => {
            await fs.writeFile(
              path.join(root, '.ontoindex/meta.json'),
              JSON.stringify({ lastCommit: 'base', generationId: `base-${attempt}` }),
            );
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'changed-input' });
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('rejects symlink files, directory escapes and a symlink capture parent', async () => {
    const root = await makeRepo();
    const outside = await makeRepo();
    await fs.symlink(path.join(outside, 'src/main.ts'), path.join(root, 'src/link.ts'));
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    await fs.rm(path.join(root, 'src/link.ts'));
    await fs.symlink(path.join(outside, 'src'), path.join(root, 'escape'));
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    await fs.rm(path.join(root, 'escape'));
    await fs.rm(path.join(root, '.ontoindex/workspace-inputs'), { recursive: true });
    await fs.symlink(outside, path.join(root, '.ontoindex/workspace-inputs'));
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await fs.readFile(path.join(outside, 'src/main.ts'), 'utf8')).toContain('value = 1');
  });

  it('fails closed when an ancestor directory is swapped to a symlink mid-capture', async () => {
    const root = await makeRepo();
    const outside = await makeRepo();
    await expect(
      capture(root, {
        hooks: {
          afterCopy: async () => {
            await fs.rename(path.join(root, 'src'), path.join(root, 'src-real'));
            await fs.symlink(path.join(outside, 'src'), path.join(root, 'src'));
          },
        },
      }),
    ).rejects.toBeDefined();
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('rejects external/absolute resolver roots explicitly', async () => {
    const root = await makeRepo();
    for (const baseUrl of ['../outside', '/tmp/outside', 'C:\\outside']) {
      await fs.writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl } }),
      );
      await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    }
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('rejects FIFO ignore files without hanging or leaking captures', async () => {
    const root = await makeRepo();
    execFileSync('mkfifo', [path.join(root, '.gitignore')]);
    await expect(capture(root, { deadline: performance.now() + 1000 })).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('rejects an ignore file replaced by a FIFO during capture', async () => {
    const root = await makeRepo();
    const ignore = path.join(root, '.gitignore');
    await fs.writeFile(ignore, 'dist\n');
    await expect(
      capture(root, {
        deadline: performance.now() + 1000,
        hooks: {
          beforeVerify: async () => {
            await fs.rm(ignore);
            execFileSync('mkfifo', [ignore]);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('copies only the requested sources plus configuration when includePaths is set', async () => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'src/other.ts'), 'export const other = 1;\n');
    const scoped = await capture(root, { includePaths: ['src/main.ts'] });
    try {
      expect(scoped.capturedPaths).toContain('src/main.ts');
      expect(scoped.capturedPaths).not.toContain('src/other.ts');
    } finally {
      await scoped.dispose();
    }
  });

  it('finds ancestor configuration and re-lists configuration added between passes', async () => {
    const root = await makeRepo();
    await fs.mkdir(path.join(root, 'src/deep'));
    await fs.writeFile(path.join(root, 'src/deep/main.ts'), 'export const nested = 1;');
    await fs.writeFile(path.join(root, 'src/tsconfig.json'), '{}');
    let attempts = 0;
    const result = await capture(root, {
      includePaths: ['src/deep/main.ts'],
      hooks: {
        afterCopy: async ({ attempt }) => {
          attempts++;
          if (attempt === 1) await fs.writeFile(path.join(root, 'src/deep/tsconfig.json'), '{}');
        },
      },
    });
    expect(attempts).toBe(2);
    expect(result.capturedPaths).toEqual([
      'src/deep/main.ts',
      'src/deep/tsconfig.json',
      'src/tsconfig.json',
    ]);
  });

  it('computes the same configuration and parser identity without copying inputs', async () => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'src/tsconfig.json'), '{}');
    const options = { includePaths: ['src/main.ts'] };
    const identity = await workspaceConfigurationIdentity(root, options);
    await expect(fs.stat(path.join(root, '.ontoindex/workspace-inputs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const result = await capture(root, { ...options, parserIdentity: undefined });
    expect(identity).toEqual({
      configurationDigest: result.configurationDigest,
      parserIdentity: result.parserIdentity,
    });
    await fs.writeFile(path.join(root, 'src/tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const changed = await workspaceConfigurationIdentity(root, options);
    expect(changed.configurationDigest).not.toBe(identity.configurationDigest);
    expect(changed.parserIdentity).toBe(identity.parserIdentity);
    await fs.writeFile(path.join(root, '.ontoindexignore'), 'unused.ts\n');
    expect((await workspaceConfigurationIdentity(root, options)).configurationDigest).not.toBe(
      changed.configurationDigest,
    );
  });

  it('tracks sibling .csproj files the C# resolver scans, in capture and identity', async () => {
    const root = await makeRepo();
    await fs.mkdir(path.join(root, 'a'));
    await fs.mkdir(path.join(root, 'b'));
    await fs.writeFile(path.join(root, 'a/main.cs'), 'class A {}\n');
    await fs.writeFile(path.join(root, 'b/B.csproj'), '<RootNamespace>Old</RootNamespace>');
    const scoped = await capture(root, { includePaths: ['a/main.cs'] });
    const before = await workspaceConfigurationIdentity(root, { includePaths: ['a/main.cs'] });
    try {
      expect(scoped.capturedPaths).toContain('b/B.csproj');
      expect(before.configurationDigest).toBe(scoped.configurationDigest);
    } finally {
      await scoped.dispose();
    }
    await fs.writeFile(path.join(root, 'b/B.csproj'), '<RootNamespace>New</RootNamespace>');
    const after = await workspaceConfigurationIdentity(root, { includePaths: ['a/main.cs'] });
    expect(after.configurationDigest).not.toBe(before.configurationDigest);
  });

  it('rejects limits, unreadable required files, cancellation and deadline expiry with cleanup', async () => {
    const root = await makeRepo();
    await expect(capture(root, { maxFiles: 0 })).rejects.toMatchObject({ code: 'limit' });
    await expect(capture(root, { maxTotalBytes: 1 })).rejects.toMatchObject({ code: 'limit' });
    await fs.chmod(path.join(root, 'src/main.ts'), 0);
    await expect(capture(root)).rejects.toMatchObject({ code: 'unsupported' });
    await fs.chmod(path.join(root, 'src/main.ts'), 0o600);
    const controller = new AbortController();
    await expect(
      capture(root, { signal: controller.signal, hooks: { afterCopy: () => controller.abort() } }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(capture(root, { deadline: performance.now() - 1 })).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(await pendingCaptures(root)).toEqual([]);
  });
});
