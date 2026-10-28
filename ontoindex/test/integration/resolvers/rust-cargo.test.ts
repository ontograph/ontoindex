import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo } from './helpers.js';

describe('Cargo-backed Rust import resolution through ingestion', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const pkg = '[package]\nname = "cargo-fixture"\nversion = "0.1.0"\nedition = "2021"\n';

  async function run(files: Record<string, string>) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-rust-cargo-'));
    for (const [relativePath, content] of Object.entries(files)) {
      const filename = path.join(directory, relativePath);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
    return runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
  }

  it.each([
    ['src/main.rs', pkg],
    ['tools/entry.rs', `${pkg}[[bin]]\nname = "tool"\npath = "tools/entry.rs"\n`],
  ])(
    'links the exact declared helper and call from target %s',
    async (entry, manifest) => {
      const helper = `${path.posix.dirname(entry)}/helper.rs`;
      const result = await run({
        'Cargo.toml': manifest,
        [entry]: 'mod helper;\nuse helper::rust_helper;\npub fn rust_caller() { rust_helper(); }\n',
        [helper]: 'pub fn rust_helper() {}\n',
        'unrelated/helper.rs': 'pub fn rust_helper() {}\n',
      });
      expect(
        getRelationships(result, 'IMPORTS').map((edge) => [
          edge.sourceFilePath,
          edge.targetFilePath,
        ]),
      ).toEqual([[entry, helper]]);
      expect(
        getRelationships(result, 'CALLS').map((edge) => [
          edge.source,
          edge.target,
          edge.targetFilePath,
          edge.rel.reason,
        ]),
      ).toEqual([['rust_caller', 'rust_helper', helper, 'import-resolved']]);
    },
    60_000,
  );

  it.each([
    ['undeclared', ''],
    ['conditional', '#[cfg(feature = "optional")]\nmod helper;'],
    ['path attribute', '#[path = "elsewhere.rs"]\nmod helper;'],
    ['inline', 'mod helper { pub fn rust_helper() {} }'],
    ['nested', 'mod inner { mod helper; }'],
  ])(
    'rejects %s module evidence instead of guessing a matching filename',
    async (_name, declaration) => {
      const result = await run({
        'Cargo.toml': pkg,
        'src/main.rs': `${declaration}\nuse helper::rust_helper;\npub fn rust_caller() { rust_helper(); }\n`,
        'src/helper.rs': 'pub fn rust_helper() {}\n',
      });
      expect(getRelationships(result, 'IMPORTS')).toEqual([]);
    },
    60_000,
  );

  it('does not leak root module declarations into an inline nested use', async () => {
    const result = await run({
      'Cargo.toml': pkg,
      'src/main.rs': 'mod helper;\nmod nested { use helper::rust_helper; }\n',
      'src/helper.rs': 'pub fn rust_helper() {}\n',
    });
    expect(getRelationships(result, 'IMPORTS')).toEqual([]);
  }, 60_000);

  it('does not treat a nested file named main.rs as a Cargo target', async () => {
    const result = await run({
      'Cargo.toml': pkg,
      'src/lib.rs': 'mod nested;\n',
      'src/nested/mod.rs': 'mod main;\n',
      'src/nested/main.rs': 'mod helper;\nuse helper::rust_helper;\n',
      'src/nested/helper.rs': 'pub fn rust_helper() {}\n',
    });
    expect(
      getRelationships(result, 'IMPORTS').filter(
        (edge) => edge.sourceFilePath === 'src/nested/main.rs',
      ),
    ).toEqual([]);
  }, 60_000);
});
