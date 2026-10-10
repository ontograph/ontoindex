import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { getRelationships, runPipelineFromRepo } from './resolvers/helpers.js';

const execFileAsync = promisify(execFile);

describe('NodeNext specifiers in the real analysis pipeline', () => {
  let temporary: TestDBHandle;

  beforeEach(async () => {
    temporary = await createTempDir('ontoindex-js-specifier-edges-');
    vi.stubEnv('ONTOINDEX_HOME', path.join(temporary.dbPath, 'home'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await temporary?.cleanup();
  });

  it('resolves exact IMPORTS and cross-file CALLS edges without resolving missing files', async () => {
    const repoPath = path.join(temporary.dbPath, 'repo');
    await fs.mkdir(path.join(repoPath, 'sub'), { recursive: true });
    const files = {
      'a.ts': 'export function target() { return 1; }\n',
      'b.ts': "import { target } from './a.js';\nexport function callerB() { return target(); }\n",
      'c.ts': "import { target } from './a';\nexport function callerC() { return target(); }\n",
      'sub/index.ts': 'export function deep() { return 2; }\n',
      'd.ts':
        "import { deep } from './sub/index.js';\nexport function callerD() { return deep(); }\n",
      'f.mts': 'export function fm() { return 3; }\n',
      'e.ts': "import { fm } from './f.mjs';\nexport function callerE() { return fm(); }\n",
      'g.ts': "import { nope } from './missing.js';\n",
    };
    for (const [file, content] of Object.entries(files)) {
      await fs.writeFile(path.join(repoPath, file), content);
    }
    await execFileAsync('git', ['init', '--quiet'], { cwd: repoPath });
    await execFileAsync('git', ['add', '.'], { cwd: repoPath });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=OntoIndex Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${path.join(temporary.dbPath, 'hooks')}`,
        'commit',
        '--quiet',
        '-m',
        'NodeNext fixture',
      ],
      { cwd: repoPath },
    );

    // Exercise real scanning, parsing, import resolution and cross-file linking.
    // Inspect the returned graph; no registry publication or database is needed.
    const result = await runPipelineFromRepo(repoPath, () => {}, { skipWorkers: true });
    const indexedFiles = result.graph.nodes
      .filter((node) => node.label === 'File')
      .map((node) => node.properties.filePath)
      .sort();
    expect(indexedFiles).toEqual(Object.keys(files).sort());

    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.map((edge) => [edge.sourceFilePath, edge.targetFilePath]).sort()).toEqual([
      ['b.ts', 'a.ts'],
      ['c.ts', 'a.ts'],
      ['d.ts', 'sub/index.ts'],
      ['e.ts', 'f.mts'],
    ]);
    expect(imports.filter((edge) => edge.sourceFilePath === 'g.ts')).toEqual([]);

    const calls = getRelationships(result, 'CALLS');
    expect(
      calls
        .map((edge) => [edge.sourceFilePath, edge.targetFilePath, edge.source, edge.target])
        .sort(),
    ).toEqual([
      ['b.ts', 'a.ts', 'callerB', 'target'],
      ['c.ts', 'a.ts', 'callerC', 'target'],
      ['d.ts', 'sub/index.ts', 'callerD', 'deep'],
      ['e.ts', 'f.mts', 'callerE', 'fm'],
    ]);

    await expect(fs.stat(path.join(repoPath, '.ontoindex'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(temporary.dbPath, 'home'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 30_000);
});
