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
    'follows export-star barrels in %s',
    async (ext) => {
      const result = await ingest({
        [`models/base.${ext}`]: 'export class Base { greet() {} }',
        [`models/index.${ext}`]: "export * from './base';",
        [`other.${ext}`]: 'export class Base { greet() {} }',
        [`app.${ext}`]: `import * as models from './models';
export class Child extends models.Base { inherited() { this.greet(); } }`,
      });
      expect(getRelationships(result, 'EXTENDS').map(({ rel }) => rel.targetId)).toEqual([
        `Class:models/base.${ext}:Base`,
      ]);
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.target === 'greet')
          .map(({ rel }) => rel.targetId),
      ).toEqual([`Method:models/base.${ext}:Base.greet#0`]);
    },
    60000,
  );

  it.each(['ts', 'js'])(
    'follows nested namespace reexports in %s',
    async (ext) => {
      const result = await ingest({
        [`deep/inner/leaf.${ext}`]: 'export class Leaf { greet() {} }',
        [`deep/index.${ext}`]: "export * as inner from './inner/leaf';",
        [`other.${ext}`]: 'export class Leaf { greet() {} }',
        [`app.${ext}`]: `import * as deep from './deep';
export class Child extends deep.inner.Leaf { inherited() { this.greet(); } }`,
      });
      expect(getRelationships(result, 'EXTENDS').map(({ rel }) => rel.targetId)).toEqual([
        `Class:deep/inner/leaf.${ext}:Leaf`,
      ]);
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.target === 'greet')
          .map(({ rel }) => rel.targetId),
      ).toEqual([`Method:deep/inner/leaf.${ext}:Leaf.greet#0`]);
    },
    60000,
  );

  it.each(['ts', 'js'])(
    'follows locally reexported namespaces in %s',
    async (ext) => {
      const result = await ingest({
        [`models/base.${ext}`]: 'export class Base { greet() {} }',
        [`models/index.${ext}`]: "export * from './base';",
        [`reexp.${ext}`]: "import * as models from './models'; export { models };",
        [`other.${ext}`]: 'export class Base { greet() {} }',
        [`app.${ext}`]: `import { models } from './reexp';
export class Child extends models.Base { inherited() { this.greet(); } }`,
      });
      expect(getRelationships(result, 'EXTENDS').map(({ rel }) => rel.targetId)).toEqual([
        `Class:models/base.${ext}:Base`,
      ]);
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.target === 'greet')
          .map(({ rel }) => rel.targetId),
      ).toEqual([`Method:models/base.${ext}:Base.greet#0`]);
    },
    60000,
  );

  it.each(['ts', 'js'])(
    'does not guess default-object members in %s',
    async (ext) => {
      const result = await ingest({
        [`models/base.${ext}`]: 'export class Base { greet() {} }',
        [`models/other.${ext}`]: 'class Base { greet() {} } export default { Base };',
        [`app.${ext}`]: `import M from './models/other';
export class Child extends M.Base { inherited() { this.greet(); } }`,
      });
      expect(getRelationships(result, 'CALLS').filter((edge) => edge.target === 'greet')).toEqual(
        [],
      );
      for (const { rel } of getRelationships(result, 'EXTENDS')) {
        expect(result.graph.getNode(rel.targetId)).toBeUndefined();
      }
    },
    60000,
  );

  it('deduplicates cyclic diamond barrels and honors explicit named exports', async () => {
    const result = await ingest({
      'base.ts': 'export class Base { greet() {} }',
      'other.ts': 'export class Base { greet() {} }',
      'left.ts': "export * from './base'; export * from './index';",
      'right.ts': "export * from './base';",
      'index.ts': "export * from './left'; export * from './right';",
      'override.ts': "export * from './other'; export { Base } from './base';",
      'app.ts': `import * as diamond from './index';
import * as explicit from './override';
export class Diamond extends diamond.Base { inherited() { this.greet(); } }
export class Explicit extends explicit.Base { inherited() { this.greet(); } }`,
    });
    expect(getRelationships(result, 'EXTENDS').map(({ rel }) => rel.targetId)).toEqual([
      'Class:base.ts:Base',
      'Class:base.ts:Base',
    ]);
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.target === 'greet')
        .map(({ rel }) => rel.targetId),
    ).toEqual(['Method:base.ts:Base.greet#0', 'Method:base.ts:Base.greet#0']);
  }, 60000);

  it.each([
    ['conflicting stars', "export * from './base'; export * from './other';", 'models.Base'],
    [
      'private namespace',
      "import * as inner from './base'; export class Other {}",
      'models.inner.Base',
    ],
    ['ordinary import', "import { Base } from './base'; export class Other {}", 'models.Missing'],
    ['missing nested member', "export * as inner from './base';", 'models.inner.Missing'],
    ['empty cycle', "export * from './cycle';", 'models.Base'],
  ])(
    'fails closed for %s',
    async (_case, barrel, parent) => {
      const result = await ingest({
        'base.ts': 'export class Base { greet() {} }',
        'other.ts': 'export class Base { greet() {} }',
        'index.ts': barrel,
        'cycle.ts': "export * from './index';",
        'app.ts': `import * as models from './index';
export class Child extends ${parent} { inherited() { this.greet(); } }`,
      });
      expect(getRelationships(result, 'CALLS').filter((edge) => edge.target === 'greet')).toEqual(
        [],
      );
      for (const { rel } of getRelationships(result, 'EXTENDS')) {
        expect(result.graph.getNode(rel.targetId)).toBeUndefined();
      }
    },
    60000,
  );

  it('follows aliased local namespace reexports through named barrels', async () => {
    const result = await ingest({
      'base.ts': 'export class Base { greet() {} }',
      'other.ts': 'export class Base { greet() {} }',
      'local.ts': "import * as ns from './base'; export { ns as models };",
      'index.ts': "export { models as exported } from './local';",
      'app.ts': `import { exported as models } from './index';
export class Child extends models.Base { inherited() { this.greet(); } }`,
    });
    expect(getRelationships(result, 'EXTENDS').map(({ rel }) => rel.targetId)).toEqual([
      'Class:base.ts:Base',
    ]);
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.target === 'greet')
        .map(({ rel }) => rel.targetId),
    ).toEqual(['Method:base.ts:Base.greet#0']);
  }, 60000);

  it('preserves five named barrel hops after the initial namespace import', async () => {
    const files: Record<string, string> = {
      'base.ts': 'export class Base { greet() {} }',
      'other.ts': 'export class Base { greet() {} }',
      'app.ts': `import * as models from './hop0';
export class Child extends models.Base { inherited() { this.greet(); } }`,
    };
    for (let i = 0; i < 5; i++) {
      files[`hop${i}.ts`] = `export { Base } from './${i === 4 ? 'base' : `hop${i + 1}`}';`;
    }
    const result = await ingest(files);
    expect(getRelationships(result, 'EXTENDS').map(({ rel }) => rel.targetId)).toEqual([
      'Class:base.ts:Base',
    ]);
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.target === 'greet')
        .map(({ rel }) => rel.targetId),
    ).toEqual(['Method:base.ts:Base.greet#0']);
  }, 60000);

  it.each(['depth', 'breadth'])(
    'fails closed at the namespace traversal %s bound',
    async (bound) => {
      const files: Record<string, string> = {
        'base.ts': 'export class Base { greet() {} }',
        'app.ts': `import * as models from './index';
export class Child extends models.Base { inherited() { this.greet(); } }`,
      };
      if (bound === 'depth') {
        files['index.ts'] = "export * from './hop0';";
        for (let i = 0; i < 6; i++) {
          files[`hop${i}.ts`] = `export * from './${i === 5 ? 'base' : `hop${i + 1}`}';`;
        }
      } else {
        files['index.ts'] =
          "export * from './base';\n" +
          Array.from({ length: 65 }, (_, i) => {
            files[`empty${i}.ts`] = 'export class Other {}';
            return `export * from './empty${i}';`;
          }).join('\n');
      }
      const result = await ingest(files);
      expect(getRelationships(result, 'CALLS').filter((edge) => edge.target === 'greet')).toEqual(
        [],
      );
      for (const { rel } of getRelationships(result, 'EXTENDS')) {
        expect(result.graph.getNode(rel.targetId)).toBeUndefined();
      }
    },
    60000,
  );

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
