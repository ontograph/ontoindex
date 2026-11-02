import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const scriptUrl = new URL('../../scripts/build-vendored-natives.cjs', import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(scriptUrl));
const vendor = path.resolve(scriptDirectory, '../vendor');
const runtime = path.join(vendor, 'tree-sitter');
const artifact = path.join(runtime, 'build/Release/tree_sitter_runtime_binding.node');
type Result = { status: number | null; signal?: string | null; error?: Error };

async function fixture(
  options: {
    platform?: string;
    entries?: string[];
    missing?: string[];
    build?: Result;
    verification?: Result;
    selected?: string;
    canonicalSelected?: string;
    loadFailure?: boolean;
    installedRuntime?: string;
    bundledNodeGyp?: boolean;
  } = {},
) {
  const source = await fs.readFile(scriptUrl, 'utf8');
  const events: string[] = [];
  const processState = {
    platform: options.platform ?? 'linux',
    execPath: '/node',
    env: options.bundledNodeGyp ? {} : { npm_config_node_gyp: '/node-gyp.js' },
    exitCode: undefined as number | undefined,
  };
  const error = vi.fn();
  const createRequire = (manifest: string) => (specifier: string) => {
    if (specifier !== 'node-gyp-build') throw new Error(`Unexpected dependency: ${specifier}`);
    return (dir: string) => {
      expect(manifest).toBe(path.join(dir, 'package.json'));
      events.push(`probe:${path.basename(dir)}`);
      if (
        options.missing?.includes(path.basename(dir)) &&
        !events.includes(`build:${path.basename(dir)}`)
      ) {
        throw new Error('Missing binary');
      }
    };
  };
  const spawnSync = vi.fn((_command: string, args: string[], spawnOptions: { cwd: string }) => {
    const name = path.basename(spawnOptions.cwd);
    if (args[0] !== '-e') {
      events.push(`build:${name}`);
      return options.build ?? { status: 0 };
    }
    events.push(`verify:${name}`);
    if (options.verification) return options.verification;
    const load = Object.assign(
      (dir: string) => {
        expect(dir).toBe(runtime);
        events.push('child:load');
        if (options.loadFailure) throw new Error('Runtime load failed');
      },
      {
        resolve: (dir: string) => {
          expect(dir).toBe(runtime);
          events.push('child:resolve');
          return options.selected ?? artifact;
        },
      },
    );
    try {
      vm.runInNewContext(args[1], {
        process: { argv: ['/node', args[2]] },
        require: (specifier: string) => {
          if (specifier === 'node:path') return path;
          if (specifier === 'node:fs')
            return {
              realpathSync: (filename: string) => {
                events.push(`realpath:${filename}`);
                return filename === (options.selected ?? artifact)
                  ? (options.canonicalSelected ?? filename)
                  : filename;
              },
            };
          if (specifier === 'node:module')
            return {
              createRequire: (manifest: string) => {
                if (manifest === path.resolve(runtime, '../../package.json')) {
                  return {
                    resolve: (dependency: string) => {
                      expect(dependency).toBe('tree-sitter/package.json');
                      events.push('child:resolve-app');
                      return path.join(options.installedRuntime ?? runtime, 'package.json');
                    },
                  };
                }
                expect(manifest).toBe(path.join(runtime, 'package.json'));
                return (dependency: string) => {
                  expect(dependency).toBe('node-gyp-build');
                  return load;
                };
              },
            };
          throw new Error(`Unexpected child dependency: ${specifier}`);
        },
      });
      return { status: 0 };
    } catch (failure) {
      error((failure as Error).message);
      return { status: 1 };
    }
  });
  const requireMock = Object.assign(
    (specifier: string) => {
      if (specifier === 'node:path') return path;
      if (specifier === 'node:fs')
        return {
          readdirSync: () =>
            (options.entries ?? ['tree-sitter', 'tree-sitter-json']).map((name) => ({
              name,
              isDirectory: () => true,
            })),
          existsSync: () => true,
        };
      if (specifier === 'node:module') return { createRequire };
      if (specifier === 'node:child_process') return { spawnSync };
      throw new Error(`Unexpected dependency: ${specifier}`);
    },
    { resolve: () => '/bundled/node-gyp.js' },
  );
  vm.runInNewContext(source, {
    __dirname: scriptDirectory,
    process: processState,
    console: { error },
    require: requireMock,
  });
  return { events, spawnSync, error, process: processState };
}

describe('vendored native runtime lifecycle', () => {
  it('rebuilds a loadable Linux runtime before any load and skips a loadable grammar', async () => {
    const build = await fixture();
    expect(build.events).toEqual([
      'build:tree-sitter',
      'verify:tree-sitter',
      'child:resolve-app',
      `realpath:${runtime}`,
      `realpath:${runtime}`,
      'child:resolve',
      `realpath:${artifact}`,
      `realpath:${artifact}`,
      'child:load',
      'probe:tree-sitter-json',
    ]);
    expect(build.process.exitCode).toBeUndefined();
    expect(build.spawnSync.mock.calls[0]).toEqual([
      '/node',
      ['/node-gyp.js', 'rebuild', '--jobs=4'],
      expect.objectContaining({
        cwd: runtime,
        env: expect.objectContaining({ JOBS: '4', npm_config_jobs: '4' }),
        stdio: ['ignore', 2, 2],
      }),
    ]);
    expect(build.spawnSync.mock.calls[1]).toEqual([
      '/node',
      ['-e', expect.any(String), runtime],
      { cwd: runtime, env: build.process.env, stdio: ['ignore', 2, 2] },
    ]);
    expect(build.error).toHaveBeenCalledWith('[tree-sitter] Rebuilding required native runtime');
  });

  it('keeps the missing grammar rebuild path and distinct log', async () => {
    const build = await fixture({ entries: ['tree-sitter-json'], missing: ['tree-sitter-json'] });
    expect(build.events).toEqual([
      'probe:tree-sitter-json',
      'build:tree-sitter-json',
      'probe:tree-sitter-json',
    ]);
    expect(build.error).toHaveBeenCalledWith('[tree-sitter-json] Building missing native binary');
    expect(build.process.exitCode).toBeUndefined();
  });

  it('uses npm’s bundled node-gyp when available', async () => {
    const build = await fixture({ entries: ['tree-sitter'], bundledNodeGyp: true });
    expect(build.spawnSync.mock.calls[0][1]).toEqual([
      '/bundled/node-gyp.js',
      'rebuild',
      '--jobs=4',
    ]);
  });

  it.each([
    { status: 1 },
    { status: null, error: new Error('spawn failed') },
    { status: null, signal: 'SIGTERM' },
    { status: 0, signal: 'SIGTERM' },
  ])('fails closed on required build failure %j without loading a fallback', async (result) => {
    const build = await fixture({ entries: ['tree-sitter'], build: result });
    expect(build.events).toEqual(['build:tree-sitter']);
    expect(build.process.exitCode).toBe(1);
  });

  it.each([
    { status: 1 },
    { status: null, error: new Error('verification spawn failed') },
    { status: null, signal: 'SIGTERM' },
    { status: 0, signal: 'SIGTERM' },
  ])('fails closed on child verification failure %j', async (result) => {
    const build = await fixture({ entries: ['tree-sitter'], verification: result });
    expect(build.events).toEqual(['build:tree-sitter', 'verify:tree-sitter']);
    expect(build.process.exitCode).toBe(1);
  });

  it.each(['prebuilds/linux-x64/runtime.node', 'build/Debug/runtime.node'])(
    'rejects selected %s before loading and gives environment repair hints',
    async (selected) => {
      const build = await fixture({
        entries: ['tree-sitter'],
        selected: path.join(runtime, selected),
      });
      expect(build.events).toContain('child:resolve');
      expect(build.events).not.toContain('child:load');
      expect(build.process.exitCode).toBe(1);
      expect(build.error).toHaveBeenCalledWith(
        expect.stringMatching(/TREE_SITTER_PREBUILD.*PREBUILDS_ONLY/),
      );
    },
  );

  it('accepts a selected symlink that resolves to the rebuilt artifact', async () => {
    const build = await fixture({
      entries: ['tree-sitter'],
      selected: '/alias/runtime.node',
      canonicalSelected: artifact,
    });
    expect(build.events).toContain('child:load');
    expect(build.process.exitCode).toBeUndefined();
  });

  it('rejects an application dependency pointing at another runtime before loading', async () => {
    const build = await fixture({
      entries: ['tree-sitter'],
      installedRuntime: '/copied/tree-sitter',
    });
    expect(build.process.exitCode).toBe(1);
    expect(build.events).not.toContain('child:resolve');
    expect(build.events).not.toContain('child:load');
    expect(build.error).toHaveBeenCalledWith(
      expect.stringContaining('Application tree-sitter must resolve to rebuilt vendor runtime'),
    );
  });

  it('fails closed when loading the verified artifact fails', async () => {
    const build = await fixture({ entries: ['tree-sitter'], loadFailure: true });
    expect(build.events.at(-1)).toBe('child:load');
    expect(build.process.exitCode).toBe(1);
  });

  it('keeps optional grammar build failures best effort', async () => {
    const build = await fixture({
      entries: ['tree-sitter-json'],
      missing: ['tree-sitter-json'],
      build: { status: 1 },
    });
    expect(build.events).toEqual(['probe:tree-sitter-json', 'build:tree-sitter-json']);
    expect(build.process.exitCode).toBeUndefined();
  });

  it('preserves the probe-first runtime behavior outside Linux', async () => {
    const build = await fixture({ platform: 'darwin', entries: ['tree-sitter'] });
    expect(build.events).toEqual(['probe:tree-sitter']);
    expect(build.spawnSync).not.toHaveBeenCalled();
  });
});
