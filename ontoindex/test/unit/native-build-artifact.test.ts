import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
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
) {
  const source = await fs.readFile(scriptUrl, 'utf8');
  const copyFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const statSync = vi.fn(() => {
    if (missing) throw new Error('ENOENT: Cargo artifact missing');
    return { isFile: () => true };
  });
  const execFileSync = vi.fn(() => {
    if (failure) throw failure;
    return messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
  });
  return {
    copyFileSync,
    mkdirSync,
    statSync,
    execFileSync,
    evaluate: () =>
      vm.runInNewContext(source, {
        __dirname: scriptDirectory,
        process: { platform: 'linux' },
        require: (specifier: string) => {
          if (specifier === 'node:fs')
            return {
              copyFileSync,
              mkdirSync,
              statSync,
              realpathSync: () => canonicalRoot,
            };
          if (specifier === 'node:path') return path;
          if (specifier === 'node:child_process') return { execFileSync };
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
});
