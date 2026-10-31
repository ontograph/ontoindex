import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo } from '../integration/resolvers/helpers.js';

describe('namespace-qualified heritage', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function ingest(files: Record<string, string>) {
    const directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-namespace-heritage-'));
    directories.push(directory);
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), source);
    }
    return runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
  }

  it.each(['ts', 'js'])(
    'resolves exact EXTENDS and inherited CALLS owners in %s',
    async (ext) => {
      const result = await ingest({
        [`left/base.${ext}`]: 'export class Base { greet() {} }',
        [`right/base.${ext}`]: 'export class Base { greet() {} }',
        [`app.${ext}`]: `import * as left from './left/base.${ext}';
import * as right from './right/base.${ext}';
export class Left extends left . Base {}
export class Right extends right.Base {}
export function leftCall() { const f = new Left(); f.greet(); }
export function rightCall() { const f = new Right(); f.greet(); }`,
      });
      expect(
        getRelationships(result, 'EXTENDS')
          .map(({ rel }) => [rel.sourceId, rel.targetId])
          .sort(),
      ).toEqual([
        [`Class:app.${ext}:Left`, `Class:left/base.${ext}:Base`],
        [`Class:app.${ext}:Right`, `Class:right/base.${ext}:Base`],
      ]);
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.target === 'greet')
          .map(({ rel }) => [rel.sourceId, rel.targetId])
          .sort(),
      ).toEqual([
        [`Function:app.${ext}:leftCall`, `Method:left/base.${ext}:Base.greet#0`],
        [`Function:app.${ext}:rightCall`, `Method:right/base.${ext}:Base.greet#0`],
      ]);
    },
    60000,
  );

  it('follows an aliased named barrel reexport', async () => {
    const result = await ingest({
      'base.ts': 'export class Original { greet() {} }',
      'index.ts': "export { Original as Base } from './base';",
      'other.ts': 'export class Base { greet() {} }',
      'app.ts': `import * as models from './index';
export class Child extends models.Base {}
export function inherited() { const f = new Child(); f.greet(); }`,
    });
    expect(
      getRelationships(result, 'EXTENDS').map(({ rel }) => [rel.sourceId, rel.targetId]),
    ).toEqual([['Class:app.ts:Child', 'Class:base.ts:Original']]);
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.target === 'greet')
        .map(({ rel }) => [rel.sourceId, rel.targetId]),
    ).toEqual([['Function:app.ts:inherited', 'Method:base.ts:Original.greet#0']]);
  }, 60000);

  it.each(['ts', 'js'])(
    'fails closed for missing aliases and members in %s',
    async (ext) => {
      const result = await ingest({
        [`empty.${ext}`]: 'export class Other {}',
        [`other.${ext}`]: 'export class Base { greet() {} }',
        [`app.${ext}`]: `import * as models from './empty.${ext}';
export class Base { greet() {} }
export class MissingAlias extends unknown.Base {}
export class MissingMember extends models.Base {}
export function aliasCall() { const f = new MissingAlias(); f.greet(); }
export function memberCall() { const f = new MissingMember(); f.greet(); }`,
      });
      const extendsEdges = getRelationships(result, 'EXTENDS');
      expect(extendsEdges.map(({ rel }) => [rel.sourceId, rel.targetId]).sort()).toEqual([
        [`Class:app.${ext}:MissingAlias`, 'Class:unknown.Base'],
        [`Class:app.${ext}:MissingMember`, 'Class:models.Base'],
      ]);
      for (const { rel } of extendsEdges) {
        expect(result.graph.getNode(rel.targetId)).toBeUndefined();
      }
      expect(getRelationships(result, 'CALLS').filter((edge) => edge.target === 'greet')).toEqual(
        [],
      );
    },
    60000,
  );
});
