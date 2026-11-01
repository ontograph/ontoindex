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

interface ParsedFields {
  fields: AbiField[];
  complete: boolean;
  warnings: string[];
}

export function diffAbi(params: AbiDiffParams): AbiDiffReport {
  const maxFindings = normalizeLimit(params.maxFindings, DEFAULT_MAX_FINDINGS, MAX_FINDINGS);
  const source = parseSourceFields(params.sourceStruct, params.sourceLanguage);
  const target = parseTargetFields(params.targetInterface, params.targetLanguage);
  const warnings = [...source.warnings, ...target.warnings];
  const sourceFields = source.fields;
  const targetFields = target.fields;
  const noComparableFields = sourceFields.length === 0 || targetFields.length === 0;
  const findings = compareFields(source, target);
  const boundedFindings = findings.slice(0, maxFindings);
  const truncated = findings.length > maxFindings;
  if (truncated) {
    warnings.push(`ABI findings truncated from ${findings.length} to ${maxFindings}`);
  }

  return {
    version: 1,
    tool: ABI_DIFF_ANALYZER_ID,
    status:
      truncated || !source.complete || !target.complete || noComparableFields ? 'partial' : 'ok',
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
    skipReasons: noComparableFields
      ? ['source or target snippet yielded no comparable fields']
      : [],
    warnings,
    nextTools: ['gn_audit_verify'],
  };
}

function compareFields(sourceResult: ParsedFields, targetResult: ParsedFields): AbiDiffFinding[] {
  const sourceFields = sourceResult.fields;
  const targetFields = targetResult.fields;
  const findings: AbiDiffFinding[] = [];
  const sourceByName = new Map(sourceFields.map((field) => [field.name, field]));
  const targetByName = new Map(targetFields.map((field) => [field.name, field]));

  for (const source of sourceFields) {
    const target = targetByName.get(source.name);
    if (!target) {
      if (!targetResult.complete) continue;
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
    if (sourceResult.complete && !sourceByName.has(target.name)) {
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
): ParsedFields {
  if (language === 'json' || (language === undefined && looksLikeJson(snippet))) {
    return parseJsonFields(snippet, 'source');
  }
  const content = maskComments(snippet).trimStart();
  const inferredLanguage =
    /^(?:pub\s+)?(?:struct\s+\w+\s*\{|\w+\s*:)/.test(content) &&
    (/^pub\b/.test(content) ||
      /^\w+\s*:(?!:)/.test(content) ||
      /\{\s*(?:pub\s+)?\w+\s*:(?!:)/.test(content))
      ? 'rust'
      : 'cpp';
  return parseDeclarations(snippet, language ?? inferredLanguage, 'source');
}

function parseTargetFields(
  snippet: string,
  language: AbiDiffParams['targetLanguage'] | undefined,
): ParsedFields {
  if (language === 'json' || (language === undefined && looksLikeJson(snippet))) {
    return parseJsonFields(snippet, 'target');
  }
  return parseDeclarations(snippet, 'typescript', 'target');
}

function maskComments(snippet: string): string {
  return snippet.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\r\n]/g, ' '),
  );
}

function parseDeclarations(
  snippet: string,
  language: 'cpp' | 'rust' | 'typescript',
  origin: AbiField['origin'],
): ParsedFields {
  // slim: recognize sequential simple declarations only; use a grammar if richer members are needed.
  const content = maskComments(snippet);
  const fields: AbiField[] = [];
  let offset = content.search(/\S/);
  const incomplete = (reason: string): ParsedFields => ({
    fields,
    complete: false,
    warnings: [`${origin} parsing incomplete: ${reason}`],
  });
  if (offset < 0) return incomplete('empty snippet');

  const wrappers = {
    cpp: /^(?:struct|class)\s+[A-Za-z_]\w*\s*\{/,
    rust: /^(?:pub\s+)?struct\s+[A-Za-z_]\w*\s*\{/,
    typescript: /^(?:export\s+)?(?:interface\s+[A-Za-z_]\w*\s*|type\s+[A-Za-z_]\w*\s*=\s*)\{/,
  };
  const wrapper = wrappers[language].exec(content.slice(offset));
  if (wrapper) offset += wrapper[0].length;

  while (offset < content.length) {
    offset += /^\s*/.exec(content.slice(offset))![0].length;
    if (wrapper && content[offset] === '}') {
      const tail = content.slice(offset + 1).trim();
      if (tail !== '' && tail !== ';') return incomplete('unsupported trailing syntax');
      return { fields, complete: true, warnings: [] };
    }
    if (offset === content.length) break;
    const line = content.slice(0, offset).split('\n').length;
    const remaining = content.slice(offset);
    let name: string;
    let rawType: string;
    let consumed: number;

    if (language === 'cpp') {
      const declaration = /^([^;{}]+);/.exec(remaining);
      const member =
        declaration && /^([\s\S]+[\s*&])([A-Za-z_]\w*)\s*$/.exec(declaration[1].trim());
      if (!declaration || !member) return incomplete(`unsupported declaration at line ${line}`);
      [, rawType, name] = member;
      if (
        !/^(?:(?:const|volatile|signed|unsigned|short|long)\s+)*[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\s+(?:const|volatile))*(?:\s*\*\s*(?:(?:const|volatile)\s*)*)?$/.test(
          rawType.trim(),
        )
      ) {
        return incomplete(`unsupported type at line ${line}`);
      }
      consumed = declaration[0].length;
    } else {
      const declaration =
        language === 'rust'
          ? /^(?:pub\s+)?([A-Za-z_]\w*)\s*:\s*([^,;\r\n{}]+)(?:,|(?=\s*(?:}|$)))/.exec(remaining)
          : /^([A-Za-z_]\w*)(\?)?\s*:\s*([^,;\r\n{}]+)(?:[;,]|(?=\r?\n|}|$))/.exec(remaining);
      if (!declaration) return incomplete(`unsupported declaration at line ${line}`);
      name = declaration[1];
      rawType = language === 'rust' ? declaration[2] : declaration[3];
      const supportedType =
        language === 'rust'
          ? /^(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*|Option\s*<\s*[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\s*>)$/
          : /^(?:number|bigint|string|boolean|object)(?:\s*\|\s*(?:null|undefined))*$/;
      if (!supportedType.test(rawType.trim()))
        return incomplete(`unsupported type at line ${line}`);
      if (language === 'typescript' && declaration[2]) rawType += ' | undefined';
      consumed = declaration[0].length;
    }

    const parsed = field(name, rawType, line, origin);
    if (parsed.normalizedType === 'unknown') return incomplete(`unknown type at line ${line}`);
    const duplicate = fields.findIndex((existing) => existing.name === name);
    if (duplicate !== -1) {
      fields.splice(duplicate, 1);
      return incomplete(`duplicate field at line ${line}`);
    }
    fields.push(parsed);
    offset += consumed;
  }
  return wrapper ? incomplete('unclosed declaration') : { fields, complete: true, warnings: [] };
}

function parseJsonFields(snippet: string, origin: AbiField['origin']): ParsedFields {
  const warnings = [`${origin} fields inferred from JSON values`];
  try {
    const value = JSON.parse(snippet) as Record<string, unknown>;
    if (value && !Array.isArray(value) && typeof value === 'object') {
      const fields: AbiField[] = [];
      const names = new Set<string>();
      let depth = 0;
      let complete = true;
      // JSON.parse validates syntax; tokens only recover top-level key locations and duplicates.
      for (const token of snippet.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
        if (token[0] === '{' || token[0] === '[') depth += 1;
        else if (token[0] === '}' || token[0] === ']') depth -= 1;
        else if (depth === 1 && /^\s*:/.test(snippet.slice(token.index! + token[0].length))) {
          const name = JSON.parse(token[0]) as string;
          if (names.has(name)) {
            const duplicate = fields.findIndex((existing) => existing.name === name);
            if (duplicate !== -1) fields.splice(duplicate, 1);
            complete = false;
          } else {
            names.add(name);
            fields.push(
              field(
                name,
                jsonType(value[name]),
                snippet.slice(0, token.index).split('\n').length,
                origin,
              ),
            );
          }
        }
      }
      if (!complete) warnings.push(`${origin} parsing incomplete: duplicate JSON field`);
      return {
        fields,
        complete,
        warnings,
      };
    }
  } catch {
    // Invalid JSON cannot establish field absence.
  }
  return {
    fields: [],
    complete: false,
    warnings: [...warnings, `${origin} parsing incomplete: expected a JSON object`],
  };
}

function field(name: string, rawType: string, line: number, origin: AbiField['origin']): AbiField {
  return {
    name,
    rawType: rawType.trim(),
    normalizedType: normalizeType(rawType),
    nullable: /\b(?:null|undefined)\b|\bOption\s*</.test(rawType),
    line,
    origin,
  };
}

function normalizeType(rawType: string): AbiField['normalizedType'] {
  const type = rawType.trim().toLowerCase();
  const unqualified = type.replace(/\b(?:const|volatile)\b/g, '').trim();
  if (/^char\s*\*$/.test(unqualified)) return 'string';
  if (unqualified.includes('*')) return 'unknown';
  if (/\b(bigint|u64|i64)\b/.test(type)) return 'bigint';
  if (
    /\b(u?int\d*_t|uint\d*|int\d*|[ui](?:8|16|32|128)|size_t|usize|isize|long|short|number)\b/.test(
      type,
    )
  )
    return 'integer';
  if (/\b(float|double|f32|f64)\b/.test(type)) return 'float';
  if (/\b(string|std::string|str)\b/.test(type)) return 'string';
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
