import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ScopeRetentionHandle, ScopeRetentionRequest } from './scope-retention-stage.js';
import {
  MAX_MANIFEST_BYTES,
  verifyScopeRetentionCandidate,
} from './scope-retention-candidate-reader.js';
import {
  summarizeScopeRetentionCoverage,
  type ScopeRetentionCoverage,
} from './scope-retention-coverage.js';
import {
  encodeParsedFileRecord,
  MAX_PARSED_FILE_RECORD_BYTES,
  MAX_GRAPH_RECORD_BYTES,
  encodeGraphNodeRecord,
  encodeGraphRelationshipRecord,
} from './parse-scope-codec.js';

export interface ScopeRetentionCandidateIdentity {
  sourceManifestDigest: string;
  targetCommit: string;
  baseGenerationId: string | null;
}

interface CandidateFamily {
  name: string;
  fileName: string;
  recordCount: number;
  bytes: number;
  sha256: string;
}

export interface ScopeRetentionCandidateManifest {
  version: 5;
  status: 'candidate';
  seedReady: false;
  evidenceScope: 'observed-parser-inputs';
  identity: ScopeRetentionCandidateIdentity;
  retention: {
    status: ScopeRetentionHandle['status'];
    reasons: ScopeRetentionHandle['reasons'];
    inventory: ScopeRetentionHandle['inventory'];
    discovery: ScopeRetentionHandle['discovery'];
    inputEvidence: ScopeRetentionHandle['inputEvidence'];
    producerCompletion: ScopeRetentionHandle['producerCompletion'];
    graphNodesCaptured: boolean;
    graphRelationshipsCaptured: boolean;
  };
  coverage: ScopeRetentionCoverage;
  families: CandidateFamily[];
  totalRecordCount: number;
  totalBytes: number;
  artifactBytes: number;
}

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = MAX_GRAPH_RECORD_BYTES;
const MAX_RECORDS = 100_000;
const COPY_CHUNK_BYTES = 64 * 1024;
const sameStat = (before: Stats, after: Stats): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;

/** Copy a previously verified immutable candidate without decoding or re-encoding its records. */
export async function copyScopeRetentionCandidate(
  sourceGenerationPath: string,
  destinationGenerationPath: string,
  expected: Parameters<typeof verifyScopeRetentionCandidate>[1],
  request: ScopeRetentionRequest,
): Promise<ScopeRetentionCandidateManifest> {
  if (
    !Number.isFinite(request.deadline) ||
    !Number.isSafeInteger(request.artifactAllowance.remainingBytes) ||
    request.artifactAllowance.remainingBytes < 0
  ) {
    throw new Error('scope-retention-candidate: invalid request');
  }
  const check = () => {
    if (request.signal?.aborted) throw new Error('scope-retention-candidate: cancelled');
    if (Date.now() >= request.deadline) throw new Error('scope-retention-candidate: deadline');
  };
  check();
  const sourceManifest = await verifyScopeRetentionCandidate(
    sourceGenerationPath,
    expected,
    request,
  );
  check();
  const sourceDirectory = path.join(sourceGenerationPath, 'scope-retention-candidate');
  const destinationDirectory = path.join(destinationGenerationPath, 'scope-retention-candidate');
  const sourceDirectoryStat = await fs.lstat(sourceDirectory);
  if (!sourceDirectoryStat.isDirectory() || sourceDirectoryStat.isSymbolicLink()) {
    throw new Error('scope-retention-candidate: invalid source directory');
  }
  // EEXIST must preserve pre-existing destination state.
  await fs.mkdir(destinationDirectory, { mode: 0o700 });
  let chargedBytes = 0;
  try {
    const copyFile = async (
      fileName: string,
      limit: number,
      manifestSize?: number,
      digest?: string,
    ) => {
      check();
      const sourcePath = path.join(sourceDirectory, fileName);
      const source = await fs.open(
        sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let destination;
      try {
        const before = await source.stat();
        if (
          !before.isFile() ||
          before.size > limit ||
          (manifestSize !== undefined && before.size !== manifestSize)
        ) {
          throw new Error('scope-retention-candidate: invalid source file');
        }
        destination = await fs.open(path.join(destinationDirectory, fileName), 'wx', 0o600);
        const hash = createHash('sha256');
        let copied = 0;
        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        for (;;) {
          check();
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          check();
          if (!bytesRead) break;
          const next = copied + bytesRead;
          if (
            next > limit ||
            chargedBytes + bytesRead > MAX_BYTES ||
            bytesRead > request.artifactAllowance.remainingBytes
          ) {
            throw new Error('scope-retention-candidate: byte limit');
          }
          request.artifactAllowance.remainingBytes -= bytesRead;
          chargedBytes += bytesRead;
          let offset = 0;
          while (offset < bytesRead) {
            check();
            const { bytesWritten } = await destination.write(
              buffer,
              offset,
              bytesRead - offset,
              null,
            );
            if (bytesWritten <= 0) throw new Error('scope-retention-candidate: short write');
            offset += bytesWritten;
          }
          hash.update(buffer.subarray(0, bytesRead));
          copied = next;
        }
        check();
        if (
          copied !== before.size ||
          !sameStat(before, await source.stat()) ||
          (manifestSize !== undefined && copied !== manifestSize) ||
          (digest !== undefined && hash.digest('hex') !== digest)
        ) {
          throw new Error('scope-retention-candidate: source changed during copy');
        }
      } finally {
        try {
          await destination?.close();
        } finally {
          await source.close();
        }
      }
    };
    const manifestPath = path.join(sourceDirectory, 'manifest.json');
    const manifestStat = await fs.lstat(manifestPath);
    if (
      !manifestStat.isFile() ||
      manifestStat.isSymbolicLink() ||
      manifestStat.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error('scope-retention-candidate: invalid source manifest');
    }
    await copyFile('manifest.json', MAX_MANIFEST_BYTES, manifestStat.size);
    for (const family of sourceManifest.families) {
      await copyFile(family.fileName, MAX_BYTES, family.bytes, family.sha256);
    }
    check();
    const currentDirectoryStat = await fs.lstat(sourceDirectory);
    if (
      !currentDirectoryStat.isDirectory() ||
      currentDirectoryStat.isSymbolicLink() ||
      !sameStat(sourceDirectoryStat, currentDirectoryStat)
    ) {
      throw new Error('scope-retention-candidate: source directory changed');
    }
    const copied = await verifyScopeRetentionCandidate(
      destinationGenerationPath,
      expected,
      request,
    );
    check();
    if (!isDeepStrictEqual(copied, sourceManifest)) {
      throw new Error('scope-retention-candidate: copied manifest mismatch');
    }
    return copied;
  } catch (error) {
    try {
      await fs.rm(destinationDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'scope-retention-candidate: cleanup failed');
    }
    request.artifactAllowance.remainingBytes += chargedBytes;
    throw error;
  }
}

/** Consume the live parse-owned handle before its owner disposes it. No admission is implied. */
export async function persistScopeRetentionCandidate(
  handle: ScopeRetentionHandle,
  generationPath: string,
  identity: ScopeRetentionCandidateIdentity,
  request: ScopeRetentionRequest,
): Promise<ScopeRetentionCandidateManifest> {
  const validIdentityPart = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (
    !identity ||
    !/^[a-f0-9]{64}$/.test(identity.sourceManifestDigest) ||
    (identity.targetCommit !== '' && !validIdentityPart(identity.targetCommit)) ||
    (identity.baseGenerationId !== null && !validIdentityPart(identity.baseGenerationId))
  ) {
    throw new Error('scope-retention-candidate: invalid identity');
  }
  if (
    !Number.isFinite(request.deadline) ||
    !Number.isSafeInteger(request.artifactAllowance.remainingBytes) ||
    request.artifactAllowance.remainingBytes < 0
  ) {
    throw new Error('scope-retention-candidate: invalid request');
  }
  const candidateIdentity = { ...identity };
  const check = () => {
    if (request.signal?.aborted) throw new Error('scope-retention-candidate: cancelled');
    if (Date.now() >= request.deadline) throw new Error('scope-retention-candidate: deadline');
  };
  const metadata = () => {
    const status = handle.status; // The getter also checks the handle's own lifetime.
    const value = {
      status,
      reasons: handle.reasons,
      inventory: handle.inventory,
      discovery: handle.discovery,
      inputEvidence: handle.inputEvidence,
      producerCompletion: handle.producerCompletion,
      graphNodesCaptured: handle.graphNodesCaptured,
      graphRelationshipsCaptured: handle.graphRelationshipsCaptured,
    };
    if (value.reasons.some((reason) => ['disposed', 'cancelled', 'deadline'].includes(reason))) {
      throw new Error('scope-retention-candidate: handle unavailable');
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES) {
      throw new Error('scope-retention-candidate: metadata limit');
    }
    return { value, encoded };
  };
  check();
  const initial = metadata();
  const counts = () => [
    handle.recordCount,
    handle.callRecordCount,
    handle.heritageRecordCount,
    handle.assignmentRecordCount,
    handle.constructorBindingRecordCount,
    handle.exportedTypeRecordCount,
    handle.fileBindingRecordCount,
    handle.modelRegistrationRecordCount,
    handle.importStateRecordCount,
    handle.graphNodeRecordCount,
    handle.graphRelationshipRecordCount,
    handle.ormQueryRecordCount,
    handle.fetchCallRecordCount,
    handle.routeRecordCount,
    handle.decoratorRouteRecordCount,
    handle.toolDefinitionRecordCount,
  ];
  const expectedCounts = counts();
  const directory = path.join(generationPath, 'scope-retention-candidate');
  // EEXIST must preserve a pre-existing directory, including its contents.
  await fs.mkdir(directory, { mode: 0o700 });
  let chargedBytes = 0;
  try {
    let totalRecordCount = 0;
    const families: CandidateFamily[] = [];
    const reserve = (bytes: number) => {
      check();
      if (chargedBytes + bytes > MAX_BYTES || bytes > request.artifactAllowance.remainingBytes) {
        throw new Error('scope-retention-candidate: byte limit');
      }
      request.artifactAllowance.remainingBytes -= bytes;
      chargedBytes += bytes;
    };
    const writeFamily = async (
      name: string,
      batches: AsyncIterable<readonly unknown[]>,
      expected: number,
      encode: (record: unknown) => string = JSON.stringify,
      maxLineBytes = MAX_LINE_BYTES,
    ) => {
      if (!Number.isSafeInteger(expected) || expected < 0) {
        throw new Error('scope-retention-candidate: invalid count');
      }
      check();
      const fileName = `${name}.jsonl`;
      const file = await fs.open(path.join(directory, fileName), 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      let recordCount = 0;
      try {
        for await (const batch of batches) {
          check();
          for (const record of batch) {
            check();
            const encoded = encode(record);
            if (typeof encoded !== 'string')
              throw new Error('scope-retention-candidate: invalid record');
            const line = encoded.endsWith('\n') ? encoded : `${encoded}\n`;
            const size = Buffer.byteLength(line);
            if (size > maxLineBytes || totalRecordCount >= MAX_RECORDS) {
              throw new Error('scope-retention-candidate: record limit');
            }
            reserve(size);
            await file.writeFile(line, 'utf8');
            hash.update(line);
            bytes += size;
            recordCount++;
            totalRecordCount++;
          }
        }
      } finally {
        await file.close();
      }
      check();
      if (recordCount !== expected)
        throw new Error(`scope-retention-candidate: ${name} count mismatch`);
      families.push({ name, fileName, recordCount, bytes, sha256: hash.digest('hex') });
    };
    await writeFamily(
      'parsed-files',
      handle.iterate(),
      expectedCounts[0]!,
      (record) => encodeParsedFileRecord(record),
      MAX_PARSED_FILE_RECORD_BYTES,
    );
    await writeFamily('calls', handle.iterateCalls(), expectedCounts[1]!);
    await writeFamily('heritage', handle.iterateHeritage(), expectedCounts[2]!);
    await writeFamily('assignments', handle.iterateAssignments(), expectedCounts[3]!);
    await writeFamily(
      'constructor-bindings',
      handle.iterateConstructorBindings(),
      expectedCounts[4]!,
    );
    await writeFamily('exported-types', handle.iterateExportedTypes(), expectedCounts[5]!);
    await writeFamily('file-bindings', handle.iterateFileBindings(), expectedCounts[6]!);
    await writeFamily(
      'model-registrations',
      handle.iterateModelRegistrations(),
      expectedCounts[7]!,
    );
    await writeFamily('import-states', handle.iterateImportStates(), expectedCounts[8]!);
    await writeFamily('graph-nodes', handle.iterateGraphNodes(), expectedCounts[9]!, (record) =>
      encodeGraphNodeRecord(record, MAX_LINE_BYTES - 1),
    );
    await writeFamily(
      'graph-relationships',
      handle.iterateGraphRelationships(),
      expectedCounts[10]!,
      (record) => encodeGraphRelationshipRecord(record, MAX_LINE_BYTES - 1),
    );
    await writeFamily('orm-queries', handle.iterateORMQueries(), expectedCounts[11]!);
    await writeFamily('fetch-calls', handle.iterateFetchCalls(), expectedCounts[12]!);
    await writeFamily('routes', handle.iterateRoutes(), expectedCounts[13]!);
    await writeFamily('decorator-routes', handle.iterateDecoratorRoutes(), expectedCounts[14]!);
    await writeFamily('tool-definitions', handle.iterateToolDefinitions(), expectedCounts[15]!);
    if (
      metadata().encoded !== initial.encoded ||
      JSON.stringify(counts()) !== JSON.stringify(expectedCounts)
    ) {
      throw new Error('scope-retention-candidate: handle changed during persistence');
    }
    const manifest: ScopeRetentionCandidateManifest = {
      version: 5,
      status: 'candidate',
      seedReady: false,
      evidenceScope: 'observed-parser-inputs',
      identity: candidateIdentity,
      retention: initial.value,
      coverage: summarizeScopeRetentionCoverage(initial.value.inventory),
      families,
      totalRecordCount,
      totalBytes: chargedBytes,
      artifactBytes: chargedBytes,
    };
    // Including totalBytes changes the manifest size; stabilize its decimal width.
    let encoded = '';
    for (;;) {
      encoded = `${JSON.stringify(manifest)}\n`;
      const total = chargedBytes + Buffer.byteLength(encoded);
      if (total === manifest.totalBytes) break;
      manifest.totalBytes = total;
      manifest.artifactBytes = total;
    }
    const manifestBytes = Buffer.byteLength(encoded);
    if (manifestBytes > MAX_MANIFEST_BYTES)
      throw new Error('scope-retention-candidate: manifest limit');
    reserve(manifestBytes);
    await fs.writeFile(path.join(directory, 'manifest.json'), encoded, { flag: 'wx', mode: 0o600 });
    check();
    if (
      metadata().encoded !== initial.encoded ||
      JSON.stringify(counts()) !== JSON.stringify(expectedCounts)
    ) {
      throw new Error('scope-retention-candidate: handle changed during persistence');
    }
    await verifyScopeRetentionCandidate(
      generationPath,
      {
        identity: candidateIdentity,
        parserCodeIdentity: initial.value.inputEvidence.parserCodeIdentity,
      },
      request,
    );
    return manifest;
  } catch (error) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'scope-retention-candidate: cleanup failed');
    }
    request.artifactAllowance.remainingBytes += chargedBytes;
    throw error;
  }
}
