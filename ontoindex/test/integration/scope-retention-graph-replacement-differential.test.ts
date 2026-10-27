import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodeIds: graph.nodes.map(({ id }) => id).sort(),
    calls: graph.relationships
      .filter(({ type }) => type === 'CALLS')
      .map((edge) => JSON.stringify(edge))
      .sort(),
  };
}

describe.sequential('file removal versus independent full pipeline oracles', () => {
  const directories: string[] = [];
  const callee = 'src/callee.ts';

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture(call = 'helper') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-replacement-differential-'));
    directories.push(directory);
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, callee), 'export function helper() {}\n');
    fs.writeFileSync(
      path.join(directory, 'src/clean.ts'),
      `import { ${call} } from './callee';\nexport function clean() { ${call}(); }\n`,
    );
    fs.writeFileSync(
      path.join(directory, 'src/other.ts'),
      'function local() {}\nexport function other() { local(); }\n',
    );
    return directory;
  }

  async function fullRun(directory: string) {
    const result = await runPipelineFromRepo(directory, () => {}, {
      skipWorkers: true,
      skipGraphPhases: true,
    });
    expect(result.usedWorkerPool).toBe(false);
    return result.graph;
  }

  function functionId(graph: KnowledgeGraph, filePath: string, name: string) {
    const node = graph.nodes.find(
      (candidate) =>
        candidate.label === 'Function' &&
        candidate.properties.filePath === filePath &&
        candidate.properties.name === name,
    );
    expect(node, `${filePath}:${name}`).toBeDefined();
    return node!.id;
  }

  // A set equation specifies replacement obligations; it does not implement replay.
  function compareReplacement(graph: KnowledgeGraph, oracle: KnowledgeGraph, affected: string[]) {
    const actual = snapshot(graph);
    const expected = snapshot(oracle);
    const retainedNodes = new Set(actual.nodeIds);
    const oracleNodes = new Set(expected.nodeIds);
    expect(actual.nodeIds.filter((id) => !oracleNodes.has(id))).toEqual([]);
    const replacementNodes = oracle.nodes.filter(({ id }) => !retainedNodes.has(id));
    expect(replacementNodes.every(({ properties }) => properties.filePath === callee)).toBe(true);
    expect([...actual.nodeIds, ...replacementNodes.map(({ id }) => id)].sort()).toEqual(
      expected.nodeIds,
    );

    const replaySources = new Set([
      ...affected,
      ...oracle.nodes
        .filter(({ properties }) => properties.filePath === callee)
        .map(({ id }) => id),
    ]);
    const untouched = graph.relationships
      .filter((edge) => edge.type === 'CALLS' && !replaySources.has(edge.sourceId))
      .map((edge) => JSON.stringify(edge))
      .sort();
    const oracleCalls = new Set(expected.calls);
    expect(untouched.filter((edge) => !oracleCalls.has(edge))).toEqual([]);
    const untouchedSet = new Set(untouched);
    const requiredReplay = expected.calls.filter((edge) => !untouchedSet.has(edge));
    const oracleReplay = oracle.relationships
      .filter((edge) => edge.type === 'CALLS' && replaySources.has(edge.sourceId))
      .map((edge) => JSON.stringify(edge))
      .sort();
    expect(requiredReplay).toEqual(oracleReplay);
    expect({ nodeIds: expected.nodeIds, calls: [...untouched, ...requiredReplay].sort() }).toEqual(
      expected,
    );
    return requiredReplay;
  }

  it('editing a callee preserves unrelated calls and identifies the caller replay obligation', async () => {
    const directory = fixture();
    const graph = await fullRun(directory);
    const clean = functionId(graph, 'src/clean.ts', 'clean');
    const other = functionId(graph, 'src/other.ts', 'other');
    const helper = functionId(graph, callee, 'helper');
    const removed = graph.removeNodesByFiles([callee]);
    expect(removed.affectedSourceIds).toContain(clean);
    expect(removed.affectedSourceIds).not.toContain(other);
    fs.writeFileSync(
      path.join(directory, callee),
      '\nexport function helper() {\n  helper();\n}\n',
    );
    const oracle = await fullRun(directory);
    expect(functionId(oracle, callee, 'helper')).toBe(helper);
    const replay = compareReplacement(graph, oracle, removed.affectedSourceIds);
    expect(replay).toContain(
      JSON.stringify(
        oracle.relationships.find(
          (edge) => edge.type === 'CALLS' && edge.sourceId === clean && edge.targetId === helper,
        ),
      ),
    );
  }, 90_000);

  it('deleting a callee leaves no dangling relationships and matches the full-run call set', async () => {
    const directory = fixture();
    const graph = await fullRun(directory);
    const clean = functionId(graph, 'src/clean.ts', 'clean');
    const helper = functionId(graph, callee, 'helper');
    const removed = graph.removeNodesByFiles([callee]);
    const remaining = new Set(graph.nodes.map(({ id }) => id));
    expect(
      graph.relationships.every(
        ({ sourceId, targetId }) => remaining.has(sourceId) && remaining.has(targetId),
      ),
    ).toBe(true);
    fs.unlinkSync(path.join(directory, callee));
    const oracle = await fullRun(directory);
    expect(
      oracle.relationships.filter(
        (edge) => edge.type === 'CALLS' && edge.sourceId === clean && edge.targetId === helper,
      ),
    ).toEqual([]);
    compareReplacement(graph, oracle, removed.affectedSourceIds);
    expect(snapshot(graph)).toEqual(snapshot(oracle));
  }, 90_000);

  it('documents the gap: unresolved callers are absent from affectedSourceIds when an export appears', async () => {
    const directory = fixture('missing');
    const graph = await fullRun(directory);
    const clean = functionId(graph, 'src/clean.ts', 'clean');
    expect(
      graph.relationships.filter((edge) => edge.type === 'CALLS' && edge.sourceId === clean),
    ).toEqual([]);
    const removed = graph.removeNodesByFiles([callee]);
    expect(removed.affectedSourceIds).not.toContain(clean);
    fs.writeFileSync(
      path.join(directory, callee),
      'export function helper() {}\nexport function missing() {}\n',
    );
    const oracle = await fullRun(directory);
    const missing = functionId(oracle, callee, 'missing');
    expect(
      oracle.relationships.some(
        (edge) => edge.type === 'CALLS' && edge.sourceId === clean && edge.targetId === missing,
      ),
    ).toBe(true);
    // Replacement must additionally replay unresolved callers; removal evidence alone cannot find them.
    const replay = compareReplacement(graph, oracle, [...removed.affectedSourceIds, clean]);
    expect(replay).toHaveLength(1);
  }, 90_000);
});
