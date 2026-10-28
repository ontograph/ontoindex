import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedFile } from 'ontoindex-shared';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import {
  copyScopeRetentionCandidate,
  persistScopeRetentionCandidate,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';

const identity = {
  sourceManifestDigest: 'a'.repeat(64),
  targetCommit: 'head',
  baseGenerationId: null,
};
const directories: string[] = [];
const stages: ScopeRetentionStage[] = [];

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
        typeBindings: new Map(),
        ownedDefs: [],
        imports: [],
      },
    ],
  };
}

async function setup(allowance = 64 * 1024 * 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-candidate-copy-'));
  directories.push(root);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fs.mkdir(source);
  await fs.mkdir(destination);
  const request: {
    deadline: number;
    signal?: AbortSignal;
    artifactAllowance: { remainingBytes: number };
  } = {
    deadline: Date.now() + 60_000,
    artifactAllowance: { remainingBytes: allowance },
  };
  const stage = new ScopeRetentionStage(request);
  stages.push(stage);
  stage.capture([fixture()]);
  await stage.flush();
  const manifest = await persistScopeRetentionCandidate(stage, source, identity, request);
  return { source, destination, request, manifest };
}

afterEach(async () => {
  for (const stage of stages.splice(0)) await stage.dispose();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('scope retention candidate copy', () => {
  it('copies the verified manifest and family bytes exactly and charges their full size', async () => {
    const { source, destination, request, manifest } = await setup();
    const before = request.artifactAllowance.remainingBytes;
    const copied = await copyScopeRetentionCandidate(
      source,
      destination,
      {
        identity,
        parserCodeIdentity: manifest.retention.inputEvidence.parserCodeIdentity,
      },
      request,
    );
    expect(copied).toEqual(manifest);
    expect(request.artifactAllowance.remainingBytes).toBe(before - manifest.artifactBytes);
    const sourceDir = path.join(source, 'scope-retention-candidate');
    const destinationDir = path.join(destination, 'scope-retention-candidate');
    for (const fileName of [
      'manifest.json',
      ...manifest.families.map((family) => family.fileName),
    ]) {
      expect(await fs.readFile(path.join(destinationDir, fileName))).toEqual(
        await fs.readFile(path.join(sourceDir, fileName)),
      );
      expect(
        await fs.stat(path.join(destinationDir, fileName)).then((stat) => stat.mode & 0o777),
      ).toBe(0o600);
    }
    expect((await fs.stat(destinationDir)).mode & 0o777).toBe(0o700);
    expect(copied.seedReady).toBe(false);
  });

  it('preserves existing destination state and rejects a source identity mismatch', async () => {
    const { source, destination, request, manifest } = await setup();
    const candidate = path.join(destination, 'scope-retention-candidate');
    await fs.mkdir(candidate);
    await fs.writeFile(path.join(candidate, 'keep'), 'existing');
    await expect(
      copyScopeRetentionCandidate(
        source,
        destination,
        {
          identity,
          parserCodeIdentity: manifest.retention.inputEvidence.parserCodeIdentity,
        },
        request,
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(candidate, 'keep'), 'utf8')).toBe('existing');
    await fs.rm(candidate, { recursive: true });
    await expect(
      copyScopeRetentionCandidate(
        source,
        destination,
        {
          identity: { ...identity, targetCommit: 'other' },
          parserCodeIdentity: manifest.retention.inputEvidence.parserCodeIdentity,
        },
        request,
      ),
    ).rejects.toThrow('identity mismatch');
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('removes partial output and refunds copied bytes when allowance is insufficient', async () => {
    const { source, destination, request, manifest } = await setup();
    request.artifactAllowance.remainingBytes = manifest.artifactBytes - 1;
    const before = request.artifactAllowance.remainingBytes;
    await expect(
      copyScopeRetentionCandidate(
        source,
        destination,
        {
          identity,
          parserCodeIdentity: manifest.retention.inputEvidence.parserCodeIdentity,
        },
        request,
      ),
    ).rejects.toThrow('byte limit');
    expect(await fs.readdir(destination)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(before);
  });

  it('retains the charge when cleanup of partial output fails', async () => {
    const { source, destination, request, manifest } = await setup();
    request.artifactAllowance.remainingBytes = manifest.artifactBytes - 1;
    const before = request.artifactAllowance.remainingBytes;
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(
      copyScopeRetentionCandidate(
        source,
        destination,
        {
          identity,
          parserCodeIdentity: manifest.retention.inputEvidence.parserCodeIdentity,
        },
        request,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(request.artifactAllowance.remainingBytes).toBeLessThan(before);
  });

  it('rejects corrupt source bytes before creating the destination candidate', async () => {
    const { source, destination, request, manifest } = await setup();
    const family = manifest.families[0]!;
    await fs.writeFile(path.join(source, 'scope-retention-candidate', family.fileName), 'tampered');
    await expect(
      copyScopeRetentionCandidate(
        source,
        destination,
        {
          identity,
          parserCodeIdentity: manifest.retention.inputEvidence.parserCodeIdentity,
        },
        request,
      ),
    ).rejects.toThrow();
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('fails closed on a pre-aborted request without creating output', async () => {
    const { source, destination, request, manifest } = await setup();
    const controller = new AbortController();
    request.signal = controller.signal;
    const before = request.artifactAllowance.remainingBytes;
    controller.abort();
    await expect(
      copyScopeRetentionCandidate(
        source,
        destination,
        {
          identity,
          parserCodeIdentity: manifest.retention.inputEvidence.parserCodeIdentity,
        },
        request,
      ),
    ).rejects.toThrow('cancelled');
    expect(await fs.readdir(destination)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(before);
  });
});
