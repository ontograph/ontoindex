import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const scriptUrl = new URL('../../../ontoindex-native/scripts/copy-native.cjs', import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(scriptUrl));
const root = path.resolve(scriptDirectory, '..');
const artifactPath = '/custom/cargo-target/release/libontoindex_native.so';

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    reason: 'compiler-artifact',
    manifest_path: path.join(root, 'Cargo.toml'),
    target: { name: 'ontoindex_native', crate_types: ['cdylib'] },
    filenames: [artifactPath],
    fresh: false,
    ...overrides,
  };
}

async function fixture(
  messages: unknown[],
  failure?: Error,
  missing = false,
  canonicalRoot = root,
  options: {
    mutate?: string;
    source?: string;
    addon?: string;
    lock?: string;
    metadataUnavailable?: boolean;
    writeFailure?: boolean;
    reverseEntries?: boolean;
    missingBuildScript?: boolean;
  } = {},
) {
  const source = await fs.readFile(scriptUrl, 'utf8');
  const copyFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const rmSync = vi.fn();
  const writeFileSync = vi.fn((_filename: string, _content: string) => {
    if (options.writeFailure) throw new Error('write failed');
  });
  const files = new Map([
    ['Cargo.toml', 'manifest'],
    ['build.rs', 'build script'],
    ['scripts/copy-native.cjs', 'copy script'],
    ['src/a.rs', options.source || 'source'],
    ['src/z.rs', 'other source'],
    ['Cargo.lock', options.lock || 'lock'],
  ]);
  if (options.missingBuildScript) files.delete('build.rs');
  const readFileSync = (filename: string) => {
    if (filename === path.join(canonicalRoot, 'native', 'ontoindex_native.node')) {
      return Buffer.from(options.addon || 'addon');
    }
    const content = files.get(path.relative(canonicalRoot, filename));
    if (content === undefined) throw new Error(`Unexpected input: ${filename}`);
    return Buffer.from(content);
  };
  const statSync = vi.fn(() => {
    if (missing) throw new Error('ENOENT: Cargo artifact missing');
    return { isFile: () => true };
  });
  const execFileSync = vi.fn((command: string, args: string[]) => {
    if (command === 'git') {
      if (options.metadataUnavailable) throw new Error('private git diagnostic');
      return args[0] === 'rev-parse' ? 'a'.repeat(40) : '';
    }
    if (args[0] === '--version') {
      if (options.metadataUnavailable) throw new Error('private toolchain diagnostic');
      return command === 'cargo'
        ? 'cargo 1.90.0 (private /home/private)'
        : 'rustc 1.90.0\nrelease: 1.90.0\nhost: x86_64-unknown-linux-gnu\nprivate: /home/private';
    }
    if (failure) throw failure;
    if (options.mutate) files.set(options.mutate, 'changed');
    return messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
  });
  return {
    copyFileSync,
    mkdirSync,
    statSync,
    execFileSync,
    rmSync,
    writeFileSync,
    provenance: () => JSON.parse(writeFileSync.mock.calls[0][1] as string),
    evaluate: () =>
      vm.runInNewContext(source, {
        __dirname: scriptDirectory,
        process: { platform: 'linux' },
        Buffer,
        require: (specifier: string) => {
          if (specifier === 'node:fs')
            return {
              copyFileSync,
              mkdirSync,
              statSync,
              rmSync,
              writeFileSync,
              readFileSync,
              lstatSync: (filename: string) => ({
                isDirectory: () => filename === path.join(canonicalRoot, 'src'),
                isFile: () => true,
              }),
              readdirSync: () => (options.reverseEntries ? ['z.rs', 'a.rs'] : ['a.rs', 'z.rs']),
              existsSync: (filename: string) => files.has(path.relative(canonicalRoot, filename)),
              realpathSync: () => canonicalRoot,
            };
          if (specifier === 'node:path') return path;
          if (specifier === 'node:child_process') return { execFileSync };
          if (specifier === 'node:crypto') return { createHash };
          throw new Error(`Unexpected dependency: ${specifier}`);
        },
      }),
  };
}

describe('Cargo-selected native build artifact', () => {
  it.each([false, true])('copies the emitted custom target path with fresh=%s', async (fresh) => {
    const build = await fixture([
      artifact({
        manifest_path: '/dependency/Cargo.toml',
        filenames: ['/dependency/libontoindex_native.so'],
      }),
      artifact({ target: { name: 'other', crate_types: ['cdylib'] } }),
      artifact({ target: { name: 'ontoindex_native', crate_types: ['rlib'] } }),
      artifact({ fresh, filenames: ['/custom/ontoindex_native.d', artifactPath] }),
      { reason: 'build-finished', success: true },
    ]);
    build.evaluate();
    expect(build.execFileSync).toHaveBeenCalledWith(
      'cargo',
      ['build', '--release', '--message-format=json-render-diagnostics'],
      expect.objectContaining({ cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }),
    );
    expect(build.copyFileSync).toHaveBeenCalledExactlyOnceWith(
      artifactPath,
      path.join(root, 'native', 'ontoindex_native.node'),
    );
  });

  it('does not copy when Cargo fails and preserves the failure', async () => {
    const failure = new Error('Cargo failed');
    const build = await fixture([artifact()], failure);
    expect(build.evaluate).toThrow(failure);
    expect(build.copyFileSync).not.toHaveBeenCalled();
    expect(build.mkdirSync).not.toHaveBeenCalled();
  });

  it.each([
    { messages: [] },
    { messages: [artifact({ filenames: [artifactPath, '/other/libontoindex_native.so'] })] },
  ])('rejects missing or ambiguous artifacts before copying: $messages', async ({ messages }) => {
    const build = await fixture(messages);
    expect(build.evaluate).toThrow('Expected one Cargo native artifact');
    expect(build.copyFileSync).not.toHaveBeenCalled();
    expect(build.mkdirSync).not.toHaveBeenCalled();
  });

  it('matches the canonical manifest when the checkout path is an alias', async () => {
    const canonicalRoot = '/canonical/checkout/ontoindex-native';
    const build = await fixture(
      [artifact({ manifest_path: path.join(canonicalRoot, 'Cargo.toml') })],
      undefined,
      false,
      canonicalRoot,
    );
    build.evaluate();
    expect(build.copyFileSync).toHaveBeenCalledExactlyOnceWith(
      artifactPath,
      path.join(canonicalRoot, 'native', 'ontoindex_native.node'),
    );
    expect(build.execFileSync).toHaveBeenCalledWith(
      'cargo',
      ['build', '--release', '--message-format=json-render-diagnostics'],
      expect.objectContaining({ cwd: canonicalRoot }),
    );
  });

  it('rejects a reported artifact missing from disk', async () => {
    const build = await fixture([artifact()], undefined, true);
    expect(build.evaluate).toThrow('ENOENT');
    expect(build.copyFileSync).not.toHaveBeenCalled();
    expect(build.mkdirSync).not.toHaveBeenCalled();
  });

  it('emits deterministic framed digests and sanitized metadata for the copied addon', async () => {
    const build = await fixture([artifact()]);
    build.evaluate();
    const reordered = await fixture([artifact()], undefined, false, root, { reverseEntries: true });
    reordered.evaluate();
    expect(reordered.provenance()).toEqual(build.provenance());
    expect(build.provenance()).toEqual({
      schemaVersion: 1,
      source: {
        commit: 'a'.repeat(40),
        scopedDirty: false,
        nativeSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        cargoLockSha256: createHash('sha256').update('lock').digest('hex'),
      },
      toolchain: {
        cargoVersion: '1.90.0',
        rustcVersion: '1.90.0',
        host: 'x86_64-unknown-linux-gnu',
      },
      effectiveTarget: 'unknown',
      profile: 'release',
      addonSha256: createHash('sha256').update('addon').digest('hex'),
    });
    expect(JSON.stringify(build.provenance())).not.toMatch(
      /private|\/home|timestamp|attestation|reproducib/i,
    );
  });

  it.each([
    { source: 'changed', field: 'nativeSourceSha256' },
    { lock: 'changed', field: 'cargoLockSha256' },
    { addon: 'changed', field: 'addonSha256' },
  ])('changes the digest when $field changes', async ({ field, ...options }) => {
    const before = await fixture([artifact()]);
    const after = await fixture([artifact()], undefined, false, root, options);
    before.evaluate();
    after.evaluate();
    const digest = (value: ReturnType<typeof before.provenance>) =>
      field === 'addonSha256' ? value[field] : value.source[field];
    expect(digest(after.provenance())).not.toBe(digest(before.provenance()));
  });

  it.each(['src/a.rs', 'Cargo.lock', 'build.rs'])(
    'rejects inputs mutated during Cargo: %s',
    async (mutate) => {
      const build = await fixture([artifact()], undefined, false, root, { mutate });
      expect(build.evaluate).toThrow('changed during Cargo build');
      expect(build.copyFileSync).not.toHaveBeenCalled();
      expect(build.writeFileSync).not.toHaveBeenCalled();
      expect(build.rmSync).toHaveBeenCalledTimes(2);
    },
  );

  it('allows an absent optional build script and detects its addition during Cargo', async () => {
    const build = await fixture([artifact()], undefined, false, root, { missingBuildScript: true });
    expect(build.evaluate).not.toThrow();
    const changed = await fixture([artifact()], undefined, false, root, {
      missingBuildScript: true,
      mutate: 'build.rs',
    });
    expect(changed.evaluate).toThrow('changed during Cargo build');
    expect(changed.copyFileSync).not.toHaveBeenCalled();
  });

  it('records unknown metadata without private diagnostics when tools are unavailable', async () => {
    const build = await fixture([artifact()], undefined, false, root, {
      metadataUnavailable: true,
    });
    build.evaluate();
    expect(build.provenance().source).toMatchObject({ commit: 'unknown', scopedDirty: 'unknown' });
    expect(build.provenance().toolchain).toEqual({
      cargoVersion: 'unknown',
      rustcVersion: 'unknown',
      host: 'unknown',
    });
    expect(JSON.stringify(build.provenance())).not.toContain('private');
  });

  it('removes stale or partial provenance after a write failure', async () => {
    const build = await fixture([artifact()], undefined, false, root, { writeFailure: true });
    expect(build.evaluate).toThrow('write failed');
    expect(build.rmSync).toHaveBeenNthCalledWith(
      1,
      path.join(root, 'native/build-provenance.json'),
      { force: true },
    );
    expect(build.rmSync).toHaveBeenNthCalledWith(
      2,
      path.join(root, 'native/build-provenance.json'),
      { force: true },
    );
  });
});
