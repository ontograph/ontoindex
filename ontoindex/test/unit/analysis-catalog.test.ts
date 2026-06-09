import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAnalysisCatalog, manifestErrorMessage } from '../../src/analysis-packs/catalog.js';
import { runAnalysisCatalog } from '../../src/mcp/local/backend-analysis-catalog.js';

describe('analysis catalog', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
  });

  async function createTempRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-analysis-catalog-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('loads pack and suite manifests from ontoindex-packs', async () => {
    const repoDir = await createTempRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/demo-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/demo-suite'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/demo-pack/pack.yml'),
      [
        'schema: 1',
        'id: demo.pack',
        'name: Demo Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Demo query pack.',
        'owners:',
        '  - maintainers',
        'tags:',
        '  - demo',
        'provides:',
        '  - query',
        'runs:',
        '  - tool: graph_diff',
        '    params:',
        '      limit: 5',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/demo-suite/suite.yml'),
      [
        'schema: 1',
        'id: suite.demo',
        'name: Demo Suite',
        'tier: experimental',
        'summary: Demo suite.',
        'packs:',
        '  - demo.pack',
      ].join('\n'),
      'utf8',
    );

    const catalog = await loadAnalysisCatalog(repoDir);

    expect(catalog.errors).toEqual([]);
    expect(catalog.packs).toHaveLength(1);
    expect(catalog.suites).toHaveLength(1);
    expect(catalog.packs[0]).toMatchObject({
      id: 'demo.pack',
      kind: 'query',
      tier: 'stable',
      manifestPath: 'ontoindex-packs/core/demo-pack/pack.yml',
    });
    expect(catalog.packs[0].runs).toEqual([{ tool: 'graph_diff', params: { limit: 5 } }]);
    expect(catalog.suites[0]).toMatchObject({
      id: 'suite.demo',
      tier: 'experimental',
      manifestPath: 'ontoindex-packs/suites/demo-suite/suite.yml',
    });
  });

  it('collects manifest validation errors without aborting discovery', async () => {
    const repoDir = await createTempRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/bad-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/good-pack'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/bad-pack/pack.yml'),
      ['schema: 1', 'name: Broken Pack'].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/good-pack/pack.yml'),
      [
        'schema: 1',
        'id: good.pack',
        'name: Good Pack',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Valid manifest.',
      ].join('\n'),
      'utf8',
    );

    const catalog = await loadAnalysisCatalog(repoDir);

    expect(catalog.packs).toHaveLength(1);
    expect(catalog.errors).toHaveLength(1);
    expect(catalog.errors[0]).toContain('ontoindex-packs/core/bad-pack/pack.yml');
  });

  it('preserves manifest parse error message coercion for non-Error thrown values', () => {
    expect(manifestErrorMessage({ message: 0 })).toBe('0');
    expect(manifestErrorMessage({ message: false })).toBe('false');
    expect(manifestErrorMessage({ message: null })).toBe('null');
    expect(manifestErrorMessage({ message: '' })).toBe('');
    expect(manifestErrorMessage({})).toBeUndefined();
    expect(manifestErrorMessage('plain')).toBeUndefined();
    expect(() => manifestErrorMessage(null)).toThrow(TypeError);
    expect(() => manifestErrorMessage(undefined)).toThrow(TypeError);
  });

  it('filters analysis catalog output by kind and tier', async () => {
    const repoDir = await createTempRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/query-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/model-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/demo-suite'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/query-pack/pack.yml'),
      [
        'schema: 1',
        'id: query.pack',
        'name: Query Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Query pack.',
        'runs: []',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/model-pack/pack.yml'),
      [
        'schema: 1',
        'id: model.pack',
        'name: Model Pack',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Model pack.',
        'runs: []',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/demo-suite/suite.yml'),
      [
        'schema: 1',
        'id: suite.demo',
        'name: Demo Suite',
        'tier: experimental',
        'summary: Demo suite.',
        'packs:',
        '  - model.pack',
      ].join('\n'),
      'utf8',
    );

    const result = await runAnalysisCatalog(
      { repoPath: repoDir },
      { kind: 'model', tier: 'experimental' },
    );

    expect(result.status).toBe('success');
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0].id).toBe('model.pack');
    expect(result.suites).toHaveLength(1);
    expect(result.suites[0].id).toBe('suite.demo');
    expect(result.counts.stablePacks).toBe(0);
    expect(result.counts.experimentalPacks).toBe(1);
  });

  it('returns execution plan when target is provided', async () => {
    const repoDir = await createTempRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/demo-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/demo-suite'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/demo-pack/pack.yml'),
      [
        'schema: 1',
        'id: demo.pack',
        'name: Demo Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Demo query pack.',
        'runs:',
        '  - tool: graph_diff',
        '    params:',
        '      limit: 3',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/demo-suite/suite.yml'),
      [
        'schema: 1',
        'id: suite.demo',
        'name: Demo Suite',
        'tier: stable',
        'summary: Demo suite.',
        'packs:',
        '  - demo.pack',
      ].join('\n'),
      'utf8',
    );

    const result = await runAnalysisCatalog({ repoPath: repoDir }, { target: 'suite.demo' });
    expect(result.target).toMatchObject({ type: 'suite', id: 'suite.demo' });
    expect(result.steps).toEqual([
      { packId: 'demo.pack', packName: 'Demo Pack', tool: 'graph_diff', params: { limit: 3 } },
    ]);
  });
});
