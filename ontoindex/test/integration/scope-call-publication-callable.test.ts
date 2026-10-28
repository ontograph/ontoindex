import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

// Registry-primary must keep the caller->f edge for `const f = <callable>` (previously lost because
// the Function definition had no graph-node correspondence).
describe.each([
  { extension: 'ts', flag: 'REGISTRY_PRIMARY_TYPESCRIPT' },
  { extension: 'js', flag: 'REGISTRY_PRIMARY_JAVASCRIPT' },
])('callable const CALLS under $flag', ({ extension, flag }) => {
  const shapes: Record<string, string> = {
    arrow: 'const f = (x) => x;\nfunction caller() { return f(1); }\n',
    expression: 'const f = function (x) { return x; };\nfunction caller() { return f(1); }\n',
    exported: 'export const f = (x) => x;\nexport function caller() { return f(1); }\n',
    named: 'const f = function inner(x) { return x; };\nfunction caller() { return f(1); }\n',
    shadow: 'const f = (x) => x;\nfunction caller() { const f = 1; return f(1); }\n',
  };

  it.each(Object.keys(shapes))('%s', async (shape) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ontoindex-callable-${shape}-`));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"callable-fixture"}');
    fs.writeFileSync(path.join(directory, `${shape}.${extension}`), shapes[shape]!);
    const edges = async (value: string) => {
      vi.stubEnv(flag, value);
      try {
        const result = await runPipelineFromRepo(directory, () => {}, {
          skipGraphPhases: true,
          skipWorkers: true,
        });
        const node = (name: string) =>
          result.graph.nodes.find(
            ({ properties, label }) =>
              properties.name === name &&
              properties.filePath === `${shape}.${extension}` &&
              label === 'Function',
          );
        const caller = node('caller');
        const callee = node('f');
        expect(caller).toBeDefined();
        expect(callee).toBeDefined();
        return result.graph.relationships.filter(
          (edge) =>
            edge.type === 'CALLS' && edge.sourceId === caller!.id && edge.targetId === callee!.id,
        ).length;
      } finally {
        vi.unstubAllEnvs();
      }
    };
    const registry = await edges('1');
    // A non-callable inner `f` shadows the arrow: the registry path correctly emits no edge.
    expect(registry).toBe(shape === 'shadow' ? 0 : 1);
  });
});
