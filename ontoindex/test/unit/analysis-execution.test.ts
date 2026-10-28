import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureWorkspaceInputs } from '../../src/core/analyze-delta.js';
import {
  buildAnalysisExecutionPlan,
  getActiveComponentFilePatterns,
  getActiveModelPacks,
  getActiveORMClientIdentifiers,
  getActiveRouteFilePatterns,
} from '../../src/analysis-packs/execution.js';

describe('analysis execution planning', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function createRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-analysis-exec-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('keeps active model packs frozen after live catalog mutation, addition, and deletion', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'src'));
    await fs.writeFile(path.join(repoDir, 'src/main.ts'), 'export const value = 1;');
    await fs.writeFile(path.join(repoDir, '.ontoindexignore'), 'ontoindex-packs/\n');
    const directory = path.join(repoDir, 'ontoindex-packs/core/model');
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'pack.yml');
    const manifest = [
      'schema: 1',
      'id: core.frozen-model',
      'name: Frozen Model',
      'version: 0.1.0',
      'kind: model',
      'tier: stable',
      'summary: Captured model.',
      'provides: [route-models]',
      'routeFilePatterns: ["frozen/**/*.ts"]',
    ].join('\n');
    await fs.writeFile(filename, manifest);
    const captured = await captureWorkspaceInputs(repoDir, {
      includePaths: ['src/main.ts'],
      parserIdentity: 'test-parser-v1',
    });
    try {
      const frozen = await getActiveModelPacks(captured.captureRoot, ['route-models']);
      expect(frozen.map((pack) => pack.id)).toEqual(['core.frozen-model']);
      await fs.writeFile(filename, manifest.replace('core.frozen-model', 'core.changed-model'));
      expect((await getActiveModelPacks(repoDir)).map((pack) => pack.id)).toEqual([
        'core.changed-model',
      ]);
      expect(await getActiveModelPacks(captured.captureRoot, ['route-models'])).toEqual(frozen);
      const added = path.join(repoDir, 'ontoindex-packs/added');
      await fs.mkdir(added);
      await fs.writeFile(
        path.join(added, 'pack.yml'),
        manifest.replace('core.frozen-model', 'core.added-model'),
      );
      await fs.rm(filename);
      expect((await getActiveModelPacks(repoDir)).map((pack) => pack.id)).toEqual([
        'core.added-model',
      ]);
      expect(await getActiveModelPacks(captured.captureRoot, ['route-models'])).toEqual(frozen);
      expect(await getActiveRouteFilePatterns(captured.captureRoot)).toEqual(['frozen/**/*.ts']);
    } finally {
      await captured.dispose();
    }
  });

  it('expands suite manifests into ordered tool steps and model packs', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/query-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/model-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/review'), { recursive: true });

    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/query-pack/pack.yml'),
      [
        'schema: 1',
        'id: core.query-pack',
        'name: Query Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Query pack.',
        'runs:',
        '  - tool: graph_diff',
        '    params:',
        '      limit: 5',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/model-pack/pack.yml'),
      [
        'schema: 1',
        'id: core.model-pack',
        'name: Model Pack',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Model pack.',
        'provides:',
        '  - route-models',
        'runs: []',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/review/suite.yml'),
      [
        'schema: 1',
        'id: suite.review',
        'name: Review Suite',
        'tier: stable',
        'summary: Review suite.',
        'packs:',
        '  - core.query-pack',
        '  - core.model-pack',
      ].join('\n'),
      'utf8',
    );

    const plan = await buildAnalysisExecutionPlan(repoDir, 'suite.review');
    expect(plan.target).toMatchObject({ type: 'suite', id: 'suite.review' });
    expect(plan.packs.map((pack) => pack.id)).toEqual(['core.query-pack', 'core.model-pack']);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ packId: 'core.query-pack', tool: 'graph_diff' });
    expect(plan.modelPacks.map((pack) => pack.id)).toEqual(['core.model-pack']);
  });

  it('filters active model packs by capability', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/route-models'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/orm-models'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/route-models/pack.yml'),
      [
        'schema: 1',
        'id: core.route-models',
        'name: Route Models',
        'version: 0.1.0',
        'kind: model',
        'tier: stable',
        'summary: Route models.',
        'provides:',
        '  - route-models',
        'runs: []',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/orm-models/pack.yml'),
      [
        'schema: 1',
        'id: core.orm-models',
        'name: ORM Models',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: ORM models.',
        'provides:',
        '  - orm-models',
        'runs: []',
      ].join('\n'),
      'utf8',
    );

    const routePacks = await getActiveModelPacks(repoDir, ['route-models']);
    expect(routePacks.map((pack) => pack.id)).toEqual(['core.route-models']);
  });

  it('collects route file patterns from active route model packs', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/route-models'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/other-models'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/route-models/pack.yml'),
      [
        'schema: 1',
        'id: core.route-models',
        'name: Route Models',
        'version: 0.1.0',
        'kind: model',
        'tier: stable',
        'summary: Route models.',
        'provides:',
        '  - route-models',
        'routeFilePatterns:',
        '  - custom/**/*.php',
        'runs: []',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/other-models/pack.yml'),
      [
        'schema: 1',
        'id: core.other-models',
        'name: Other Models',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Other models.',
        'provides:',
        '  - orm-models',
        'routeFilePatterns:',
        '  - ignored/**/*.php',
        'runs: []',
      ].join('\n'),
      'utf8',
    );

    const patterns = await getActiveRouteFilePatterns(repoDir);
    expect(patterns).toEqual(['custom/**/*.php']);
  });

  it('collects component file patterns from active component model packs', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/component-models'), {
      recursive: true,
    });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/other-models'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/component-models/pack.yml'),
      [
        'schema: 1',
        'id: core.component-models',
        'name: Component Models',
        'version: 0.1.0',
        'kind: model',
        'tier: stable',
        'summary: Component models.',
        'provides:',
        '  - component-models',
        'componentFilePatterns:',
        '  - custom/**/*.js',
        'runs: []',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/other-models/pack.yml'),
      [
        'schema: 1',
        'id: core.other-models',
        'name: Other Models',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Other models.',
        'provides:',
        '  - route-models',
        'componentFilePatterns:',
        '  - ignored/**/*.js',
        'runs: []',
      ].join('\n'),
      'utf8',
    );

    const patterns = await getActiveComponentFilePatterns(repoDir);
    expect(patterns).toEqual(['custom/**/*.js']);
  });

  it('collects ORM client identifiers from active orm model packs', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/orm-models'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/other-models'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/orm-models/pack.yml'),
      [
        'schema: 1',
        'id: core.orm-models',
        'name: ORM Models',
        'version: 0.1.0',
        'kind: model',
        'tier: stable',
        'summary: ORM models.',
        'provides:',
        '  - orm-models',
        'prismaClientIdentifiers:',
        '  - db',
        'supabaseClientIdentifiers:',
        '  - adminDb',
        'runs: []',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/other-models/pack.yml'),
      [
        'schema: 1',
        'id: core.other-models',
        'name: Other Models',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Other models.',
        'provides:',
        '  - component-models',
        'prismaClientIdentifiers:',
        '  - ignoredDb',
        'supabaseClientIdentifiers:',
        '  - ignoredClient',
        'runs: []',
      ].join('\n'),
      'utf8',
    );

    const identifiers = await getActiveORMClientIdentifiers(repoDir);
    expect(identifiers).toEqual({
      prismaClientIdentifiers: ['db'],
      supabaseClientIdentifiers: ['adminDb'],
    });
  });
});
