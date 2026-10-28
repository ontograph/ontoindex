import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedFile } from 'ontoindex-shared';
import {
  ScopeRetentionStage,
  type ScopeRetentionFamily,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import { decodeParsedFileRecord } from '../../src/core/ingestion/pipeline-phases/parse-scope-codec.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';

const identity = {
  sourceManifestDigest: 'a'.repeat(64),
  targetCommit: 'head',
  baseGenerationId: null,
};
const directories: string[] = [];
const stages: ScopeRetentionStage[] = [];

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-candidate-test-'));
  directories.push(directory);
  const request = {
    deadline: Date.now() + 60_000,
    artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
  };
  const stage = new ScopeRetentionStage(request);
  stages.push(stage);
  return { directory, request, stage };
}

function fixture(): ParsedFile {
  return {
    filePath: 'one.ts',
    moduleScope: 'module',
    parsedImports: [],
    localDefs: [],
    referenceSites: [],
    scopes: [
      {
        id: 'module',
        parent: null,
        kind: 'Module',
        filePath: 'one.ts',
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
        bindings: new Map(),
        typeBindings: new Map([
          [
            'x',
            {
              rawName: 'User',
              declaredAtScope: 'module',
              source: 'annotation',
            },
          ],
        ]),
        ownedDefs: [],
        imports: [],
      },
    ],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stage of stages.splice(0)) await stage.dispose();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('scope retention candidate persistence', () => {
  it('persists canonical discovery independently of an incomplete parser inventory', async () => {
    const { directory, request, stage } = await setup();
    stage.captureDiscovery(
      ['src/example.ts', 'package.json'],
      [
        { path: 'src/example.ts', size: 1 },
        { path: 'package.json', size: 2 },
      ],
      [{ path: 'large.py', size: 100_000_000 }],
    );
    const manifest = await persistScopeRetentionCandidate(stage, directory, identity, request);
    expect(manifest.retention.discovery).toEqual({
      allPaths: ['package.json', 'src/example.ts'],
      scanned: [
        { path: 'package.json', language: null },
        { path: 'src/example.ts', language: 'typescript' },
      ],
      skipped: [{ path: 'large.py', size: 100_000_000 }],
    });
    expect(manifest.retention.inventory).toEqual([]);
    expect(manifest.seedReady).toBe(false);
  });

  it('persists codec maps, hashes all sixteen families, and charges exact bytes after stage disposal', async () => {
    const { directory, request, stage } = await setup();
    const initialAllowance = request.artifactAllowance.remainingBytes;
    const file = fixture();
    stage.capture([file]);
    stage.captureORMQueries([
      { filePath: file.filePath, orm: 'prisma', model: 'user', method: 'findMany', lineNumber: 0 },
      {
        filePath: file.filePath,
        orm: 'supabase',
        model: 'posts',
        method: 'select',
        lineNumber: 12,
      },
    ]);
    stage.recordOutcomes([{ filePath: file.filePath, status: 'success' }]);
    stage.reconcile([file.filePath]);
    await stage.flush();
    stage.captureGraphNode({
      id: 'file',
      label: 'File',
      properties: { name: 'one.ts', filePath: 'one.ts' },
    });
    stage.markGraphNodesCaptured();
    stage.markGraphRelationshipsCaptured();
    const manifest = await persistScopeRetentionCandidate(stage, directory, identity, request);
    expect(manifest).toMatchObject({
      status: 'candidate',
      seedReady: false,
      evidenceScope: 'observed-parser-inputs',
    });
    expect(manifest.version).toBe(5);
    expect(manifest.families).toHaveLength(16);
    expect(manifest.families.find((family) => family.name === 'orm-queries')).toMatchObject({
      name: 'orm-queries',
      recordCount: 2,
    });
    expect(manifest.coverage).toEqual(
      summarizeScopeRetentionCoverage(manifest.retention.inventory),
    );
    expect(manifest.coverage).toEqual({
      version: 1,
      languages: [
        {
          language: 'typescript',
          files: 1,
          retained: 1,
          skipped: 0,
          refused: 0,
          unaccounted: 0,
          unparsed: 0,
          refusalReasons: [],
        },
      ],
      complete: true,
    });
    const candidate = path.join(directory, 'scope-retention-candidate');
    const savedManifest = await fs.readFile(path.join(candidate, 'manifest.json'));
    expect(
      (await fs.readFile(path.join(candidate, 'orm-queries.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { filePath: file.filePath, orm: 'prisma', model: 'user', method: 'findMany', lineNumber: 0 },
      {
        filePath: file.filePath,
        orm: 'supabase',
        model: 'posts',
        method: 'select',
        lineNumber: 12,
      },
    ]);
    expect(JSON.parse(savedManifest.toString())).toEqual(manifest);
    let bytes = savedManifest.length;
    for (const family of manifest.families) {
      const data = await fs.readFile(path.join(candidate, family.fileName));
      expect(family.bytes).toBe(data.length);
      expect(family.sha256).toBe(createHash('sha256').update(data).digest('hex'));
      expect(family.recordCount).toBe(
        data.length ? data.toString().trimEnd().split('\n').length : 0,
      );
      bytes += data.length;
    }
    expect(manifest.artifactBytes).toBe(bytes);
    expect(manifest.totalBytes).toBe(bytes);
    const restored = decodeParsedFileRecord(
      await fs.readFile(path.join(candidate, 'parsed-files.jsonl'), 'utf8'),
    );
    expect(restored).toEqual(file);
    expect(restored.scopes[0]!.typeBindings).toBeInstanceOf(Map);
    expect((await fs.stat(candidate)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(candidate, 'manifest.json'))).mode & 0o777).toBe(0o600);
    await stage.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(initialAllowance - bytes);
  });

  it('preserves incomplete evidence without claiming readiness and supports no commit', async () => {
    const { directory, request, stage } = await setup();
    const manifest = await persistScopeRetentionCandidate(
      stage,
      directory,
      { ...identity, targetCommit: '' },
      request,
    );
    expect(manifest.retention.status).toBe('incomplete');
    expect(manifest.coverage).toEqual({ version: 1, languages: [], complete: false });
    expect(manifest.seedReady).toBe(false);
    expect(manifest.retention.inputEvidence.complete).toBe(false);
    expect(Object.values(manifest.retention.producerCompletion)).toEqual(Array(16).fill(false));
  });

  it('persists and verifies a manifest above 1 MiB for a large workspace inventory', async () => {
    const { directory, request, stage } = await setup();
    // A real 7033-file workspace produced 1.44 MB of inventory and input-evidence metadata.
    const paths = Array.from(
      { length: 7000 },
      (_, index) => `pkg/${'d'.repeat(180)}/file${index}.ts`,
    );
    stage.recordOutcomes(
      paths.map((filePath) => ({
        filePath,
        status: 'failed' as const,
        reason: 'unsupported-syntax',
      })),
    );
    stage.reconcile(paths);
    await stage.flush();
    const manifest = await persistScopeRetentionCandidate(stage, directory, identity, request);
    const bytes = (
      await fs.stat(path.join(directory, 'scope-retention-candidate', 'manifest.json'))
    ).size;
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    expect(manifest.retention.inventory).toHaveLength(7000);
    expect(manifest.seedReady).toBe(false);
  });

  it('persists completed empty producers distinctly from untouched producers', async () => {
    const { directory, request, stage } = await setup();
    stage.markProducerCompleted('calls');
    stage.markProducerCompleted('graph-nodes');
    stage.markProducerCompleted('orm-queries');
    const manifest = await persistScopeRetentionCandidate(stage, directory, identity, request);
    expect(manifest.version).toBe(5);
    expect(manifest.retention.producerCompletion).toEqual(stage.producerCompletion);
    expect(manifest.retention.producerCompletion.calls).toBe(true);
    expect(manifest.retention.producerCompletion.heritage).toBe(false);
    expect(manifest.retention.producerCompletion['orm-queries']).toBe(true);
    expect(manifest.retention.graphNodesCaptured).toBe(true);
    expect(manifest.families.every((family) => family.recordCount === 0)).toBe(true);
    expect(manifest.seedReady).toBe(false);
  });

  it.each(['calls', 'graph-nodes', 'orm-queries'] as ScopeRetentionFamily[])(
    'cleans and refunds output when %s completion changes during persistence',
    async (family) => {
      const { directory, request, stage } = await setup();
      const before = request.artifactAllowance.remainingBytes;
      vi.spyOn(stage, 'iterateCalls').mockImplementation(async function* () {
        stage.markProducerCompleted(family);
        yield [];
      });
      await expect(
        persistScopeRetentionCandidate(stage, directory, identity, request),
      ).rejects.toThrow('handle changed during persistence');
      expect(await fs.readdir(directory)).toEqual([]);
      expect(request.artifactAllowance.remainingBytes).toBe(before);
    },
  );

  it('cleans output when a completed import producer has no snapshot', async () => {
    const { directory, request, stage } = await setup();
    stage.markProducerCompleted('import-states');
    const before = request.artifactAllowance.remainingBytes;
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, request),
    ).rejects.toThrow('completed import producer requires one snapshot');
    expect(await fs.readdir(directory)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(before);
  });

  it('removes partial output and refunds writer bytes after a count mismatch', async () => {
    const { directory, request, stage } = await setup();
    vi.spyOn(stage, 'callRecordCount', 'get').mockReturnValue(1);
    const before = request.artifactAllowance.remainingBytes;
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, request),
    ).rejects.toThrow('count mismatch');
    await expect(fs.stat(path.join(directory, 'scope-retention-candidate'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(request.artifactAllowance.remainingBytes).toBe(before);
  });

  it('cleans and refunds when cancellation occurs between writes', async () => {
    const { directory, request, stage } = await setup();
    const controller = new AbortController();
    const before = request.artifactAllowance.remainingBytes;
    vi.spyOn(stage, 'iterateCalls').mockImplementation(async function* () {
      controller.abort();
      yield [];
    });
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, {
        ...request,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(await fs.readdir(directory)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(before);
  });

  it('removes owned output on an I/O failure before publishing the manifest', async () => {
    const { directory, request, stage } = await setup();
    const before = request.artifactAllowance.remainingBytes;
    const failure = new Error('disk full');
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure);
    await expect(persistScopeRetentionCandidate(stage, directory, identity, request)).rejects.toBe(
      failure,
    );
    expect(await fs.readdir(directory)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(before);
  });

  it('fails closed on insufficient allowance without removing a pre-existing directory', async () => {
    const { directory, request, stage } = await setup();
    request.artifactAllowance.remainingBytes = 1;
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, request),
    ).rejects.toThrow('byte limit');
    expect(request.artifactAllowance.remainingBytes).toBe(1);
    const candidate = path.join(directory, 'scope-retention-candidate');
    await fs.mkdir(candidate);
    await fs.writeFile(path.join(candidate, 'keep'), 'existing');
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, request),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(candidate, 'keep'), 'utf8')).toBe('existing');
  });

  it('rejects invalid identity, expired requests, disposed handles, and oversized records', async () => {
    const { directory, request, stage } = await setup();
    await expect(
      persistScopeRetentionCandidate(
        stage,
        directory,
        { ...identity, sourceManifestDigest: 'bad' },
        request,
      ),
    ).rejects.toThrow('invalid identity');
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, { ...request, deadline: 0 }),
    ).rejects.toThrow('deadline');
    vi.spyOn(stage, 'callRecordCount', 'get').mockReturnValue(1);
    vi.spyOn(stage, 'iterateCalls').mockImplementation(async function* () {
      yield [{ name: 'x'.repeat(256 * 1024) }] as never;
    });
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, request),
    ).rejects.toThrow('record limit');
    expect(await fs.readdir(directory)).toEqual([]);
    await stage.dispose();
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, request),
    ).rejects.toThrow('handle unavailable');
  });
});
