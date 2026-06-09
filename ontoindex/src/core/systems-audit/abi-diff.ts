export const ABI_DIFF_ANALYZER_ID = 'gn_abi_diff';
export const ABI_DIFF_ANALYZER_VERSION = '0.1.0';
export const ABI_DIFF_SIDECAR_RECORD_KIND = 'systems.abi_diff';

export type AbiDiffReasonCode =
  | 'FIELD_TYPE_MISMATCH'
  | 'UINT64_PRECISION_LOSS'
  | 'BIGINT_NUMBER_MISMATCH'
  | 'FIELD_MISSING_IN_TARGET'
  | 'FIELD_MISSING_IN_SOURCE'
  | 'NULLABILITY_MISMATCH'
  | 'JSON_SNIPPET_INFERRED'
  | 'RESPONSE_LIMIT';

export interface AbiField {
  name: string;
  rawType: string;
  normalizedType:
    | 'integer'
    | 'float'
    | 'string'
    | 'boolean'
    | 'object'
    | 'array'
    | 'bigint'
    | 'unknown';
  nullable: boolean;
  line: number;
  origin: 'source' | 'target';
}

export interface AbiDiffFinding {
  id: string;
  field: string;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  message: string;
  reasonCodes: AbiDiffReasonCode[];
  sourceField?: AbiField;
  targetField?: AbiField;
  falsePositiveNotes: string[];
}

export interface AbiDiffParams {
  sourceStruct: string;
  targetInterface: string;
  sourceLanguage?: 'cpp' | 'rust' | 'json';
  targetLanguage?: 'typescript' | 'json';
  sourcePath?: string;
  targetPath?: string;
  maxFindings?: number;
}

export interface AbiDiffReport {
  version: 1;
  tool: typeof ABI_DIFF_ANALYZER_ID;
  status: 'ok' | 'partial';
  sidecarRecord: {
    kind: typeof ABI_DIFF_SIDECAR_RECORD_KIND;
    analyzerId: typeof ABI_DIFF_ANALYZER_ID;
    analyzerVersion: typeof ABI_DIFF_ANALYZER_VERSION;
    provenance: {
      sourcePath?: string;
      targetPath?: string;
      mode: 'bounded-static-heuristic';
    };
  };
  primaryGraphFacts: unknown[];
  systemsEvidence: AbiField[];
  findings: AbiDiffFinding[];
  limits: {
    truncated: boolean;
    maxFindings: number;
    emitted: number;
    total: number;
  };
  freshness: {
    status: 'not-applicable';
    reason: string;
  };
  skipReasons: string[];
  warnings: string[];
  nextTools: string[];
}

const DEFAULT_MAX_FINDINGS = 50;
const MAX_FINDINGS = 100;

export function diffAbi(params: AbiDiffParams): AbiDiffReport {
  const maxFindings = normalizeLimit(params.maxFindings, DEFAULT_MAX_FINDINGS, MAX_FINDINGS);
  const warnings: string[] = [];
  const sourceFields = parseSourceFields(params.sourceStruct, params.sourceLanguage, warnings);
  const targetFields = parseTargetFields(params.targetInterface, params.targetLanguage, warnings);
  const findings = compareFields(sourceFields, targetFields);
  const boundedFindings = findings.slice(0, maxFindings);
  const truncated = findings.length > maxFindings;
  if (truncated) {
    warnings.push(`ABI findings truncated from ${findings.length} to ${maxFindings}`);
  }

  return {
    version: 1,
    tool: ABI_DIFF_ANALYZER_ID,
    status: truncated ? 'partial' : 'ok',
    sidecarRecord: {
      kind: ABI_DIFF_SIDECAR_RECORD_KIND,
      analyzerId: ABI_DIFF_ANALYZER_ID,
      analyzerVersion: ABI_DIFF_ANALYZER_VERSION,
      provenance: {
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        mode: 'bounded-static-heuristic',
      },
    },
    primaryGraphFacts: [],
    systemsEvidence: [...sourceFields, ...targetFields],
    findings: boundedFindings,
    limits: { truncated, maxFindings, emitted: boundedFindings.length, total: findings.length },
    freshness: {
      status: 'not-applicable',
      reason: 'ABI diff MVP consumes caller-supplied snippets only',
    },
    skipReasons:
      sourceFields.length === 0 || targetFields.length === 0
        ? ['source or target snippet yielded no comparable fields']
        : [],
    warnings,
    nextTools: ['gn_audit_verify'],
  };
}

function compareFields(sourceFields: AbiField[], targetFields: AbiField[]): AbiDiffFinding[] {
  const findings: AbiDiffFinding[] = [];
  const sourceByName = new Map(sourceFields.map((field) => [field.name, field]));
  const targetByName = new Map(targetFields.map((field) => [field.name, field]));

  for (const source of sourceFields) {
    const target = targetByName.get(source.name);
    if (!target) {
      findings.push(
        finding(
          source.name,
          'medium',
          `field ${source.name} is missing in target contract`,
          ['FIELD_MISSING_IN_TARGET'],
          source,
          undefined,
        ),
      );
      continue;
    }
    const reasonCodes = typeReasonCodes(source, target);
    if (reasonCodes.length > 0) {
      findings.push(
        finding(
          source.name,
          reasonCodes.includes('UINT64_PRECISION_LOSS') ? 'high' : 'medium',
          `field ${source.name} differs: ${source.rawType} vs ${target.rawType}`,
          reasonCodes,
          source,
          target,
        ),
      );
    }
    if (source.nullable !== target.nullable) {
      findings.push(
        finding(
          source.name,
          'medium',
          `field ${source.name} nullability differs`,
          ['NULLABILITY_MISMATCH'],
          source,
          target,
        ),
      );
    }
  }

  for (const target of targetFields) {
    if (!sourceByName.has(target.name)) {
      findings.push(
        finding(
          target.name,
          'low',
          `field ${target.name} is missing in source contract`,
          ['FIELD_MISSING_IN_SOURCE'],
          undefined,
          target,
        ),
      );
    }
  }

  return findings;
}

function typeReasonCodes(source: AbiField, target: AbiField): AbiDiffReasonCode[] {
  const reasons: AbiDiffReasonCode[] = [];
  const sourceIsWideInt = /\b(u?int64_t|uint64|i64|u64|long long|unsigned long long)\b/i.test(
    source.rawType,
  );
  if (
    sourceIsWideInt &&
    target.normalizedType === 'integer' &&
    /\bnumber\b/i.test(target.rawType)
  ) {
    reasons.push('UINT64_PRECISION_LOSS');
  }
  if (
    (source.normalizedType === 'bigint' && target.normalizedType === 'integer') ||
    (source.normalizedType === 'integer' && target.normalizedType === 'bigint')
  ) {
    reasons.push('BIGINT_NUMBER_MISMATCH');
  }
  if (source.normalizedType !== target.normalizedType && reasons.length === 0) {
    reasons.push('FIELD_TYPE_MISMATCH');
  }
  return reasons;
}

function finding(
  field: string,
  severity: AbiDiffFinding['severity'],
  message: string,
  reasonCodes: AbiDiffReasonCode[],
  sourceField?: AbiField,
  targetField?: AbiField,
): AbiDiffFinding {
  return {
    id: `abi-diff:${field}:${stableHash(reasonCodes.join('|'))}`,
    field,
    severity,
    confidence: reasonCodes.includes('JSON_SNIPPET_INFERRED') ? 0.62 : 0.82,
    message,
    reasonCodes,
    sourceField,
    targetField,
    falsePositiveNotes: [
      'bounded ABI heuristic does not evaluate serializers, custom codecs, endian conversion, or generated bindings',
    ],
  };
}

function parseSourceFields(
  snippet: string,
  language: AbiDiffParams['sourceLanguage'] | undefined,
  warnings: string[],
): AbiField[] {
  if (language === 'json' || looksLikeJson(snippet)) {
    warnings.push('source fields inferred from JSON values');
    return parseJsonFields(snippet, 'source');
  }
  return [...parseRustFields(snippet, 'source'), ...parseCppFields(snippet, 'source')].filter(
    uniqueField,
  );
}

function parseTargetFields(
  snippet: string,
  language: AbiDiffParams['targetLanguage'] | undefined,
  warnings: string[],
): AbiField[] {
  if (language === 'json' || looksLikeJson(snippet)) {
    warnings.push('target fields inferred from JSON values');
    return parseJsonFields(snippet, 'target');
  }
  return parseTypeScriptFields(snippet, 'target');
}

function parseCppFields(snippet: string, origin: AbiField['origin']): AbiField[] {
  const fields: AbiField[] = [];
  for (const [index, rawLine] of snippet.split('\n').entries()) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    const match = line.match(
      /^([A-Za-z_][\w:<>]*\s*(?:\*|&)?)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]+\])?\s*;/,
    );
    if (!match) continue;
    fields.push(field(match[2], match[1], index + 1, origin));
  }
  return fields;
}

function parseRustFields(snippet: string, origin: AbiField['origin']): AbiField[] {
  const fields: AbiField[] = [];
  for (const [index, rawLine] of snippet.split('\n').entries()) {
    const line = rawLine
      .replace(/\/\/.*$/, '')
      .trim()
      .replace(/^pub\s+/, '');
    const match = line.match(/^([A-Za-z_]\w*)\s*:\s*([^,]+),?/);
    if (!match) continue;
    fields.push(field(match[1], match[2], index + 1, origin));
  }
  return fields;
}

function parseTypeScriptFields(snippet: string, origin: AbiField['origin']): AbiField[] {
  const fields: AbiField[] = [];
  for (const [index, rawLine] of snippet.split('\n').entries()) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    const match = line.match(/^([A-Za-z_]\w*)(\?)?\s*:\s*([^;,\n]+)/);
    if (!match) continue;
    fields.push(field(match[1], `${match[3]}${match[2] ? ' | undefined' : ''}`, index + 1, origin));
  }
  return fields;
}

function parseJsonFields(snippet: string, origin: AbiField['origin']): AbiField[] {
  try {
    const value = JSON.parse(snippet) as Record<string, unknown>;
    if (!value || Array.isArray(value) || typeof value !== 'object') return [];
    return Object.entries(value).map(([name, jsonValue], index) =>
      field(name, jsonType(jsonValue), index + 1, origin),
    );
  } catch {
    return [];
  }
}

function field(name: string, rawType: string, line: number, origin: AbiField['origin']): AbiField {
  return {
    name,
    rawType: rawType.trim(),
    normalizedType: normalizeType(rawType),
    nullable: /\b(null|undefined|Option<|\?)\b/.test(rawType),
    line,
    origin,
  };
}

function normalizeType(rawType: string): AbiField['normalizedType'] {
  const type = rawType.trim().toLowerCase();
  if (/\b(bigint|u64|i64)\b/.test(type)) return 'bigint';
  if (/\b(u?int\d*_t|uint\d*|int\d*|size_t|usize|isize|long|short|number)\b/.test(type))
    return 'integer';
  if (/\b(float|double|f32|f64)\b/.test(type)) return 'float';
  if (/\b(string|char\s*\*|std::string|str)\b/.test(type)) return 'string';
  if (/\b(bool|boolean)\b/.test(type)) return 'boolean';
  if (/\[\]|array|vec<|vector</.test(type)) return 'array';
  if (/\b(object|record|struct)\b/.test(type)) return 'object';
  return 'unknown';
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function looksLikeJson(snippet: string): boolean {
  return snippet.trim().startsWith('{');
}

function uniqueField(fieldValue: AbiField, index: number, fields: AbiField[]): boolean {
  return fields.findIndex((candidate) => candidate.name === fieldValue.name) === index;
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
