import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const ZVEC_MIRROR_SCHEMA_VERSION = 1 as const;

export type ZvecMirrorStatus = 'fresh' | 'missing' | 'stale' | 'unsupported' | 'error';

export type ZvecMirrorReasonCode =
  | 'missing-metadata'
  | 'malformed-metadata'
  | 'schema-version-stale'
  | 'schema-version-unsupported'
  | 'zvec-package-version-mismatch'
  | 'embedding-dimension-mismatch'
  | 'embedding-model-hash-mismatch'
  | 'source-commit-mismatch'
  | 'current-head-mismatch'
  | 'graph-index-id-mismatch'
  | 'graph-index-hash-mismatch'
  | 'code-embedding-row-count-mismatch'
  | 'code-embedding-row-digest-mismatch'
  | 'backend-index-type-mismatch'
  | 'backend-index-params-mismatch'
  | 'metadata-read-error';

export interface ZvecEmbeddingRowIdentity {
  id: string;
  nodeId: string;
  chunkIndex: number;
  contentHash: string;
}

export interface ZvecMirrorCurrentState {
  schemaVersion: number;
  zvecPackageVersion: string;
  embeddingDimension: number;
  embeddingModelHash: string;
  sourceCommit: string;
  currentHead: string;
  graphIndexId?: string;
  graphIndexHash?: string;
  codeEmbeddingRowCount: number;
  codeEmbeddingRowDigest: string;
  backendIndexType: string;
  backendIndexParams: Readonly<Record<string, unknown>>;
}

export interface ZvecMirrorMetadata extends ZvecMirrorCurrentState {
  buildTimestamp: string;
}

export interface ZvecMirrorBuildInput
  extends Omit<
    ZvecMirrorCurrentState,
    'schemaVersion' | 'codeEmbeddingRowCount' | 'codeEmbeddingRowDigest'
  > {
  codeEmbeddingRows: readonly ZvecEmbeddingRowIdentity[];
  buildTimestamp?: string | Date;
}

export interface ZvecMirrorFreshnessInput {
  current: ZvecMirrorCurrentState;
  metadata?: unknown;
}

export interface ZvecMirrorFreshnessResult {
  status: ZvecMirrorStatus;
  reasonCodes: readonly ZvecMirrorReasonCode[];
  warnings: readonly string[];
  metadata?: ZvecMirrorMetadata;
}

const DOC_ID_PREFIX = 'doc_';
const HASH_CHARS = 32;

export function createZvecMirrorMetadata(input: ZvecMirrorBuildInput): ZvecMirrorMetadata {
  const rows = normalizeEmbeddingRows(input.codeEmbeddingRows);
  return {
    schemaVersion: ZVEC_MIRROR_SCHEMA_VERSION,
    zvecPackageVersion: normalizeRequiredString(input.zvecPackageVersion, 'zvecPackageVersion'),
    embeddingDimension: normalizePositiveInteger(input.embeddingDimension, 'embeddingDimension'),
    embeddingModelHash: normalizeRequiredString(input.embeddingModelHash, 'embeddingModelHash'),
    sourceCommit: normalizeRequiredString(input.sourceCommit, 'sourceCommit'),
    currentHead: normalizeRequiredString(input.currentHead, 'currentHead'),
    graphIndexId: normalizeOptionalString(input.graphIndexId),
    graphIndexHash: normalizeOptionalString(input.graphIndexHash),
    codeEmbeddingRowCount: rows.length,
    codeEmbeddingRowDigest: computeZvecEmbeddingRowsDigest(rows),
    buildTimestamp: normalizeTimestamp(input.buildTimestamp),
    backendIndexType: normalizeRequiredString(input.backendIndexType, 'backendIndexType'),
    backendIndexParams: normalizeBackendIndexParams(input.backendIndexParams),
  };
}

export function computeZvecEmbeddingRowsDigest(rows: readonly ZvecEmbeddingRowIdentity[]): string {
  const canonicalRows = normalizeEmbeddingRows(rows)
    .map((row) => canonicalEmbeddingRowKey(row))
    .sort();
  const payload = `${canonicalRows.length}\u0000${canonicalRows.join('\u001f')}`;
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

export function zvecDocIdForEmbeddingRow(row: ZvecEmbeddingRowIdentity): string {
  const digest = createHash('sha256').update(canonicalEmbeddingRowKey(row), 'utf8').digest('hex');
  return `${DOC_ID_PREFIX}${digest.slice(0, HASH_CHARS)}`;
}

export function evaluateZvecMirrorFreshness(
  input: ZvecMirrorFreshnessInput,
): ZvecMirrorFreshnessResult {
  const current = normalizeCurrentState(input.current);
  const parsed = normalizeMetadata(input.metadata);

  if (!parsed) {
    return input.metadata === undefined || input.metadata === null
      ? {
          status: 'missing',
          reasonCodes: ['missing-metadata'],
          warnings: ['zvec mirror metadata is missing.'],
        }
      : {
          status: 'error',
          reasonCodes: ['malformed-metadata'],
          warnings: ['zvec mirror metadata is malformed or missing required fields.'],
        };
  }

  const reasonCodes = new Set<ZvecMirrorReasonCode>();
  const warnings: string[] = [];

  if (parsed.schemaVersion > current.schemaVersion) {
    reasonCodes.add('schema-version-unsupported');
    warnings.push(
      `Mirror schema version ${parsed.schemaVersion} is newer than supported ${current.schemaVersion}.`,
    );
  } else if (parsed.schemaVersion < current.schemaVersion) {
    reasonCodes.add('schema-version-stale');
    warnings.push(
      `Mirror schema version ${parsed.schemaVersion} is older than expected ${current.schemaVersion}.`,
    );
  }

  compareStringField(
    'zvecPackageVersion',
    current.zvecPackageVersion,
    parsed.zvecPackageVersion,
    reasonCodes,
  );
  compareNumberField(
    'embeddingDimension',
    current.embeddingDimension,
    parsed.embeddingDimension,
    reasonCodes,
  );
  compareStringField(
    'embeddingModelHash',
    current.embeddingModelHash,
    parsed.embeddingModelHash,
    reasonCodes,
  );
  compareStringField('sourceCommit', current.sourceCommit, parsed.sourceCommit, reasonCodes);
  compareStringField('currentHead', current.currentHead, parsed.currentHead, reasonCodes);
  compareOptionalStringField(
    'graphIndexId',
    current.graphIndexId,
    parsed.graphIndexId,
    reasonCodes,
  );
  compareOptionalStringField(
    'graphIndexHash',
    current.graphIndexHash,
    parsed.graphIndexHash,
    reasonCodes,
  );
  compareNumberField(
    'codeEmbeddingRowCount',
    current.codeEmbeddingRowCount,
    parsed.codeEmbeddingRowCount,
    reasonCodes,
  );
  compareStringField(
    'codeEmbeddingRowDigest',
    current.codeEmbeddingRowDigest,
    parsed.codeEmbeddingRowDigest,
    reasonCodes,
  );
  compareStringField(
    'backendIndexType',
    current.backendIndexType,
    parsed.backendIndexType,
    reasonCodes,
  );
  compareStableJsonField(
    'backendIndexParams',
    current.backendIndexParams,
    parsed.backendIndexParams,
    reasonCodes,
  );

  const status: ZvecMirrorStatus = reasonCodes.has('schema-version-unsupported')
    ? 'unsupported'
    : reasonCodes.size > 0
    ? 'stale'
    : 'fresh';

  return {
    status,
    reasonCodes: [...reasonCodes],
    warnings,
    metadata: parsed,
  };
}

export async function readZvecMirrorMetadata(
  metadataPath: string,
): Promise<ZvecMirrorMetadata | null> {
  try {
    const raw = await readFile(metadataPath, 'utf8');
    return normalizeMetadata(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readZvecMirrorFreshness(
  metadataPath: string,
  current: ZvecMirrorCurrentState,
): Promise<ZvecMirrorFreshnessResult> {
  try {
    const raw = await readFile(metadataPath, 'utf8');
    return evaluateZvecMirrorFreshness({ current, metadata: JSON.parse(raw) });
  } catch (error) {
    return {
      status: 'error',
      reasonCodes: ['metadata-read-error'],
      warnings: [`Unable to read zvec mirror metadata: ${errorMessage(error)}`],
    };
  }
}

function normalizeCurrentState(input: ZvecMirrorCurrentState): ZvecMirrorCurrentState {
  return {
    schemaVersion: normalizePositiveInteger(input.schemaVersion, 'schemaVersion'),
    zvecPackageVersion: normalizeRequiredString(input.zvecPackageVersion, 'zvecPackageVersion'),
    embeddingDimension: normalizePositiveInteger(input.embeddingDimension, 'embeddingDimension'),
    embeddingModelHash: normalizeRequiredString(input.embeddingModelHash, 'embeddingModelHash'),
    sourceCommit: normalizeRequiredString(input.sourceCommit, 'sourceCommit'),
    currentHead: normalizeRequiredString(input.currentHead, 'currentHead'),
    graphIndexId: normalizeOptionalString(input.graphIndexId),
    graphIndexHash: normalizeOptionalString(input.graphIndexHash),
    codeEmbeddingRowCount: normalizeNonNegativeInteger(
      input.codeEmbeddingRowCount,
      'codeEmbeddingRowCount',
    ),
    codeEmbeddingRowDigest: normalizeRequiredString(
      input.codeEmbeddingRowDigest,
      'codeEmbeddingRowDigest',
    ),
    backendIndexType: normalizeRequiredString(input.backendIndexType, 'backendIndexType'),
    backendIndexParams: normalizeBackendIndexParams(input.backendIndexParams),
  };
}

function normalizeMetadata(value: unknown): ZvecMirrorMetadata | null {
  if (!isPlainObject(value)) return null;

  const schemaVersion = normalizePositiveIntegerOrNull(value.schemaVersion);
  const zvecPackageVersion = normalizeRequiredStringOrNull(value.zvecPackageVersion);
  const embeddingDimension = normalizePositiveIntegerOrNull(value.embeddingDimension);
  const embeddingModelHash = normalizeRequiredStringOrNull(value.embeddingModelHash);
  const sourceCommit = normalizeRequiredStringOrNull(value.sourceCommit);
  const currentHead = normalizeRequiredStringOrNull(value.currentHead);
  const graphIndexId = normalizeOptionalString(value.graphIndexId);
  const graphIndexHash = normalizeOptionalString(value.graphIndexHash);
  const codeEmbeddingRowCount = normalizeNonNegativeIntegerOrNull(value.codeEmbeddingRowCount);
  const codeEmbeddingRowDigest = normalizeRequiredStringOrNull(value.codeEmbeddingRowDigest);
  const buildTimestamp = normalizeRequiredStringOrNull(value.buildTimestamp);
  const backendIndexType = normalizeRequiredStringOrNull(value.backendIndexType);
  const backendIndexParams = normalizeBackendIndexParamsOrNull(value.backendIndexParams);

  if (
    schemaVersion === null ||
    zvecPackageVersion === null ||
    embeddingDimension === null ||
    embeddingModelHash === null ||
    sourceCommit === null ||
    currentHead === null ||
    codeEmbeddingRowCount === null ||
    codeEmbeddingRowDigest === null ||
    buildTimestamp === null ||
    backendIndexType === null ||
    backendIndexParams === null
  ) {
    return null;
  }

  return {
    schemaVersion,
    zvecPackageVersion,
    embeddingDimension,
    embeddingModelHash,
    sourceCommit,
    currentHead,
    graphIndexId,
    graphIndexHash,
    codeEmbeddingRowCount,
    codeEmbeddingRowDigest,
    buildTimestamp,
    backendIndexType,
    backendIndexParams,
  };
}

function compareStringField(
  field: Exclude<
    keyof ZvecMirrorCurrentState,
    'schemaVersion' | 'embeddingDimension' | 'codeEmbeddingRowCount' | 'backendIndexParams'
  >,
  expected: string,
  actual: string,
  reasonCodes: Set<ZvecMirrorReasonCode>,
): void {
  if (expected !== actual) {
    reasonCodes.add(
      field === 'zvecPackageVersion'
        ? 'zvec-package-version-mismatch'
        : field === 'embeddingModelHash'
        ? 'embedding-model-hash-mismatch'
        : field === 'sourceCommit'
        ? 'source-commit-mismatch'
        : field === 'currentHead'
        ? 'current-head-mismatch'
        : field === 'codeEmbeddingRowDigest'
        ? 'code-embedding-row-digest-mismatch'
        : field === 'backendIndexType'
        ? 'backend-index-type-mismatch'
        : 'malformed-metadata',
    );
  }
}

function compareOptionalStringField(
  field: 'graphIndexId' | 'graphIndexHash',
  expected: string | undefined,
  actual: string | undefined,
  reasonCodes: Set<ZvecMirrorReasonCode>,
): void {
  if (expected === undefined) return;
  if (expected !== actual) {
    reasonCodes.add(
      field === 'graphIndexId' ? 'graph-index-id-mismatch' : 'graph-index-hash-mismatch',
    );
  }
}

function compareNumberField(
  field: 'embeddingDimension' | 'codeEmbeddingRowCount',
  expected: number,
  actual: number,
  reasonCodes: Set<ZvecMirrorReasonCode>,
): void {
  if (expected !== actual) {
    reasonCodes.add(
      field === 'embeddingDimension'
        ? 'embedding-dimension-mismatch'
        : 'code-embedding-row-count-mismatch',
    );
  }
}

function compareStableJsonField(
  field: 'backendIndexParams',
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
  reasonCodes: Set<ZvecMirrorReasonCode>,
): void {
  if (stableJsonStringify(expected) !== stableJsonStringify(actual)) {
    reasonCodes.add(
      field === 'backendIndexParams' ? 'backend-index-params-mismatch' : 'malformed-metadata',
    );
  }
}

function canonicalEmbeddingRowKey(row: ZvecEmbeddingRowIdentity): string {
  return stableJsonStringify({
    chunkIndex: normalizeInteger(row.chunkIndex, 'chunkIndex'),
    contentHash: normalizeRequiredString(row.contentHash, 'contentHash'),
    id: normalizeRequiredString(row.id, 'id'),
    nodeId: normalizeRequiredString(row.nodeId, 'nodeId'),
  });
}

function normalizeEmbeddingRows(
  rows: readonly ZvecEmbeddingRowIdentity[],
): ZvecEmbeddingRowIdentity[] {
  return rows.map((row) => ({
    id: normalizeRequiredString(row.id, 'id'),
    nodeId: normalizeRequiredString(row.nodeId, 'nodeId'),
    chunkIndex: normalizeInteger(row.chunkIndex, 'chunkIndex'),
    contentHash: normalizeRequiredString(row.contentHash, 'contentHash'),
  }));
}

function normalizeTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return new Date().toISOString();
}

function normalizeRequiredString(value: unknown, field: string): string {
  const normalized = normalizeRequiredStringOrNull(value);
  if (normalized === null) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return normalized;
}

function normalizeRequiredStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeRequiredStringOrNull(value);
  return normalized ?? undefined;
}

function normalizePositiveInteger(value: unknown, field: string): number {
  const normalized = normalizePositiveIntegerOrNull(value);
  if (normalized === null) {
    throw new Error(`${field} must be a positive integer`);
  }
  return normalized;
}

function normalizePositiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeNonNegativeInteger(value: unknown, field: string): number {
  const normalized = normalizeNonNegativeIntegerOrNull(value);
  if (normalized === null) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return normalized;
}

function normalizeNonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function normalizeBackendIndexParams(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return normalizeBackendIndexParamsOrNull(value) ?? {};
}

function normalizeBackendIndexParamsOrNull(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value)) return null;
  return normalizeStableObject(value);
}

function normalizeStableObject(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const normalizedItem = normalizeStableValue(item);
    if (normalizedItem !== undefined) {
      normalized[key] = normalizedItem;
    }
  }
  return normalized;
}

function normalizeStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStableValue(item));
  }
  if (isPlainObject(value)) {
    return normalizeStableObject(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return undefined;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeStableValue(value));
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
