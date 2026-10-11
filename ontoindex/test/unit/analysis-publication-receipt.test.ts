import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  analysisPublicationReceiptPath,
  MANAGED_ANALYSIS_ENV,
  parseManagedAnalysisContextFromEnv,
  readAnalysisPublicationReceipt,
  writeAnalysisPublicationReceipt,
  type AnalysisRequestedCapabilities,
} from '../../src/core/analysis/analysis-publication-receipt.js';

const TARGET_HEAD = 'a'.repeat(40);
const OPTIONS_DIGEST = 'b'.repeat(64);
const SOURCE_IDENTITY = `commit:${TARGET_HEAD}`;
const SOURCE_MANIFEST_DIGEST = 'd'.repeat(64);
const EMBEDDING_MODEL_HASH = 'test-embedding-model';
const GRAPH_ONLY: AnalysisRequestedCapabilities = {
  version: 1,
  graph: true,
  graphCapabilities: ['symbols'],
  embeddings: false,
  embeddingModelHash: null,
};
const GRAPH_AND_EMBEDDINGS: AnalysisRequestedCapabilities = {
  version: 1,
  graph: true,
  graphCapabilities: ['impact', 'symbols'],
  embeddings: true,
  embeddingModelHash: EMBEDDING_MODEL_HASH,
};
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function managedEnvironment(
  requestedCapabilities: AnalysisRequestedCapabilities = GRAPH_AND_EMBEDDINGS,
): NodeJS.ProcessEnv {
  return {
    [MANAGED_ANALYSIS_ENV.jobId]: 'managed-job',
    [MANAGED_ANALYSIS_ENV.targetHead]: TARGET_HEAD,
    [MANAGED_ANALYSIS_ENV.optionsDigest]: OPTIONS_DIGEST,
    [MANAGED_ANALYSIS_ENV.sourceIdentity]: SOURCE_IDENTITY,
    [MANAGED_ANALYSIS_ENV.sourceManifestDigest]: SOURCE_MANIFEST_DIGEST,
    [MANAGED_ANALYSIS_ENV.requestedCapabilities]: JSON.stringify(requestedCapabilities),
  };
}

describe('managed analysis publication receipts', () => {
  it('parses a complete environment context with a commit-bound source identity', () => {
    expect(parseManagedAnalysisContextFromEnv(managedEnvironment())).toEqual({
      jobId: 'managed-job',
      targetHead: TARGET_HEAD,
      optionsDigest: OPTIONS_DIGEST,
      sourceIdentity: SOURCE_IDENTITY,
      sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
      requestedCapabilities: GRAPH_AND_EMBEDDINGS,
    });
  });

  it('rejects an environment context without source identity', () => {
    const env = managedEnvironment();
    delete env[MANAGED_ANALYSIS_ENV.sourceIdentity];

    expect(() => parseManagedAnalysisContextFromEnv(env)).toThrow(
      'Managed analysis context is incomplete.',
    );
  });

  it('rejects a source identity that does not match the target HEAD', () => {
    const env = managedEnvironment();
    env[MANAGED_ANALYSIS_ENV.sourceIdentity] = `commit:${'c'.repeat(40)}`;

    expect(() => parseManagedAnalysisContextFromEnv(env)).toThrow(
      'Managed analysis source identity is malformed.',
    );
  });

  it.each([
    ['empty graph capabilities', []],
    ['duplicate graph capabilities', ['symbols', 'symbols']],
    ['unsorted graph capabilities', ['symbols', 'impact']],
    ['unknown graph capabilities', ['query']],
  ])('rejects %s', (_label, graphCapabilities) => {
    const env = managedEnvironment();
    env[MANAGED_ANALYSIS_ENV.requestedCapabilities] = JSON.stringify({
      ...GRAPH_ONLY,
      graphCapabilities,
    });

    expect(() => parseManagedAnalysisContextFromEnv(env)).toThrow(
      'Managed analysis requested capabilities are malformed.',
    );
  });

  it.each([
    ['missing embedding model identity', true, null],
    ['blank embedding model identity', true, '   '],
    ['unexpected embedding model identity', false, EMBEDDING_MODEL_HASH],
  ])('rejects %s', (_label, embeddings, embeddingModelHash) => {
    const env = managedEnvironment();
    env[MANAGED_ANALYSIS_ENV.requestedCapabilities] = JSON.stringify({
      ...GRAPH_ONLY,
      embeddings,
      embeddingModelHash,
    });

    expect(() => parseManagedAnalysisContextFromEnv(env)).toThrow(
      'Managed analysis requested capabilities are malformed.',
    );
  });

  it('round-trips source identity in a valid publication receipt', async () => {
    const generationPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'analysis-publication-receipt-'),
    );
    tempDirectories.push(generationPath);

    await writeAnalysisPublicationReceipt(generationPath, {
      version: 1,
      jobId: 'managed-job',
      repoPath: path.resolve(generationPath, 'repo'),
      targetHead: TARGET_HEAD,
      optionsDigest: OPTIONS_DIGEST,
      sourceIdentity: SOURCE_IDENTITY,
      sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
      generationId: 'generation-1',
      requestedCapabilities: GRAPH_AND_EMBEDDINGS,
      analyzerContractVersion: 'ontoindex-source-manifest-v1',
      publishedAt: '2026-08-18T00:00:00.000Z',
    });

    await expect(
      readAnalysisPublicationReceipt(generationPath, 'managed-job'),
    ).resolves.toMatchObject({
      targetHead: TARGET_HEAD,
      sourceIdentity: SOURCE_IDENTITY,
      sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
      requestedCapabilities: GRAPH_AND_EMBEDDINGS,
    });
  });

  it.each([
    ['malformed generation id', { generationId: '../generation' }],
    ['malformed source manifest digest', { sourceManifestDigest: 'not-a-digest' }],
  ])('rejects a receipt with %s', async (_label, override) => {
    const generationPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'analysis-publication-receipt-'),
    );
    tempDirectories.push(generationPath);

    await expect(
      writeAnalysisPublicationReceipt(generationPath, {
        version: 1,
        jobId: 'managed-job',
        repoPath: path.resolve(generationPath, 'repo'),
        targetHead: TARGET_HEAD,
        optionsDigest: OPTIONS_DIGEST,
        sourceIdentity: SOURCE_IDENTITY,
        sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
        generationId: 'generation-1',
        requestedCapabilities: GRAPH_ONLY,
        analyzerContractVersion: 'ontoindex-source-manifest-v1',
        publishedAt: '2026-08-18T00:00:00.000Z',
        ...override,
      }),
    ).rejects.toThrow(/malformed/);
  });

  it('fails closed when a stored receipt source identity is changed', async () => {
    const generationPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'analysis-publication-receipt-'),
    );
    tempDirectories.push(generationPath);
    const receiptPath = analysisPublicationReceiptPath(generationPath, 'managed-job');
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(
      receiptPath,
      JSON.stringify({
        version: 1,
        jobId: 'managed-job',
        repoPath: path.resolve(generationPath, 'repo'),
        targetHead: TARGET_HEAD,
        optionsDigest: OPTIONS_DIGEST,
        sourceIdentity: `commit:${'c'.repeat(40)}`,
        sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
        generationId: 'generation-1',
        requestedCapabilities: GRAPH_ONLY,
        analyzerContractVersion: 'ontoindex-source-manifest-v1',
        publishedAt: '2026-08-18T00:00:00.000Z',
      }),
      'utf8',
    );

    await expect(readAnalysisPublicationReceipt(generationPath, 'managed-job')).resolves.toBeNull();
  });
});
