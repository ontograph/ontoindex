import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const grammars = [
  ['Python', 'python'],
  ['C++', 'cpp'],
  ['Rust', 'rust'],
] as const;

async function loadWrapper(
  languageName: string,
  packageName: string,
  bun: boolean,
  options: { changed?: boolean; missing?: Error } = {},
) {
  const wrapperUrl = new URL(
    `../../vendor/tree-sitter-${packageName}/bindings/node/index.js`,
    import.meta.url,
  );
  const wrapperSource = await fs.readFile(wrapperUrl, 'utf8');
  const wrapperDirectory = path.dirname(fileURLToPath(wrapperUrl));
  const grammarRoot = path.resolve(wrapperDirectory, '../..');
  const nativePath = path.join(
    grammarRoot,
    'prebuilds/linux-x64',
    `tree-sitter-${packageName}.node`,
  );
  const nativeBytes = Buffer.from(`mock ${languageName} native grammar`);
  const binding = { language: {} };
  const nodeTypes = [{ type: 'module', named: true }];
  const module = {
    exports: {} as typeof binding & {
      nodeTypeInfo?: typeof nodeTypes;
      __ontoindexNativeIdentity?: { path: string; digest: string };
    },
  };
  let loaded = false;
  const nativeReads: string[] = [];
  const nativeRequire = (specifier: string) => {
    if (specifier === 'path') return path;
    if (specifier === 'crypto') return { createHash };
    if (specifier === 'fs')
      return {
        readFileSync: (file: string) => {
          nativeReads.push(file);
          if (options.missing) throw options.missing;
          return options.changed && loaded
            ? Buffer.from(`rebuilt ${languageName} grammar`)
            : nativeBytes;
        },
      };
    if (specifier === 'node-gyp-build') return { path: () => nativePath };
    if (specifier === '../../src/node-types.json') return nodeTypes;
    if (
      specifier === nativePath ||
      specifier === `../../prebuilds/linux-x64/tree-sitter-${packageName}.node`
    ) {
      loaded = true;
      return binding;
    }
    throw new Error(`Unexpected wrapper dependency: ${specifier}`);
  };
  return {
    module,
    binding,
    nodeTypes,
    nativeReads,
    nativePath,
    nativeBytes,
    evaluate: () =>
      vm.runInNewContext(
        wrapperSource,
        {
          require: nativeRequire,
          module,
          __dirname: wrapperDirectory,
          process: { versions: bun ? { bun: '1.0.0' } : {}, platform: 'linux', arch: 'x64' },
        },
        { filename: fileURLToPath(wrapperUrl) },
      ),
  };
}

describe.each(grammars)('%s native grammar identity', (languageName, packageName) => {
  it.each([false, true])('exports stable identity under bun=%s', async (bun) => {
    const first = await loadWrapper(languageName, packageName, bun);
    first.evaluate();
    expect(first.module.exports).toBe(first.binding);
    expect(first.module.exports.nodeTypeInfo).toBe(first.nodeTypes);
    const identity = {
      path: first.nativePath,
      digest: createHash('sha256').update(first.nativeBytes).digest('hex'),
    };
    expect(
      Object.getOwnPropertyDescriptor(first.module.exports, '__ontoindexNativeIdentity'),
    ).toEqual({
      value: identity,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(Object.isFrozen(first.module.exports.__ontoindexNativeIdentity)).toBe(true);
    expect(first.nativeReads).toEqual([first.nativePath, first.nativePath]);
    const second = await loadWrapper(languageName, packageName, bun);
    second.evaluate();
    expect(second.module.exports.__ontoindexNativeIdentity).toEqual(identity);
  });

  it.each([false, true])('rejects native bytes changed during load under bun=%s', async (bun) => {
    const fixture = await loadWrapper(languageName, packageName, bun, { changed: true });
    expect(fixture.evaluate).toThrow(`${languageName} grammar changed; restart`);
    expect(fixture.nativeReads).toEqual([fixture.nativePath, fixture.nativePath]);
    expect(fixture.module.exports).not.toHaveProperty('__ontoindexNativeIdentity');
  });

  it.each([false, true])('preserves missing native artifact errors under bun=%s', async (bun) => {
    const missing = Object.assign(new Error(`${languageName} native artifact is missing`), {
      code: 'ENOENT',
    });
    const fixture = await loadWrapper(languageName, packageName, bun, { missing });
    expect(fixture.evaluate).toThrow(missing);
    expect(fixture.nativeReads).toEqual([fixture.nativePath]);
    expect(fixture.module.exports).not.toHaveProperty('__ontoindexNativeIdentity');
  });
});
