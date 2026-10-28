import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import lbug from '@ladybugdb/core';
import { expect, it, vi } from 'vitest';
import {
  evaluateWorkspacePair,
  readGraph,
  runWorkspacePairBenchmark,
} from '../../scripts/workspace-pair-benchmark.mjs';

const builtCli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

async function writeTinyGraph(file: string, statements: string[]) {
  const database = new lbug.Database(file, 0, true, false, 2 ** 32);
  const connection = new lbug.Connection(database);
  try {
    for (const statement of statements) {
      const response = await connection.query(statement);
      for (const result of Array.isArray(response) ? response : [response]) result.close();
    }
  } finally {
    try {
      await connection.close();
    } finally {
      await database.close();
    }
  }
}

function tinyGraphStatements(label = 'Function', reversed = false) {
  const tables = [
    `CREATE NODE TABLE ${label} (id STRING, isExported BOOLEAN, startLine INT64, endLine INT64, content STRING, PRIMARY KEY(id))`,
    'CREATE NODE TABLE Unused (id STRING, PRIMARY KEY(id))',
  ];
  const nodes = ['entry', 'helper'].map(
    (id) =>
      `CREATE (:${label} {id: '${id}', isExported: true, startLine: 1, endLine: 2, content: 'body'})`,
  );
  return [
    ...(reversed ? tables.reverse() : tables),
    `CREATE REL TABLE CodeRelation (FROM ${label} TO ${label}, type STRING, confidence DOUBLE, reason STRING, step INT64)`,
    ...(reversed ? nodes.reverse() : nodes),
    `MATCH (a:${label} {id: 'entry'}), (b:${label} {id: 'helper'}) CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.8, reason: 'resolved', step: 1}]->(b)`,
  ];
}

function graphPairEvaluation(full: any, replay: any) {
  return evaluateWorkspacePair(
    ['full', 'capture', 'replay'].map((kind, index) => ({
      kind,
      elapsedMs: 1,
      candidateComplete: true,
      base: {
        capability: 'workspace-graph',
        coverage: 'complete',
        parseErrorCount: 0,
        buildTimings: { parseMode: kind === 'replay' ? 'retained-replay' : 'full' },
        manifestDigest: 'a'.repeat(64),
        parserIdentity: 'b'.repeat(64),
        head: 'c'.repeat(40),
        configurationDigest: null,
        baseGenerationId: null,
      },
      graph: index === 2 ? replay : full,
    })),
  );
}

it('compares native graph properties while ignoring database table and insertion identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-pair-properties-'));
  const baselineFile = path.join(root, 'baseline.lbug');
  const relocatedFile = path.join(root, 'relocated.lbug');
  const relabeledFile = path.join(root, 'relabeled.lbug');
  try {
    await writeTinyGraph(baselineFile, tinyGraphStatements());
    await writeTinyGraph(relocatedFile, tinyGraphStatements('Function', true));
    await writeTinyGraph(relabeledFile, tinyGraphStatements('Class'));
    const baseline = await readGraph(baselineFile);
    const relocated = await readGraph(relocatedFile);
    expect(baseline.nodes).toHaveLength(2);
    expect(baseline.edges).toHaveLength(1);
    expect(graphPairEvaluation(baseline, relocated)).toEqual({ passed: true, failures: [] });
    expect(graphPairEvaluation(baseline, await readGraph(relabeledFile)).failures).toContain(
      'replay graph parity mismatch',
    );

    for (const [field, changed, original] of [
      ['isExported', 'false', 'true'],
      ['startLine', '3', '1'],
      ['endLine', '4', '2'],
      ['content', "'different body'", "'body'"],
    ]) {
      const update = (value: string) =>
        `MATCH (n:Function {id: 'entry'}) SET n.${field} = ${value}`;
      await writeTinyGraph(relocatedFile, [update(changed)]);
      expect(
        graphPairEvaluation(baseline, await readGraph(relocatedFile)).failures,
        field,
      ).toContain('replay graph parity mismatch');
      await writeTinyGraph(relocatedFile, [update(original)]);
    }
    for (const [field, changed, original] of [
      ['confidence', '0.9', '0.8'],
      ['reason', "'different reason'", "'resolved'"],
      ['step', '2', '1'],
    ]) {
      const update = (value: string) => `MATCH ()-[r:CodeRelation]->() SET r.${field} = ${value}`;
      await writeTinyGraph(relocatedFile, [update(changed)]);
      expect(
        graphPairEvaluation(baseline, await readGraph(relocatedFile)).failures,
        field,
      ).toContain('replay graph parity mismatch');
      await writeTinyGraph(relocatedFile, [update(original)]);
    }
    expect(graphPairEvaluation(baseline, await readGraph(relocatedFile))).toEqual({
      passed: true,
      failures: [],
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('benchmarks an actual compiled full/full/replay pair and persists both reports', async () => {
  expect(existsSync(builtCli), 'Build the package before running the workspace pair smoke').toBe(
    true,
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-pair-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const outputDir = path.join(root, 'reports');
  const previousExitCode = process.exitCode;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    await fs.writeFile(path.join(repo, 'src/util.ts'), 'export function helper() { return 1; }\n');
    await fs.writeFile(
      path.join(repo, 'src/main.ts'),
      "import { helper } from './util';\nexport function entry() { return helper(); }\n",
    );
    git('init', '-q');
    await fs.appendFile(path.join(repo, '.git/info/exclude'), '\n.ontoindex/\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'baseline',
    );

    const record = await runWorkspacePairBenchmark({
      repo,
      cli: 'built',
      pairs: 1,
      timeoutMs: 120_000,
      maxPeakRssMib: null,
      sampleMs: 100,
      outputDir,
      runId: 'fixture',
      label: 'tiny-fixture',
      dryRun: false,
    });
    expect(record.outcome).toMatchObject({ result: 'passed', exitCode: 0 });
    expect(record.pairs).toHaveLength(1);
    expect(record.pairs[0].evaluation).toEqual({ passed: true, failures: [] });
    const legs = record.pairs[0].legs;
    expect(legs.map((leg: any) => leg.kind)).toEqual(['full', 'capture', 'replay']);
    expect(legs.map((leg: any) => leg.base.buildTimings.parseMode)).toEqual([
      'full',
      'full',
      'retained-replay',
    ]);
    expect(legs[0].graph.nodes.count).toBeGreaterThan(0);
    expect(legs[0].graph.edges.count).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.base).toMatchObject({
        capability: 'workspace-graph',
        coverage: 'complete',
        parseErrorCount: 0,
      });
      expect(leg.graph).toEqual(legs[0].graph);
      expect(Number.isFinite(leg.elapsedMs)).toBe(true);
      expect(leg.memory).toMatchObject({ method: 'linux-proc-process-tree-rss', sampleMs: 100 });
      expect(Number.isInteger(leg.memory.failedSamples)).toBe(true);
      expect(leg.memory.failedSamples).toBeGreaterThanOrEqual(0);
      expect(leg.memory.sampleCount).toBeGreaterThan(0);
      expect(leg.memory.peakMemory.totalRssKiB).toBeGreaterThan(0);
      expect(leg.memory.peakMemory.rootRssKiB).toBeGreaterThan(0);
    }
    const reuse = record.pairs[0].reuse;
    expect(reuse).toMatchObject({
      method: 'getOverlaySnapshot',
      generation: legs[2].generation,
      manifestDigest: legs[2].base.manifestDigest,
      baseGenerationId: legs[2].base.baseGenerationId,
      currentHead: legs[2].base.head,
    });
    expect(Number.isFinite(reuse.elapsedMs)).toBe(true);
    expect(reuse.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(record.summary.publishedValidationMs).toEqual({
      median: reuse.elapsedMs,
      min: reuse.elapsedMs,
      max: reuse.elapsedMs,
    });
    expect((await fs.readFile(path.join(repo, '.ontoindex/overlay/CURRENT'), 'utf8')).trim()).toBe(
      legs[2].generation,
    );
    const persisted = JSON.parse(await fs.readFile(record.artifacts.jsonPath, 'utf8'));
    expect(persisted.outcome).toEqual(record.outcome);
    expect(persisted.pairs).toEqual(record.pairs);
    const markdown = await fs.readFile(record.artifacts.markdownPath, 'utf8');
    expect(markdown).toContain('fixture');
    expect(markdown).toContain('retained-replay');
    expect(markdown).toMatch(/published.*validation/i);
    expect(git('status', '--porcelain')).toBe('');
    console.log('workspace pair published validation', JSON.stringify(reuse));
    console.log(
      'workspace pair compiled smoke',
      JSON.stringify(
        legs.map((leg: any) => ({
          kind: leg.kind,
          parseMode: leg.base.buildTimings.parseMode,
          graph: leg.graph,
          elapsedMs: leg.elapsedMs,
          memory: leg.memory,
        })),
      ),
    );
  } finally {
    process.exitCode = previousExitCode;
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 300_000);
