import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadImportConfigs } from '../../src/core/ingestion/language-config.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('import configuration observations', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-observations-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function write(relative: string, content: string | Buffer) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }

  it('hashes actual raw bytes and only attempted tsconfig candidates', async () => {
    const prefix = Buffer.from('{"compilerOptions":{"paths":{"@/*":["src/*"]}},"ignored":"');
    const raw = Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}')]);
    const changed = Buffer.concat([prefix, Buffer.from([0xfe]), Buffer.from('"}')]);
    expect(raw.toString('utf8')).toBe(changed.toString('utf8'));
    await write('tsconfig.json', raw);
    const first = await loadImportConfigs(root);
    expect([...first.tsconfigPaths!.aliases]).toEqual([['@/', 'src/']]);
    expect(
      first.observations!.records.filter(
        (record) => record.kind === 'file' && record.path.startsWith('tsconfig'),
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'tsconfig.json',
        status: 'present',
        sha256: hash(raw),
        byteLength: raw.length,
      },
    ]);
    expect(first.observations).toMatchObject({ version: 1, complete: true, issues: [] });
    expect(first.observations!.digest).toMatch(/^[a-f0-9]{64}$/);
    await write('tsconfig.json', changed);
    const second = await loadImportConfigs(root);
    expect(second.observations!.digest).not.toBe(first.observations!.digest);
    expect(second.observations!.records).toContainEqual(
      expect.objectContaining({ path: 'tsconfig.json', sha256: hash(changed) }),
    );
  });

  it('distinguishes absent and malformed candidates while retaining effective fallback', async () => {
    await write('tsconfig.app.json', '{broken');
    await write('tsconfig.base.json', '{"compilerOptions":{"paths":{"~/*":["lib/*"]}}}');
    const configs = await loadImportConfigs(root);
    expect([...configs.tsconfigPaths!.aliases]).toEqual([['~/', 'lib/']]);
    expect(configs.observations!.records).toEqual(
      expect.arrayContaining([
        { kind: 'file', path: 'tsconfig.json', status: 'absent', errorCode: 'ENOENT' },
        {
          kind: 'file',
          path: 'tsconfig.app.json',
          status: 'present',
          sha256: hash('{broken'),
          byteLength: 7,
        },
        { kind: 'parse-error', path: 'tsconfig.app.json' },
      ]),
    );
    expect(configs.observations).toMatchObject({ complete: false, digest: null });
  });

  it('records failed reads without leaking messages or treating failure as absence', async () => {
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (String(args[0]) === path.join(root, 'go.mod'))
        throw Object.assign(new Error('private secret'), { code: 'EACCES' });
      return readFile(...args);
    }) as typeof fs.readFile);
    const { observations, goModule } = await loadImportConfigs(root);
    expect(goModule).toBeNull();
    expect(observations!.records).toContainEqual({
      kind: 'file',
      path: 'go.mod',
      status: 'failed',
      errorCode: 'EACCES',
    });
    expect(observations).toMatchObject({ complete: false, digest: null });
    expect(JSON.stringify(observations)).not.toContain('private secret');
  });

  it('preserves discovery ordering and Swift duplicate overwrite', async () => {
    await write('Sources/Common/value.swift', '');
    await write('Sources/Zed/value.swift', '');
    await write('Sources/Alpha/value.swift', '');
    await write('Package/Sources/Common/value.swift', '');
    await write('src/Common/value.swift', '');
    await write('Zed.csproj', '<RootNamespace>ZedNamespace</RootNamespace>');
    await write('Alpha.csproj', '<Project/>');
    const readdir = fs.readdir.bind(fs);
    let reverse = true;
    vi.spyOn(fs, 'readdir').mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await readdir(...args);
      return entries.sort((a, b) =>
        reverse
          ? String(b.name).localeCompare(String(a.name))
          : String(a.name).localeCompare(String(b.name)),
      );
    }) as typeof fs.readdir);
    const configs = await loadImportConfigs(root);
    expect([...configs.swiftPackageConfig!.targets]).toEqual([
      ['Zed', 'Sources/Zed'],
      ['Common', 'src/Common'],
      ['Alpha', 'Sources/Alpha'],
    ]);
    expect(configs.csharpConfigs.slice(0, 2)).toEqual([
      { rootNamespace: 'ZedNamespace', projectDir: '' },
      { rootNamespace: 'Alpha', projectDir: '' },
    ]);
    expect(
      configs.observations!.records.find(
        (record) => record.kind === 'directory' && record.path === 'Sources',
      ),
    ).toMatchObject({
      entries: [
        { name: 'Zed', kind: 'directory' },
        { name: 'Common', kind: 'directory' },
        { name: 'Alpha', kind: 'directory' },
      ],
    });
    expect((await loadImportConfigs(root)).observations!.digest).toBe(configs.observations!.digest);
    reverse = false;
    expect((await loadImportConfigs(root)).observations!.digest).not.toBe(
      configs.observations!.digest,
    );
    const frozen = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) frozen(child);
    };
    frozen(configs.observations);
  });

  it('reports depth and directory-budget omissions without expanding the C# scan', async () => {
    await write('a/b/c/d/e/f/Hidden.csproj', '<Project/>');
    const depth = await loadImportConfigs(root);
    expect(depth.csharpConfigs).toEqual([]);
    expect(depth.observations!.records).toContainEqual(
      expect.objectContaining({
        kind: 'traversal',
        path: '.',
        maxDepth: 5,
        maxDirs: 100,
        depthLimited: true,
        directoryLimited: false,
      }),
    );
    expect(depth.observations).toMatchObject({ complete: false, digest: null });
    for (let i = 0; i < 105; i++) await fs.mkdir(path.join(root, `project-${i}`));
    const limited = await loadImportConfigs(root);
    expect(limited.observations!.records).toContainEqual(
      expect.objectContaining({ kind: 'traversal', dirsScanned: 100, directoryLimited: true }),
    );
    expect(limited.observations).toMatchObject({ complete: false, digest: null });
  });

  it.each(['directory entries', 'metadata bytes'] as const)(
    'bounds retained %s while preserving loader results',
    async (limit) => {
      const readdir = fs.readdir.bind(fs);
      const count = limit === 'directory entries' ? 10001 : 2000;
      vi.spyOn(fs, 'readdir').mockImplementation((async (
        ...args: Parameters<typeof fs.readdir>
      ) => {
        if (String(args[0]) === path.join(root, 'Sources'))
          return Array.from({ length: count }, (_, i) => ({
            name: `${i}-${limit === 'metadata bytes' ? 'x'.repeat(1024) : 'Target'}`,
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => false,
          }));
        return readdir(...args);
      }) as typeof fs.readdir);
      const configs = await loadImportConfigs(root);
      expect(configs.swiftPackageConfig!.targets.size).toBe(count);
      expect(configs.observations).toMatchObject({ complete: false, digest: null });
      expect(configs.observations!.issues.length).toBeGreaterThan(0);
      const recordBytes = configs.observations!.records.reduce(
        (sum, record) => sum + Buffer.byteLength(JSON.stringify(record)),
        0,
      );
      expect(recordBytes).toBeLessThanOrEqual(1024 * 1024);
      const entryCount = configs.observations!.records.reduce(
        (sum, record) => sum + (record.kind === 'directory' ? (record.entries?.length ?? 0) : 0),
        0,
      );
      expect(entryCount).toBeLessThanOrEqual(10000);
    },
  );
});
