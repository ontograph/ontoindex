import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from '../integration/resolvers/helpers.js';

describe.each([
  ['TypeScript', 'main.ts', 'function inherited(f: Foo)', 'function own(b: Baz)'],
  ['JavaScript', 'main.js', 'function inherited()', 'function own()'],
])('%s overload skip respects method owners', (_language, filename, inherited, own) => {
  let directory: string;
  let result: PipelineResult;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-overload-owner-'));
    await writeFile(
      path.join(directory, filename),
      `
class Base { greet() {} }
class Foo extends Base {}
class Baz { greet() {} }
${inherited} { ${filename.endsWith('.js') ? 'const f = new Foo();' : ''} f.greet(); }
${own} { ${filename.endsWith('.js') ? 'const b = new Baz();' : ''} b.greet(); }
`,
    );
    result = await runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['inherited', 'Base'],
    ['own', 'Baz'],
  ])('%s resolves only to its receiver hierarchy', (caller, owner) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'greet',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].rel.targetId).toContain(`${owner}.greet`);
  });
});

describe('genuine TypeScript overloads retain dispatch behavior', () => {
  let directory: string;
  let result: PipelineResult;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-overload-owner-'));
    await writeFile(
      path.join(directory, 'main.ts'),
      `
class Base { greet() {} }
class Foo extends Base {
  greet(value: string): void;
  greet(value: string, times: number): void;
  greet(value: string, times?: number) {}
}
class Baz { greet() {} }
function one(f: Foo) { f.greet('hello'); }
function two(f: Foo) { f.greet('hello', 2); }
`,
    );
    result = await runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['one', 1],
    ['two', 2],
  ])('%s preserves the master overload target', (caller, arity) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'greet',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].rel.targetId).toBe(`Method:main.ts:Foo.greet#${arity}`);
  });
});
