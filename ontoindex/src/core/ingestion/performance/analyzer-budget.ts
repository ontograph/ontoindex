export type AnalyzerBudgetSkipReason =
  | 'hard-disabled'
  | 'not-enabled'
  | 'file-limit'
  | 'byte-limit'
  | 'candidate-limit'
  | 'forbidden-engine'
  | 'scope-empty'
  | 'language-limit'
  | 'purpose-limit';

export interface AnalyzerBudgetPolicy {
  hardDisabled?: boolean;
  enabled?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  maxCandidates?: number;
}

export interface AnalyzerInputMetadata {
  fileCount?: number;
  byteCount?: number;
  candidateCount?: number;
  languageCount?: number;
  samplePaths?: readonly string[];
}

export interface BoundedAnalyzerInputMetadata {
  fileCount?: number;
  byteCount?: number;
  candidateCount?: number;
  languageCount?: number;
  samplePaths: string[];
  samplePathsTruncated: boolean;
}

export interface AnalyzerBudgetDecision {
  allowed: boolean;
  reason: 'allowed' | AnalyzerBudgetSkipReason;
  input: BoundedAnalyzerInputMetadata;
}

export type AnalyzerTimingStatus = 'completed' | 'failed' | 'skipped';

export interface AnalyzerResultMetadata {
  nodeCount?: number;
  edgeCount?: number;
  outputCount?: number;
  warningCount?: number;
}

export interface AnalyzerTimingRecord {
  analyzerId: string;
  status: AnalyzerTimingStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  input: BoundedAnalyzerInputMetadata;
  skippedReason?: AnalyzerBudgetSkipReason;
  result?: AnalyzerResultMetadata;
  errorMessage?: string;
}

export type PrecisionEngineKind =
  | 'tree-sitter-rule'
  | 'static-registry'
  | 'semantic-tag'
  | 'typescript-compiler-api'
  | 'lsp'
  | 'codeql'
  | 'joern'
  | 'daemon'
  | 'external-analyzer';

export type PrecisionPurpose =
  | 'type-aware-resolution'
  | 'call-resolution'
  | 'import-resolution'
  | 'security-invariant'
  | 'dataflow-invariant'
  | 'targeted-symbol-lookup';

export interface ScopedPrecisionPolicy extends AnalyzerBudgetPolicy {
  allowedLanguages?: readonly string[];
  allowedPurposes?: readonly PrecisionPurpose[];
  maxPrecisionFiles?: number;
  maxPrecisionLanguages?: number;
  maxPrecisionPurposes?: number;
}

export interface PrecisionScopeDeclaration {
  engineId: string;
  engineKind: PrecisionEngineKind;
  files: readonly string[];
  languages: readonly string[];
  purposes: readonly string[];
  input?: AnalyzerInputMetadata;
}

export interface BoundedPrecisionScopeDeclaration {
  engineId: string;
  engineKind: PrecisionEngineKind;
  files: string[];
  languages: string[];
  purposes: string[];
  input: BoundedAnalyzerInputMetadata;
}

export interface ScopedPrecisionDecision {
  allowed: boolean;
  reason: 'allowed' | AnalyzerBudgetSkipReason;
  scope: BoundedPrecisionScopeDeclaration;
}

export interface AnalyzerTimingRecordInput {
  analyzerId: string;
  status: AnalyzerTimingStatus;
  startedAt: string | Date;
  finishedAt: string | Date;
  input?: AnalyzerInputMetadata;
  skippedReason?: AnalyzerBudgetSkipReason;
  result?: AnalyzerResultMetadata;
  errorMessage?: string;
  maxSamplePaths?: number;
}

const DEFAULT_MAX_SAMPLE_PATHS = 10;
const MAX_SAMPLE_PATH_LENGTH = 256;
const FORBIDDEN_PRECISION_ENGINE_KINDS = new Set<PrecisionEngineKind>([
  'typescript-compiler-api',
  'lsp',
  'codeql',
  'joern',
  'daemon',
  'external-analyzer',
]);

export function decideAnalyzerBudget(
  policy: AnalyzerBudgetPolicy = {},
  input: AnalyzerInputMetadata = {},
): AnalyzerBudgetDecision {
  const boundedInput = boundAnalyzerInputMetadata(input);

  if (policy.hardDisabled === true) {
    return { allowed: false, reason: 'hard-disabled', input: boundedInput };
  }

  if (policy.enabled !== true) {
    return { allowed: false, reason: 'not-enabled', input: boundedInput };
  }

  if (exceedsLimit(boundedInput.fileCount, policy.maxFiles)) {
    return { allowed: false, reason: 'file-limit', input: boundedInput };
  }

  if (exceedsLimit(boundedInput.byteCount, policy.maxBytes)) {
    return { allowed: false, reason: 'byte-limit', input: boundedInput };
  }

  if (exceedsLimit(boundedInput.candidateCount, policy.maxCandidates)) {
    return { allowed: false, reason: 'candidate-limit', input: boundedInput };
  }

  return { allowed: true, reason: 'allowed', input: boundedInput };
}

export function decideScopedPrecisionPolicy(
  policy: ScopedPrecisionPolicy = {},
  declaration: Partial<PrecisionScopeDeclaration> = {},
): ScopedPrecisionDecision {
  const scope = boundPrecisionScopeDeclaration(declaration);
  const budget = decideAnalyzerBudget(policy, {
    ...declaration.input,
    fileCount: scope.files.length,
    languageCount: scope.languages.length,
  });

  if (!budget.allowed) {
    return { allowed: false, reason: budget.reason, scope };
  }

  if (
    scope.engineId.length === 0 ||
    scope.files.length === 0 ||
    scope.languages.length === 0 ||
    scope.purposes.length === 0
  ) {
    return { allowed: false, reason: 'scope-empty', scope };
  }

  if (FORBIDDEN_PRECISION_ENGINE_KINDS.has(scope.engineKind)) {
    return { allowed: false, reason: 'forbidden-engine', scope };
  }

  if (!scope.purposes.every(isPrecisionPurpose)) {
    return { allowed: false, reason: 'purpose-limit', scope };
  }

  if (exceedsLimit(scope.files.length, policy.maxPrecisionFiles)) {
    return { allowed: false, reason: 'file-limit', scope };
  }

  if (exceedsLimit(scope.languages.length, policy.maxPrecisionLanguages)) {
    return { allowed: false, reason: 'language-limit', scope };
  }

  if (exceedsLimit(scope.purposes.length, policy.maxPrecisionPurposes)) {
    return { allowed: false, reason: 'purpose-limit', scope };
  }

  if (!isSubsetOfAllowed(scope.languages, policy.allowedLanguages)) {
    return { allowed: false, reason: 'language-limit', scope };
  }

  if (!isSubsetOfAllowed(scope.purposes, policy.allowedPurposes)) {
    return { allowed: false, reason: 'purpose-limit', scope };
  }

  return { allowed: true, reason: 'allowed', scope };
}

export function createAnalyzerTimingRecord(input: AnalyzerTimingRecordInput): AnalyzerTimingRecord {
  const analyzerId = input.analyzerId.trim();
  if (analyzerId.length === 0) {
    throw new Error('Analyzer timing record requires analyzerId');
  }

  if (input.status === 'skipped' && input.skippedReason === undefined) {
    throw new Error('Analyzer timing record requires skippedReason when status is skipped');
  }

  const startedAt = toIsoTimestamp(input.startedAt, 'startedAt');
  const finishedAt = toIsoTimestamp(input.finishedAt, 'finishedAt');
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (durationMs < 0) {
    throw new Error('Analyzer timing record requires finishedAt to be after startedAt');
  }

  const record: AnalyzerTimingRecord = {
    analyzerId,
    status: input.status,
    startedAt,
    finishedAt,
    durationMs,
    input: boundAnalyzerInputMetadata(input.input, input.maxSamplePaths),
  };

  if (input.skippedReason !== undefined) {
    record.skippedReason = input.skippedReason;
  }

  const result = boundAnalyzerResultMetadata(input.result);
  if (result !== undefined) {
    record.result = result;
  }

  if (input.errorMessage !== undefined) {
    record.errorMessage = input.errorMessage;
  }

  return record;
}

export function boundAnalyzerInputMetadata(
  input: AnalyzerInputMetadata = {},
  maxSamplePaths = DEFAULT_MAX_SAMPLE_PATHS,
): BoundedAnalyzerInputMetadata {
  const safeMaxSamplePaths = Number.isFinite(maxSamplePaths)
    ? Math.max(0, Math.floor(maxSamplePaths))
    : DEFAULT_MAX_SAMPLE_PATHS;
  const samplePaths = (input.samplePaths ?? [])
    .slice(0, safeMaxSamplePaths)
    .map((path) => path.slice(0, MAX_SAMPLE_PATH_LENGTH));

  return {
    fileCount: toNonNegativeInteger(input.fileCount),
    byteCount: toNonNegativeInteger(input.byteCount),
    candidateCount: toNonNegativeInteger(input.candidateCount),
    languageCount: toNonNegativeInteger(input.languageCount),
    samplePaths,
    samplePathsTruncated: (input.samplePaths?.length ?? 0) > safeMaxSamplePaths,
  };
}

function boundPrecisionScopeDeclaration(
  declaration: Partial<PrecisionScopeDeclaration>,
): BoundedPrecisionScopeDeclaration {
  return {
    engineId: (declaration.engineId ?? '').trim(),
    engineKind: declaration.engineKind ?? 'external-analyzer',
    files: uniqueTrimmed(declaration.files).filter((filePath) => !isAbsolutePath(filePath)),
    languages: uniqueTrimmed(declaration.languages),
    purposes: uniqueTrimmed(declaration.purposes),
    input: boundAnalyzerInputMetadata(declaration.input),
  };
}

function isPrecisionPurpose(value: string): value is PrecisionPurpose {
  return ALLOWED_PRECISION_PURPOSES.has(value as PrecisionPurpose);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function exceedsLimit(value: number | undefined, limit: number | undefined): boolean {
  const safeLimit = toNonNegativeInteger(limit);
  return value !== undefined && safeLimit !== undefined && value > safeLimit;
}

function toNonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function uniqueTrimmed(values: readonly string[] | undefined): string[] {
  return Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}

function isSubsetOfAllowed(
  values: readonly string[],
  allowedValues: readonly string[] | undefined,
): boolean {
  if (allowedValues === undefined) {
    return true;
  }
  const allowed = new Set(uniqueTrimmed(allowedValues));
  return values.every((value) => allowed.has(value));
}

const ALLOWED_PRECISION_PURPOSES = new Set<PrecisionPurpose>([
  'type-aware-resolution',
  'call-resolution',
  'import-resolution',
  'security-invariant',
  'dataflow-invariant',
  'targeted-symbol-lookup',
]);

function toIsoTimestamp(value: string | Date, fieldName: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Analyzer timing record requires valid ${fieldName}`);
  }
  return date.toISOString();
}

function boundAnalyzerResultMetadata(
  result: AnalyzerResultMetadata | undefined,
): AnalyzerResultMetadata | undefined {
  if (result === undefined) {
    return undefined;
  }

  return {
    nodeCount: toNonNegativeInteger(result.nodeCount),
    edgeCount: toNonNegativeInteger(result.edgeCount),
    outputCount: toNonNegativeInteger(result.outputCount),
    warningCount: toNonNegativeInteger(result.warningCount),
  };
}
