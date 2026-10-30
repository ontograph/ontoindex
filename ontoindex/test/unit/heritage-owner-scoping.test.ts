import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo } from '../integration/resolvers/helpers.js';

describe('heritage owner scoping', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function inheritedTargets(files: Record<string, string>, caller: string) {
    const directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-heritage-owner-'));
    directories.push(directory);
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), source);
    }
    const result = await runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
    return getRelationships(result, 'CALLS')
      .filter((edge) => edge.source === caller && edge.target === 'greet')
      .map((edge) => edge.rel.targetId);
  }

  const typescript = `
export class Base { greet() {} }
export class Foo extends Base { only_foo() {} }
export function t_inh(f: Foo) { f.greet(); }
`;
  const python = `
class Base:
    def greet(self):
        pass
class Foo(Base):
    def only_foo(self):
        pass
def p_inh(f: Foo):
    f.greet()
`;

  it('keeps TypeScript ancestry in its declaring language and file', async () => {
    expect(await inheritedTargets({ 'a.ts': typescript, 'b.py': python }, 't_inh')).toEqual([
      'Method:a.ts:Base.greet#0',
    ]);
  }, 60000);

  it('keeps Python ancestry in its declaring language and file', async () => {
    expect(await inheritedTargets({ 'a.ts': typescript, 'b.py': python }, 'p_inh')).toEqual([
      'Function:b.py:Base.greet',
    ]);
  }, 60000);

  it('uses the imported parent when another module declares the same name', async () => {
    expect(
      await inheritedTargets(
        {
          'x/base.ts': 'export class Base { greet() {} }',
          'y/base.ts': 'export class Base { greet() {} }',
          'x/foo.ts': `import { Base } from './base';
export class Foo extends Base {}
export function t_inh(f: Foo) { f.greet(); }`,
        },
        't_inh',
      ),
    ).toEqual(['Method:x/base.ts:Base.greet#0']);
  }, 60000);
  it('shares C# partial-class ancestry across declaring files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-heritage-owner-'));
    directories.push(directory);
    const files: Record<string, string> = {
      'Base.cs': 'namespace N { public class Base { public void Greet() {} } }',
      'FooA.cs': 'namespace N { public partial class Foo : Base { } }',
      'FooB.cs': 'namespace N { public partial class Foo { public void Run() { this.Greet(); } } }',
    };
    for (const [file, source] of Object.entries(files)) {
      await writeFile(path.join(directory, file), source);
    }
    const result = await runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.source === 'Run' && edge.target === 'Greet')
        .map((edge) => edge.rel.targetId),
    ).toEqual(['Method:Base.cs:Base.Greet#0']);
  }, 60000);
});
