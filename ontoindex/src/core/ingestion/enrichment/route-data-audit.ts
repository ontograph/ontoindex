export type RouteDataAuditField =
  | 'method'
  | 'path'
  | 'handler'
  | 'middleware'
  | 'consumers'
  | 'sourceFile'
  | 'lineSpan'
  | 'framework'
  | 'source';

export type RouteDataAuditSupportState = 'supported' | 'partial' | 'unsupported';

export interface RouteDataAuditRecord {
  readonly [key: string]: unknown;
}

export interface RouteDataAuditLineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

export interface RouteDataAuditMissingField {
  readonly field: RouteDataAuditField;
  readonly count: number;
  readonly sampleRouteIdentities: string[];
}

export interface RouteDataAuditState {
  readonly state: Exclude<RouteDataAuditSupportState, 'supported'>;
  readonly reason: string;
  readonly field?: RouteDataAuditField;
  readonly count: number;
  readonly sampleRouteIdentities: string[];
}

export interface RouteDataAuditIdentitySample {
  readonly identity: string;
  readonly method?: string;
  readonly path?: string;
  readonly handler?: string;
  readonly sourceFile?: string;
  readonly lineSpan?: RouteDataAuditLineSpan;
  readonly missingFields: RouteDataAuditField[];
  readonly state: RouteDataAuditSupportState;
  readonly ambiguous: boolean;
}

export interface RouteDataAuditAmbiguousIdentity {
  readonly identity: string;
  readonly count: number;
  readonly sampleHandlers: string[];
}

export interface RouteDataAuditWarning {
  readonly code:
    | 'route-audit.partial-field'
    | 'route-audit.unsupported-framework'
    | 'route-audit.ambiguous-identity';
  readonly message: string;
  readonly framework: string;
  readonly source: string;
  readonly field?: RouteDataAuditField;
  readonly identity?: string;
}

export interface RouteDataAuditGroup {
  readonly framework: string;
  readonly source: string;
  readonly recordCount: number;
  readonly observedFields: RouteDataAuditField[];
  readonly missingFields: RouteDataAuditMissingField[];
  readonly unsupportedStates: RouteDataAuditState[];
  readonly sampleRouteIdentities: RouteDataAuditIdentitySample[];
  readonly ambiguousRouteIdentities: RouteDataAuditAmbiguousIdentity[];
  readonly warnings: RouteDataAuditWarning[];
}

export interface RouteDataAuditReport {
  readonly version: 1;
  readonly summary: {
    readonly totalRecords: number;
    readonly supportedRecords: number;
    readonly partialRecords: number;
    readonly unsupportedRecords: number;
    readonly ambiguousRouteIdentities: number;
  };
  readonly groups: RouteDataAuditGroup[];
  readonly warnings: RouteDataAuditWarning[];
}

export interface CreateRouteDataAuditReportOptions {
  readonly framework?: string;
  readonly source?: string;
  readonly supportState?: RouteDataAuditSupportState;
  readonly unsupportedReason?: string;
  readonly sampleLimit?: number;
}

interface NormalizedRouteAuditRecord {
  readonly method?: string;
  readonly path?: string;
  readonly handler?: string;
  readonly sourceFile?: string;
  readonly lineSpan?: RouteDataAuditLineSpan;
  readonly framework: string;
  readonly source: string;
  readonly supportState: RouteDataAuditSupportState;
  readonly unsupportedReason?: string;
  readonly observedFields: Set<RouteDataAuditField>;
  readonly missingFields: RouteDataAuditField[];
  readonly identity: string;
}

const FIELD_ORDER: RouteDataAuditField[] = [
  'method',
  'path',
  'handler',
  'middleware',
  'consumers',
  'sourceFile',
  'lineSpan',
  'framework',
  'source',
];

const REQUIRED_FIELDS: RouteDataAuditField[] = [
  'method',
  'path',
  'handler',
  'sourceFile',
  'lineSpan',
  'framework',
  'source',
];

const FIELD_PARTIAL_REASONS: Partial<Record<RouteDataAuditField, string>> = {
  method: 'route method is unavailable',
  path: 'route path is unavailable',
  handler: 'route handler is unavailable',
  sourceFile: 'route source file is unavailable',
  lineSpan: 'route line span is unavailable',
  framework: 'route framework is unavailable',
  source: 'route extractor source is unavailable',
};

export function createRouteDataAuditReport(
  records: readonly RouteDataAuditRecord[],
  options: CreateRouteDataAuditReportOptions = {},
): RouteDataAuditReport {
  const sampleLimit = Math.max(1, options.sampleLimit ?? 5);
  const normalized = records.map((record) => normalizeRecord(record, options));
  const identityCounts = countBy(normalized.map((record) => record.identity));
  const groups = new Map<string, NormalizedRouteAuditRecord[]>();

  for (const record of normalized) {
    const key = `${record.framework}\0${record.source}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const auditGroups = [...groups.values()]
    .map((groupRecords) => buildGroup(groupRecords, identityCounts, sampleLimit))
    .sort((a, b) => `${a.framework}\0${a.source}`.localeCompare(`${b.framework}\0${b.source}`));
  const warnings = auditGroups.flatMap((group) => group.warnings);

  return {
    version: 1,
    summary: {
      totalRecords: normalized.length,
      supportedRecords: normalized.filter((record) => record.supportState === 'supported').length,
      partialRecords: normalized.filter((record) => record.supportState === 'partial').length,
      unsupportedRecords: normalized.filter((record) => record.supportState === 'unsupported')
        .length,
      ambiguousRouteIdentities: auditGroups.reduce(
        (sum, group) => sum + group.ambiguousRouteIdentities.length,
        0,
      ),
    },
    groups: auditGroups,
    warnings,
  };
}

function normalizeRecord(
  record: RouteDataAuditRecord,
  options: CreateRouteDataAuditReportOptions,
): NormalizedRouteAuditRecord {
  const method = stringValue(record, ['method', 'httpMethod']);
  const path = stringValue(record, ['path', 'routePath', 'route', 'name']);
  const handler = stringValue(record, ['handler', 'handlerFile', 'handlerPath', 'filePath']);
  const sourceFile = stringValue(record, ['sourceFile', 'filePath', 'handler', 'handlerFile']);
  const source =
    stringValue(record, ['source', 'sourceExtractor', 'extractor', 'routeSource']) ??
    options.source ??
    'unknown';
  const framework =
    stringValue(record, ['framework']) ?? options.framework ?? inferFrameworkFromSource(source);
  const lineSpan = lineSpanValue(record);
  const supportState = supportStateValue(record, options);
  const unsupportedReason =
    stringValue(record, ['unsupportedReason', 'reason']) ?? options.unsupportedReason;
  const observedFields = observedFieldsFor(record, {
    method,
    path,
    handler,
    sourceFile,
    lineSpan,
    framework,
    source,
  });
  const missingFields = REQUIRED_FIELDS.filter((field) => !observedFields.has(field));
  const state: RouteDataAuditSupportState =
    supportState === 'unsupported'
      ? 'unsupported'
      : missingFields.length > 0
        ? 'partial'
        : 'supported';

  return {
    method,
    path,
    handler,
    sourceFile,
    lineSpan,
    framework,
    source,
    supportState: state,
    unsupportedReason,
    observedFields,
    missingFields,
    identity: routeIdentity(method, path),
  };
}

function buildGroup(
  records: readonly NormalizedRouteAuditRecord[],
  identityCounts: ReadonlyMap<string, number>,
  sampleLimit: number,
): RouteDataAuditGroup {
  const first = records[0];
  const observedFields = sortFields(
    unique(records.flatMap((record) => [...record.observedFields])),
  );
  const missingFields = REQUIRED_FIELDS.map((field) => {
    const missingRecords = records.filter((record) => record.missingFields.includes(field));
    return {
      field,
      count: missingRecords.length,
      sampleRouteIdentities: unique(missingRecords.map((record) => record.identity)).slice(
        0,
        sampleLimit,
      ),
    };
  }).filter((field) => field.count > 0);
  const unsupportedStates = buildStates(records, sampleLimit);
  const ambiguousRouteIdentities = [...countBy(records.map((record) => record.identity))]
    .filter(([identity, count]) => count > 1 || identity.startsWith('* '))
    .map(([identity, count]) => ({
      identity,
      count,
      sampleHandlers: unique(
        records
          .filter((record) => record.identity === identity)
          .map((record) => record.handler ?? record.sourceFile ?? 'unknown'),
      ).slice(0, sampleLimit),
    }))
    .slice(0, sampleLimit);
  const sampleRouteIdentities = records.slice(0, sampleLimit).map((record) => ({
    identity: record.identity,
    ...(record.method ? { method: record.method } : {}),
    ...(record.path ? { path: record.path } : {}),
    ...(record.handler ? { handler: record.handler } : {}),
    ...(record.sourceFile ? { sourceFile: record.sourceFile } : {}),
    ...(record.lineSpan ? { lineSpan: record.lineSpan } : {}),
    missingFields: record.missingFields,
    state: record.supportState,
    ambiguous: (identityCounts.get(record.identity) ?? 0) > 1 || record.identity.startsWith('* '),
  }));
  const warnings = buildWarnings(
    first.framework,
    first.source,
    missingFields,
    unsupportedStates,
    ambiguousRouteIdentities,
  );

  return {
    framework: first.framework,
    source: first.source,
    recordCount: records.length,
    observedFields,
    missingFields,
    unsupportedStates,
    sampleRouteIdentities,
    ambiguousRouteIdentities,
    warnings,
  };
}

function buildStates(
  records: readonly NormalizedRouteAuditRecord[],
  sampleLimit: number,
): RouteDataAuditState[] {
  const states = new Map<string, RouteDataAuditState>();

  for (const record of records) {
    if (record.supportState === 'unsupported') {
      addState(states, {
        state: 'unsupported',
        reason: record.unsupportedReason ?? 'route extractor reports unsupported framework',
        count: 1,
        sampleRouteIdentities: [record.identity],
      });
      continue;
    }

    for (const field of record.missingFields) {
      addState(states, {
        state: 'partial',
        reason: FIELD_PARTIAL_REASONS[field] ?? `${field} is unavailable`,
        field,
        count: 1,
        sampleRouteIdentities: [record.identity],
      });
    }
  }

  return [...states.values()].map((state) => ({
    ...state,
    sampleRouteIdentities: state.sampleRouteIdentities.slice(0, sampleLimit),
  }));
}

function addState(states: Map<string, RouteDataAuditState>, state: RouteDataAuditState): void {
  const key = `${state.state}\0${state.field ?? ''}\0${state.reason}`;
  const existing = states.get(key);
  if (!existing) {
    states.set(key, state);
    return;
  }
  states.set(key, {
    ...existing,
    count: existing.count + state.count,
    sampleRouteIdentities: unique([
      ...existing.sampleRouteIdentities,
      ...state.sampleRouteIdentities,
    ]),
  });
}

function buildWarnings(
  framework: string,
  source: string,
  missingFields: readonly RouteDataAuditMissingField[],
  unsupportedStates: readonly RouteDataAuditState[],
  ambiguousIdentities: readonly RouteDataAuditAmbiguousIdentity[],
): RouteDataAuditWarning[] {
  return [
    ...unsupportedStates
      .filter((state) => state.state === 'unsupported')
      .map((state) => ({
        code: 'route-audit.unsupported-framework' as const,
        message: state.reason,
        framework,
        source,
      })),
    ...missingFields.map((field) => ({
      code: 'route-audit.partial-field' as const,
      message: `${field.field} missing on ${field.count} route record${field.count === 1 ? '' : 's'}`,
      framework,
      source,
      field: field.field,
    })),
    ...ambiguousIdentities.map((identity) => ({
      code: 'route-audit.ambiguous-identity' as const,
      message: `route identity ${identity.identity} is ambiguous across ${identity.count} record${identity.count === 1 ? '' : 's'}`,
      framework,
      source,
      identity: identity.identity,
    })),
  ];
}

function observedFieldsFor(
  record: RouteDataAuditRecord,
  normalized: {
    readonly method?: string;
    readonly path?: string;
    readonly handler?: string;
    readonly sourceFile?: string;
    readonly lineSpan?: RouteDataAuditLineSpan;
    readonly framework?: string;
    readonly source?: string;
  },
): Set<RouteDataAuditField> {
  const fields = new Set<RouteDataAuditField>();
  if (normalized.method) fields.add('method');
  if (normalized.path) fields.add('path');
  if (normalized.handler) fields.add('handler');
  if (hasAny(record, ['middleware'])) fields.add('middleware');
  if (hasAny(record, ['consumers'])) fields.add('consumers');
  if (normalized.sourceFile) fields.add('sourceFile');
  if (normalized.lineSpan) fields.add('lineSpan');
  if (normalized.framework && normalized.framework !== 'unknown') fields.add('framework');
  if (normalized.source && normalized.source !== 'unknown') fields.add('source');
  return fields;
}

function supportStateValue(
  record: RouteDataAuditRecord,
  options: CreateRouteDataAuditReportOptions,
): RouteDataAuditSupportState {
  const raw =
    stringValue(record, ['supportState', 'supportStatus', 'extractionState']) ??
    options.supportState;
  if (raw === 'unsupported' || raw === 'partial' || raw === 'supported') return raw;
  if (record.unsupported === true) return 'unsupported';
  return 'supported';
}

function lineSpanValue(record: RouteDataAuditRecord): RouteDataAuditLineSpan | undefined {
  const nested = record.lineSpan;
  if (nested && typeof nested === 'object') {
    const lineSpan = nested as Record<string, unknown>;
    const startLine = numberValue(lineSpan, ['startLine', 'start']);
    const endLine = numberValue(lineSpan, ['endLine', 'end']) ?? startLine;
    if (startLine !== undefined && endLine !== undefined) return { startLine, endLine };
  }

  const startLine = numberValue(record, ['startLine', 'lineStart', 'lineNumber']);
  const endLine = numberValue(record, ['endLine', 'lineEnd']) ?? startLine;
  return startLine !== undefined && endLine !== undefined ? { startLine, endLine } : undefined;
}

function stringValue(record: RouteDataAuditRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberValue(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function hasAny(record: RouteDataAuditRecord, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function inferFrameworkFromSource(source: string): string {
  const normalized = source.toLowerCase();
  if (normalized.includes('nextjs')) return 'nextjs';
  if (normalized.includes('expo')) return 'expo';
  if (normalized.includes('php')) return 'php';
  if (normalized.includes('laravel')) return 'laravel';
  if (normalized.startsWith('decorator-')) return 'decorator';
  return 'unknown';
}

function routeIdentity(method: string | undefined, path: string | undefined): string {
  const methodPart = method?.toUpperCase() ?? '*';
  return `${methodPart} ${path ?? '<missing-path>'}`;
}

function sortFields(fields: readonly RouteDataAuditField[]): RouteDataAuditField[] {
  const set = new Set(fields);
  return FIELD_ORDER.filter((field) => set.has(field));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
