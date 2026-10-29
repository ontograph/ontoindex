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

  it.each(['src/foo.rs', 'src/foo/mod.rs'])(
    'prefers a declared root module at %s over a same-named workspace crate',
    (localModule) => {
      const ctx = context(['src/lib.rs', localModule, 'foo/src/lib.rs'], ['src/lib.rs'], ['foo']);
      ctx.configs.rustWorkspaceCrates = new Map([['foo', 'foo/src/lib.rs']]);
      expect(resolve('foo::x', 'src/lib.rs', ctx)).toEqual({
        kind: 'files',
        files: [localModule],
      });
    },
  );

  it('resolves a workspace crate when the crate root has no same-named module declaration', () => {
    const ctx = context(['src/lib.rs', 'src/foo.rs', 'foo/src/lib.rs'], ['src/lib.rs'], []);
    ctx.configs.rustWorkspaceCrates = new Map([['foo', 'foo/src/lib.rs']]);
    expect(resolve('foo::x', 'src/lib.rs', ctx)).toEqual({
      kind: 'files',
      files: ['foo/src/lib.rs'],
    });
  });

  it('resolves a workspace crate from a non-root file with a same-named declaration', () => {
    const ctx = context(
      ['src/lib.rs', 'src/nested.rs', 'src/nested/foo.rs', 'foo/src/lib.rs'],
      ['src/lib.rs'],
      ['foo'],
    );
    ctx.configs.rustWorkspaceCrates = new Map([['foo', 'foo/src/lib.rs']]);
    expect(resolve('foo::x', 'src/nested.rs', ctx)).toEqual({
      kind: 'files',
      files: ['foo/src/lib.rs'],
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
    expect(loaded.rustWorkspaceCrates?.get('fixture')).toBe('src/lib.rs');
  });

  it.each(['edition.workspace = true', 'edition = { workspace = true }'])(
    'inherits workspace edition for %s, including the root package',
    async (edition) => {
      const loaded = await configs(
        `[package]\nname = "root"\n${edition}\n[workspace]\n[workspace.package]\nedition = "2024"\n`,
        {
          'src/lib.rs': '',
          'member/Cargo.toml': `[package]\nname = "ontocode-tools"\n${edition}\n`,
          'member/src/lib.rs': '',
        },
      );
      expect(loaded.rustCrateRoots).toEqual(['member/src/lib.rs', 'src/lib.rs']);
      expect(loaded.rustWorkspaceCrates?.get('ontocode_tools')).toBe('member/src/lib.rs');
    },
  );

  it.each([
    undefined,
    '[workspace]\n',
    '[workspace]\n[workspace.package]\nedition = 2024\n',
    '[workspace]\n[workspace.package]\nedition = "future"\n',
  ])('records unresolved inherited editions as parse errors (%s)', async (workspace) => {
    const loaded = await configs(workspace, {
      'member/Cargo.toml': '[package]\nname = "fixture"\nedition.workspace = true\n',
      'member/src/lib.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual([]);
    expect(loaded.observations?.records).toContainEqual({
      kind: 'parse-error',
      path: 'member/Cargo.toml',
    });
  });

  it('finds the nearest ancestor workspace through intermediate package directories', async () => {
    const loaded = await configs('[workspace]\n[workspace.package]\nedition = "2024"\n', {
      'nested/Cargo.toml': pkg,
      'nested/deeper/member/Cargo.toml': '[package]\nname = "fixture"\nedition.workspace = true\n',
      'nested/deeper/member/src/lib.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual(['nested/deeper/member/src/lib.rs']);
  });

  it('does not inherit through a nearer workspace that lacks an edition', async () => {
    const loaded = await configs('[workspace]\n[workspace.package]\nedition = "2024"\n', {
      'nested/Cargo.toml': '[workspace]\n',
      'nested/member/Cargo.toml': '[package]\nname = "fixture"\nedition.workspace = true\n',
      'nested/member/src/lib.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual([]);
    expect(loaded.observations?.records).toContainEqual({
      kind: 'parse-error',
      path: 'nested/member/Cargo.toml',
    });
  });

  it('inherits from a virtual workspace at the repository root', async () => {
    const loaded = await configs('[workspace.package]\nedition = "2024"\n', {
      'deep/member/Cargo.toml': '[package]\nname = "member"\nedition.workspace = true\n',
      'deep/member/src/lib.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual(['deep/member/src/lib.rs']);
    expect(loaded.observations?.records.filter((record) => record.kind === 'parse-error')).toEqual(
      [],
    );
  });

  it('honors a normalized explicit sibling workspace before an ancestor', async () => {
    const loaded = await configs('[workspace.package]\nedition = "2024"\n', {
      'selected/Cargo.toml': '[workspace.package]\nedition = "2015"\n',
      'member/Cargo.toml':
        '[package]\nname = "member"\nworkspace = "../unused/../selected"\nedition.workspace = true\n[lib]\n',
      'member/src/lib.rs': '',
      'member/src/main.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual(['member/src/lib.rs']);
  });

  it.each(['member', 'member/deep', './member/'])(
    'skips a workspace excluding %s and continues to the repository root',
    async (excluded) => {
      const loaded = await configs('[workspace.package]\nedition = "2015"\n', {
        'nested/Cargo.toml': `[workspace]\nexclude = ["${excluded}"]\n[workspace.package]\nedition = "2024"\n`,
        'nested/member/deep/Cargo.toml':
          '[package]\nname = "member"\nedition.workspace = true\n[lib]\n',
        'nested/member/deep/src/lib.rs': '',
        'nested/member/deep/src/main.rs': '',
      });
      expect(loaded.rustCrateRoots).toEqual(['nested/member/deep/src/lib.rs']);
    },
  );

  it('matches exclude prefixes at path boundaries', async () => {
    const loaded = await configs(
      '[workspace]\nexclude = ["mem"]\n[workspace.package]\nedition = "2024"\n',
      {
        'member/Cargo.toml': '[package]\nname = "member"\nedition.workspace = true\n',
        'member/src/lib.rs': '',
      },
    );
    expect(loaded.rustCrateRoots).toEqual(['member/src/lib.rs']);
  });

  it.each(['"missing"', '"../../outside"', '"/outside"', '"C:/outside"', '42', '""'])(
    'records an invalid explicit workspace %s without ancestor fallback',
    async (workspace) => {
      const loaded = await configs('[workspace.package]\nedition = "2024"\n', {
        'member/Cargo.toml': `[package]\nname = "member"\nworkspace = ${workspace}\nedition.workspace = true\n`,
        'member/src/lib.rs': '',
      });
      expect(loaded.rustCrateRoots).toEqual([]);
      expect(loaded.observations?.records).toContainEqual({
        kind: 'parse-error',
        path: 'member/Cargo.toml',
      });
    },
  );

  it.each(['["member"]', '["member", 42]', '42'])(
    'fails closed when the only workspace excludes the member or has invalid exclusions (%s)',
    async (exclude) => {
      const loaded = await configs(
        `[workspace]\nexclude = ${exclude}\n[workspace.package]\nedition = "2024"\n`,
        {
          'member/Cargo.toml': '[package]\nname = "member"\nedition.workspace = true\n',
          'member/src/lib.rs': '',
        },
      );
      expect(loaded.rustCrateRoots).toEqual([]);
      expect(loaded.observations?.records).toContainEqual({
        kind: 'parse-error',
        path: 'member/Cargo.toml',
      });
    },
  );

  it('uses a nested workspace root package’s own edition', async () => {
    const loaded = await configs('[workspace.package]\nedition = "2015"\n', {
      'nested/Cargo.toml':
        '[package]\nname = "nested"\nedition.workspace = true\n[lib]\n[workspace.package]\nedition = "2024"\n',
      'nested/src/lib.rs': '',
      'nested/src/main.rs': '',
    });
    expect(loaded.rustCrateRoots).toEqual(['nested/src/lib.rs', 'nested/src/main.rs']);
  });

  it.each(['2024', 'false', '{ workspace = false }'])(
    'records a non-string package edition %s as a parse error',
    async (edition) => {
      const loaded = await configs(`[package]\nname = "fixture"\nedition = ${edition}\n`, {
        'src/lib.rs': '',
      });
      expect(loaded.rustCrateRoots).toEqual([]);
      expect(loaded.observations?.records).toContainEqual({
        kind: 'parse-error',
        path: 'Cargo.toml',
      });
    },
  );

  it('uses normalized library names and custom paths, excluding binaries', async () => {
    const loaded = await configs(`${pkg}[lib]\nname = "custom-library"\npath = "api/root.rs"\n`, {
      'api/root.rs': '',
      'src/main.rs': '',
    });
    expect([...loaded.rustWorkspaceCrates!]).toEqual([['custom_library', 'api/root.rs']]);
  });

  it('rejects ambiguous normalized crate names and omits binary-only packages', async () => {
    const loaded = await configs('[workspace]\nmembers = ["a", "b", "cli"]\n', {
      'a/Cargo.toml': pkg.replace('fixture', 'same-name'),
      'a/src/lib.rs': '',
      'b/Cargo.toml': pkg.replace('fixture', 'same_name'),
      'b/src/lib.rs': '',
      'cli/Cargo.toml': pkg.replace('fixture', 'binary-only'),
      'cli/src/main.rs': '',
    });
    expect([...loaded.rustWorkspaceCrates!]).toEqual([['same_name', null]]);
    const ctx = context(
      ['a/src/lib.rs', 'b/src/lib.rs', 'cli/src/main.rs'],
      loaded.rustCrateRoots!.slice(),
    );
    ctx.configs = loaded;
    expect(resolve('same_name::helper', 'cli/src/main.rs', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
    expect(resolve('binary_only::helper', 'a/src/lib.rs', ctx)).toEqual({
      kind: 'files',
      files: [],
    });
  });

  it('resolves workspace module paths from their own library root', async () => {
    const loaded = await configs(pkg.replace('fixture', 'other-crate'), {
      'src/lib.rs': '',
      'src/models/mod.rs': '',
    });
    const ctx = context(
      ['src/lib.rs', 'src/models/mod.rs', 'consumer/src/main.rs'],
      ['src/lib.rs'],
    );
    ctx.configs = loaded;
    expect(resolve('other_crate::models::Item', 'consumer/src/main.rs', ctx)).toEqual({
      kind: 'files',
      files: ['src/models/mod.rs'],
    });
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
