import {
  validateRetrievalReplayIdentity,
  type RetrievalReplayIdentity,
} from './result-identity.js';
import {
  RETRIEVAL_POLICY_NAMES,
  isRetrievalPolicyName,
  type RetrievalPolicyName,
} from '../../ingestion/enrichment/docs-retrieval-policies.js';

export const RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION = 1;

export type RetrievalReplaySchemaVersion = typeof RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION;
export type RetrievalReplayQualityMode = 'fast' | 'balanced' | 'thorough';
export type RetrievalReplayRequestAction = 'semantic';

export interface RetrievalReplayCaseRequest {
  action: RetrievalReplayRequestAction;
  typedQuery?: boolean;
  retrievalPolicy?: RetrievalPolicyName;
  includeSkeleton?: boolean;
  includeContent?: boolean;
  consumeEnrichmentFacts?: boolean;
  includePassiveRelatedFacts?: boolean;
  includeMarkdownContext?: boolean;
  includeMarkdownPpr?: boolean;
  limit?: number;
  qualityMode?: RetrievalReplayQualityMode;
}

export interface RetrievalReplayCaseExpected {
  topK: number;
  identities: readonly RetrievalReplayIdentity[];
  minimumJaccardAtK?: number;
  requireTop1Stable?: boolean;
  allowedCapabilityDrift?: readonly string[];
}

export interface RetrievalReplayCaseV1 {
  schemaVersion: RetrievalReplaySchemaVersion;
  id: string;
  repoHint?: string;
  query: string;
  request: RetrievalReplayCaseRequest;
  expected: RetrievalReplayCaseExpected;
  notes?: readonly string[];
}

export interface RetrievalReplayCaseValidationError {
  path: string;
  message: string;
}

export interface RetrievalReplayCaseValidationResult {
  ok: boolean;
  case?: RetrievalReplayCaseV1;
  errors?: readonly RetrievalReplayCaseValidationError[];
}

export function parseRetrievalReplayCase(value: unknown): RetrievalReplayCaseV1 {
  const result = validateRetrievalReplayCase(value);
  if (!result.ok || result.case === undefined) {
    throw new Error(
      `invalid retrieval replay case: ${
        result.errors?.map((error) => `${error.path}: ${error.message}`).join('; ') ??
        'unknown error'
      }`,
    );
  }
  return result.case;
}

export function validateRetrievalReplayCase(value: unknown): RetrievalReplayCaseValidationResult {
  if (!isRecord(value)) {
    return { ok: false, errors: [{ path: 'case', message: 'must be an object' }] };
  }

  const record = value as Record<string, unknown>;
  const errors: RetrievalReplayCaseValidationError[] = [];
  const schemaVersion = requireNumber(record.schemaVersion, 'schemaVersion', errors);
  if (schemaVersion === undefined) {
    return { ok: false, errors };
  }

  if (schemaVersion !== RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        {
          path: 'schemaVersion',
          message: `unsupported schemaVersion "${schemaVersion}". Expected ${RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION}.`,
        },
      ],
    };
  }

  const id = requireString(record.id, 'id', errors);
  const query = requireString(record.query, 'query', errors);
  const repoHint = optionalString(record.repoHint);
  const notes = optionalStringArray(record.notes, 'notes', errors);

  const request = parseReplayRequest(record.request, 'request', errors);
  const expected = parseReplayExpected(record.expected, 'expected', errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    case: {
      schemaVersion: RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
      id,
      query,
      repoHint,
      request,
      expected: expected!,
      notes,
    },
  };
}

function parseReplayRequest(
  value: unknown,
  path: string,
  errors: RetrievalReplayCaseValidationError[],
): RetrievalReplayCaseRequest {
  const empty: RetrievalReplayCaseRequest = { action: 'semantic' };
  if (value === undefined) {
    errors.push({ path, message: 'must be an object' });
    return empty;
  }
  if (value === null || Array.isArray(value)) {
    errors.push({ path, message: 'must be an object' });
    return empty;
  }

  const request = value as Record<string, unknown>;

  const action = requireOptionalString(request.action, `${path}.action`, errors);
  if (action === undefined) {
    errors.push({ path: `${path}.action`, message: 'action must be semantic' });
  } else if (action !== 'semantic') {
    errors.push({ path: `${path}.action`, message: 'action must be semantic' });
  }

  const retrievalPolicy =
    request.retrievalPolicy !== undefined && isRetrievalPolicyName(request.retrievalPolicy)
      ? (request.retrievalPolicy as RetrievalPolicyName)
      : undefined;
  if (request.retrievalPolicy !== undefined && retrievalPolicy === undefined) {
    errors.push({
      path: `${path}.retrievalPolicy`,
      message: `retrievalPolicy must be one of ${RETRIEVAL_POLICY_NAMES.join(', ')}`,
    });
  }

  const qualityMode = request.qualityMode as unknown;
  if (
    qualityMode !== undefined &&
    qualityMode !== 'fast' &&
    qualityMode !== 'balanced' &&
    qualityMode !== 'thorough'
  ) {
    errors.push({
      path: `${path}.qualityMode`,
      message: 'qualityMode must be fast, balanced, or thorough',
    });
  }

  const limit = optionalNumber(request.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    errors.push({ path: `${path}.limit`, message: 'limit must be a positive integer' });
  }

  const includeContent = optionalBoolean(request.includeContent);
  const includeSkeleton = optionalBoolean(request.includeSkeleton);
  const typedQuery = optionalBoolean(request.typedQuery);
  const consumeEnrichmentFacts = optionalBoolean(request.consumeEnrichmentFacts);
  const includePassiveRelatedFacts = optionalBoolean(request.includePassiveRelatedFacts);
  const includeMarkdownContext = optionalBoolean(request.includeMarkdownContext);
  const includeMarkdownPpr = optionalBoolean(request.includeMarkdownPpr);

  return {
    action: 'semantic',
    typedQuery,
      retrievalPolicy,
    includeSkeleton,
    includeContent,
    consumeEnrichmentFacts,
    includePassiveRelatedFacts,
    includeMarkdownContext,
    includeMarkdownPpr,
    limit,
    qualityMode:
      qualityMode === 'fast' || qualityMode === 'balanced' || qualityMode === 'thorough'
        ? qualityMode
        : undefined,
  };
}

function parseReplayExpected(
  value: unknown,
  path: string,
  errors: RetrievalReplayCaseValidationError[],
): RetrievalReplayCaseExpected | undefined {
  const fallback: RetrievalReplayCaseExpected = {
    topK: 5,
    identities: [],
  };
  if (value === undefined) {
    errors.push({ path, message: 'must be an object' });
    return undefined;
  }
  if (value === null) {
    errors.push({ path, message: 'must be an object' });
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object' });
    return undefined;
  }
  const record = value as Record<string, unknown>;

  const topK = requireNumber(record.topK, `${path}.topK`, errors);
  if (topK === undefined) {
    return undefined;
  }
  if (!Number.isInteger(topK) || topK <= 0) {
    errors.push({ path: `${path}.topK`, message: 'topK must be a positive integer' });
  }

  const identityEntries = optionalArray(record.identities);
  if (identityEntries === undefined) {
    errors.push({ path: `${path}.identities`, message: 'identities must be an array' });
    return fallback;
  }
  if (identityEntries.length === 0) {
    errors.push({ path: `${path}.identities`, message: 'identities must include at least one entry' });
  }

  const identities: RetrievalReplayIdentity[] = [];
  for (const [index, item] of identityEntries.entries()) {
    const validation = validateRetrievalReplayIdentity(item, `${path}.identities[${index}]`);
    if (validation.ok === true) {
      identities.push(validation.identity);
      continue;
    }
    errors.push(...validation.errors);
  }

  const minimumJaccardAtK = optionalNumber(record.minimumJaccardAtK);
  if (minimumJaccardAtK !== undefined && !Number.isFinite(minimumJaccardAtK)) {
    errors.push({ path: `${path}.minimumJaccardAtK`, message: 'minimumJaccardAtK must be a finite number' });
  } else if (minimumJaccardAtK !== undefined && minimumJaccardAtK < 0) {
    errors.push({ path: `${path}.minimumJaccardAtK`, message: 'minimumJaccardAtK must be at least 0' });
  } else if (minimumJaccardAtK !== undefined && minimumJaccardAtK > 1) {
    errors.push({ path: `${path}.minimumJaccardAtK`, message: 'minimumJaccardAtK cannot exceed 1' });
  }

  const requireTop1Stable = optionalBoolean(record.requireTop1Stable);
  const allowedCapabilityDrift = optionalStringArray(
    record.allowedCapabilityDrift,
    `${path}.allowedCapabilityDrift`,
    errors,
  );

  return {
    topK,
    identities,
    minimumJaccardAtK,
    requireTop1Stable,
    allowedCapabilityDrift,
  };
}

function requireString(value: unknown, path: string, errors: RetrievalReplayCaseValidationError[]): string {
  const parsed = requireOptionalString(value, path, errors);
  if (parsed === undefined) {
    return '';
  }
  return parsed;
}

function requireOptionalString(
  value: unknown,
  path: string,
  errors?: RetrievalReplayCaseValidationError[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    if (errors) {
      errors.push({ path, message: 'must be a string' });
    }
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    if (errors) {
      errors.push({ path, message: 'must be a non-empty string' });
    }
    return undefined;
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function optionalStringArray(
  value: unknown,
  path: string,
  errors: RetrievalReplayCaseValidationError[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be an array of strings' });
    return undefined;
  }

  const output: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      errors.push({ path: `${path}[${index}]`, message: 'must be a string' });
      continue;
    }
    const normalized = entry.trim();
    if (normalized.length > 0) {
      output.push(normalized);
    }
  }
  return output;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireNumber(
  value: unknown,
  path: string,
  errors: RetrievalReplayCaseValidationError[],
): number | undefined {
  const parsed = optionalNumber(value);
  if (parsed === undefined) {
    errors.push({ path, message: 'must be a finite number' });
    return undefined;
  }
  return parsed;
}

function optionalArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
