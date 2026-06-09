import {
  normalizeAxelEnrichmentFactEnvelope,
  type AxelEnrichmentFact,
  type AxelEnrichmentFactEnvelope,
  type AxelReferencedFile,
} from './axel-enrichment-fact.js';
import {
  createEnrichmentRecord,
  type EnrichmentFact,
  type EnrichmentRecordInput,
} from './enrichment-record.js';

export interface AxelSidecarAdapterFileScope {
  filePath: string;
  fileHash: string;
}

export interface AxelSidecarAdapterOptions {
  analyzerId: string;
  analyzerVersion: string;
  sourceIndexId: string;
  sourceCommitHash: string;
  schemaVersion: number;
  repoId: string;
  files?: readonly AxelSidecarAdapterFileScope[];
  fileScopes?: readonly AxelSidecarAdapterFileScope[];
}

export const AXEL_SIDECAR_ADAPTER_FAILURE_REASON = 'axel sidecar output validation failed';
export const AXEL_SIDECAR_ADAPTER_IDENTITY_MISMATCH_REASON =
  'axel sidecar output identity mismatch';

export function convertAxelEnvelopeToEnrichmentRecords(
  input: unknown,
  options: AxelSidecarAdapterOptions,
): EnrichmentRecordInput[] {
  try {
    const envelope = normalizeAxelEnrichmentFactEnvelope(input);
    const mismatch = findIdentityMismatch(envelope, options);
    if (mismatch !== undefined) {
      return createFailedScopedRecords(options, AXEL_SIDECAR_ADAPTER_IDENTITY_MISMATCH_REASON);
    }
    const outOfScopeFiles = findOutOfScopeReferencedFiles(envelope, options);
    if (outOfScopeFiles.length > 0) {
      return createFailedRecords(
        options,
        outOfScopeFiles,
        `${AXEL_SIDECAR_ADAPTER_FAILURE_REASON}: referenced file outside supplied scope`,
      );
    }
    return createGroupedRecords(envelope, options);
  } catch (error) {
    return createFailedScopedRecords(
      options,
      `${AXEL_SIDECAR_ADAPTER_FAILURE_REASON}: ${errorToMessage(error)}`,
    );
  }
}

function createGroupedRecords(
  envelope: AxelEnrichmentFactEnvelope,
  options: AxelSidecarAdapterOptions,
): EnrichmentRecordInput[] {
  if (envelope.facts.length === 0) return [];

  const recordsByFile = new Map<
    string,
    { file: AxelReferencedFile; facts: AxelEnrichmentFact[] }
  >();
  for (const fact of envelope.facts) {
    for (const file of fact.referencedFiles) {
      const key = createFileKey(file);
      const group = recordsByFile.get(key);
      if (group === undefined) {
        recordsByFile.set(key, { file, facts: [fact] });
      } else {
        group.facts.push(fact);
      }
    }
  }

  return [...recordsByFile.values()]
    .sort((left, right) => compareFiles(left.file, right.file))
    .map(({ file, facts }) =>
      createBoundRecord(options, file, {
        status: 'complete',
        records: facts.map(toEnrichmentFact),
      }),
    );
}

function toEnrichmentFact(fact: AxelEnrichmentFact): EnrichmentFact {
  return { ...fact };
}

function createFailedScopedRecords(
  options: AxelSidecarAdapterOptions,
  failureReason: string,
): EnrichmentRecordInput[] {
  return createFailedRecords(options, getFileScopes(options), failureReason);
}

function createFailedRecords(
  options: AxelSidecarAdapterOptions,
  files: readonly AxelSidecarAdapterFileScope[],
  failureReason: string,
): EnrichmentRecordInput[] {
  return [...files].sort(compareFiles).map((file) =>
    createBoundRecord(options, file, {
      status: 'failed',
      records: [],
      failureReason,
    }),
  );
}

function createBoundRecord(
  options: AxelSidecarAdapterOptions,
  file: AxelReferencedFile,
  result: Pick<EnrichmentRecordInput, 'status' | 'records' | 'failureReason'>,
): EnrichmentRecordInput {
  return createEnrichmentRecord({
    sourceIndexId: options.sourceIndexId,
    sourceCommitHash: options.sourceCommitHash,
    schemaVersion: options.schemaVersion,
    analyzerId: options.analyzerId,
    analyzerVersion: options.analyzerVersion,
    filePath: file.filePath,
    fileHash: file.fileHash,
    status: result.status,
    records: result.records,
    failureReason: result.failureReason,
  });
}

function findIdentityMismatch(
  envelope: AxelEnrichmentFactEnvelope,
  options: AxelSidecarAdapterOptions,
): string | undefined {
  if (envelope.analyzerId !== options.analyzerId) return 'analyzerId';
  if (envelope.analyzerVersion !== options.analyzerVersion) return 'analyzerVersion';
  if (envelope.sourceIndexId !== options.sourceIndexId) return 'sourceIndexId';
  if (envelope.sourceCommitHash !== options.sourceCommitHash) return 'sourceCommitHash';
  if (envelope.schemaVersion !== options.schemaVersion) return 'schemaVersion';
  if (envelope.repoId !== options.repoId) return 'repoId';
  return undefined;
}

function findOutOfScopeReferencedFiles(
  envelope: AxelEnrichmentFactEnvelope,
  options: AxelSidecarAdapterOptions,
): AxelReferencedFile[] {
  const fileScopes = getFileScopes(options);
  if (fileScopes.length === 0) return [];

  const allowed = new Set(fileScopes.map(createFileKey));
  const outOfScope = new Map<string, AxelReferencedFile>();
  for (const fact of envelope.facts) {
    for (const file of fact.referencedFiles) {
      const key = createFileKey(file);
      if (!allowed.has(key)) {
        outOfScope.set(key, file);
      }
    }
  }
  return [...outOfScope.values()];
}

function getFileScopes(options: AxelSidecarAdapterOptions): readonly AxelSidecarAdapterFileScope[] {
  return options.fileScopes ?? options.files ?? [];
}

function createFileKey(file: AxelReferencedFile): string {
  return `${file.filePath}\0${file.fileHash}`;
}

function compareFiles(left: AxelReferencedFile, right: AxelReferencedFile): number {
  return left.filePath.localeCompare(right.filePath) || left.fileHash.localeCompare(right.fileHash);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'unknown validation error';
}
