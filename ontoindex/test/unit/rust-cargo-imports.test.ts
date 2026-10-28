import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildImportResolutionContext } from '../../src/core/ingestion/import-processor.js';
import { createImportResolver } from '../../src/core/ingestion/import-resolvers/resolver-factory.js';
import { rustImportConfig } from '../../src/core/ingestion/import-resolvers/configs/rust.js';
import type { ImportConfigs, ResolveCtx } from '../../src/core/ingestion/import-resolvers/types.js';
import { loadImportConfigs } from '../../src/core/ingestion/language-config.js';

const resolve = createImportResolver(rustImportConfig);

function context(files: string[], roots: string[], modules = ['helper']): ResolveCtx {
  return {
    ...buildImportResolutionContext(files),
    configs: {
      tsconfigPaths: null,
      goModule: null,
      composerConfig: null,
      swiftPackageConfig: null,
      csharpConfigs: [],
      rustCrateRoots: roots,
    },
    rustDeclaredModules: modules,
  };
}

describe('Cargo-backed Rust bare imports', () => {
  it.each(['helper::rust_helper', 'helper::rust_helper as renamed'])(
    'resolves %s to the declared root module',
    (importPath) => {
      const ctx = context(['src/main.rs', 'src/helper.rs', 'other/helper.rs'], ['src/main.rs']);
      expect(resolve(importPath, 'src/main.rs', ctx)).toEqual({
        kind: 'files',
        files: ['src/helper.rs'],
      });
    },
  );

  it('resolves a custom target root and a directory module', () => {
    const ctx = context(['tools/entry.rs', 'tools/helper/mod.rs'], ['tools/entry.rs']);
    expect(resolve('helper::rust_helper', 'tools/entry.rs', ctx)).toEqual({
      kind: 'files',
      files: ['tools/helper/mod.rs'],
    });
  });

  it.each(['src/main.rs', 'src/lib.rs', 'src/nested/main.rs'])(
    'rejects the unproven root %s',
    (source) => {
      const directory = path.posix.dirname(source);
      const ctx = context([source, `${directory}/helper.rs`], []);
      expect(resolve('helper::rust_helper', source, ctx)).toEqual({ kind: 'files', files: [] });
    },
  );

  it('requires an unconditional top-level declaration', () => {
    const ctx = context(['src/main.rs', 'src/helper.rs'], ['src/main.rs'], []);
    expect(resolve('helper::rust_helper', 'src/main.rs', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
  });

  it('rejects competing module file layouts', () => {
    const ctx = context(['src/main.rs', 'src/helper.rs', 'src/helper/mod.rs'], ['src/main.rs']);
    expect(resolve('helper::rust_helper', 'src/main.rs', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
  });

  it('rejects paths beyond the proven module and immediate item', () => {
    const ctx = context(['src/main.rs', 'src/helper.rs', 'src/helper/nested.rs'], ['src/main.rs']);
    expect(resolve('helper::nested::rust_helper', 'src/main.rs', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
  });

  it('rejects the entire group if a member has no proven local module', () => {
    const ctx = context(['src/main.rs', 'src/helper.rs'], ['src/main.rs']);
    expect(resolve('{helper::foo, external::bar}', 'src/main.rs', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
  });
});

describe('Cargo target config discovery', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function configs(
    manifest: string | undefined,
    sources: Record<string, string>,
  ): Promise<ImportConfigs> {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-rust-cargo-config-'));
    const files = { ...sources, ...(manifest === undefined ? {} : { 'Cargo.toml': manifest }) };
    for (const [relativePath, content] of Object.entries(files)) {
      const filename = path.join(directory, relativePath);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
    return loadImportConfigs(directory, Object.keys(files));
  }

  const pkg = '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n';

  it('discovers implicit library and binary target roots', async () => {
    const loaded = await configs(pkg, {
      'src/main.rs': 'mod helper;',
      'src/lib.rs': '',
      'src/helper.rs': '',
    });
    expect(loaded.rustCrateRoots?.slice().sort()).toEqual(['src/lib.rs', 'src/main.rs']);
  });

  it('discovers explicit custom library and binary target paths', async () => {
    const loaded = await configs(
      `${pkg}[lib]\npath = "custom/library.rs"\n[[bin]]\nname = "tool"\npath = "tools/entry.rs"\n`,
      {
        'custom/library.rs': '',
        'tools/entry.rs': '',
      },
    );
    expect(loaded.rustCrateRoots?.slice().sort()).toEqual(['custom/library.rs', 'tools/entry.rs']);
  });

  it('honors disabled automatic binaries', async () => {
    const loaded = await configs(`${pkg}autobins = false\n`, {
      'src/main.rs': '',
      'src/bin/tool.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual([]);
  });

  it('does not invent an absent source for an explicit target', async () => {
    const loaded = await configs(`${pkg}[[bin]]\nname = "missing"\npath = "tools/missing.rs"\n`, {
      'src/helper.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual([]);
  });

  it('fails closed for malformed Cargo TOML', async () => {
    const loaded = await configs('[package\nname = "broken"', { 'src/main.rs': '' });
    expect(loaded.rustCrateRoots).toEqual([]);
  });

  it('retains legacy config shape when no manifest was read', async () => {
    const loaded = await configs(undefined, { 'src/main.rs': '' });
    expect(loaded.rustCrateRoots).toBeUndefined();
  });

  it('records Cargo source changes in config observations', async () => {
    const loaded = await configs(pkg, { 'src/main.rs': 'mod helper;', 'src/helper.rs': '' });
    expect(loaded.observations?.digest).toEqual(expect.any(String));
    fs.appendFileSync(path.join(directory!, 'Cargo.toml'), '\n# changed manifest\n');
    const updated = await loadImportConfigs(directory!, [
      'Cargo.toml',
      'src/main.rs',
      'src/helper.rs',
    ]);
    expect(updated.observations?.digest).toEqual(expect.any(String));
    expect(updated.observations?.digest).not.toBe(loaded.observations?.digest);
  });
});
