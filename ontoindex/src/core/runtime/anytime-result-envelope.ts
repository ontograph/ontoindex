import type { QueryBudgetSnapshot } from './query-budget.js';

export type AnytimeResultLane =
  | 'graph'
  | 'lexical'
  | 'vector'
  | 'semantic-frontier'
  | 'docs'
  | 'virtual-source'
  | 'unknown';

export type AnytimeCompleteness = 'complete' | 'partial' | 'skipped' | 'failed';

export type AnytimeExhaustedResource =
  | 'time'
  | 'nodes'
  | 'edges'
  | 'candidates'
  | 'bytes'
  | 'external-source'
  | 'unknown';

export type AnytimeResultDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface AnytimeResultDiagnostic {
  lane?: AnytimeResultLane;
  sliceId?: string;
  code: string;
  message: string;
  severity: AnytimeResultDiagnosticSeverity;
}

export interface AnytimeResultSlice {
  id?: string;
  lane: AnytimeResultLane;
  completeness: AnytimeCompleteness;
  exhaustedResources: readonly AnytimeExhaustedResource[];
  emittedCount: number;
  payload: unknown;
  diagnostics: readonly AnytimeResultDiagnostic[];
}

export interface AnytimeResultSummaryByLane {
  lane: AnytimeResultLane;
  count: number;
}

export interface AnytimeResultSummaryByCompleteness {
  completeness: AnytimeCompleteness;
  count: number;
}

export interface AnytimeResultSummaryByResource {
  resource: AnytimeExhaustedResource;
  count: number;
}

export interface AnytimeResultSummaryBySeverity {
  severity: AnytimeResultDiagnosticSeverity;
  count: number;
}

export interface AnytimeResultEnvelopeSummary {
  totalSlices: number;
  totalDiagnostics: number;
  byLane: readonly AnytimeResultSummaryByLane[];
  byCompleteness: readonly AnytimeResultSummaryByCompleteness[];
  byExhaustedResource: readonly AnytimeResultSummaryByResource[];
  bySeverity: readonly AnytimeResultSummaryBySeverity[];
}

export interface AnytimeResultEnvelopeTruncation {
  omittedSlices: number;
  omittedDiagnostics: number;
}

export interface AnytimeResultEnvelope {
  budgetSnapshot?: QueryBudgetSnapshot;
  isPartial: boolean;
  slices: readonly AnytimeResultSlice[];
  diagnostics: readonly AnytimeResultDiagnostic[];
  summary: AnytimeResultEnvelopeSummary;
  truncation: AnytimeResultEnvelopeTruncation;
}

export interface AnytimeResultSliceInput {
  id?: unknown;
  lane?: unknown;
  completeness?: unknown;
  exhaustedResources?: unknown;
  emittedCount?: unknown;
  payload?: unknown;
  diagnostics?: unknown;
}

export interface AnytimeResultEnvelopeInput {
  slices?: readonly unknown[];
  budgetSnapshot?: QueryBudgetSnapshot;
  maxSlices?: unknown;
  maxDiagnostics?: unknown;
}

const VALID_LANES = new Set<AnytimeResultLane>([
  'graph',
  'lexical',
  'vector',
  'semantic-frontier',
  'docs',
  'virtual-source',
]);

const VALID_COMPLETENESS = new Set<AnytimeCompleteness>([
  'complete',
  'partial',
  'skipped',
  'failed',
]);

const VALID_RESOURCES = new Set<AnytimeExhaustedResource>([
  'time',
  'nodes',
  'edges',
  'candidates',
  'bytes',
  'external-source',
  'unknown',
]);

const SEVERITY_ORDER: Record<AnytimeResultDiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const KNOWN_SEVERITIES: Record<AnytimeResultDiagnosticSeverity, true> = {
  error: true,
  warning: true,
  info: true,
};

export function createAnytimeResultEnvelope(
  input: AnytimeResultEnvelopeInput = {},
): AnytimeResultEnvelope {
  const sourceSlices = Array.isArray(input.slices) ? input.slices : [];
  const seenSliceIds = new Set<string>();
  const allSlices: AnytimeResultSlice[] = [];
  const envelopeDiagnostics: AnytimeResultDiagnostic[] = [];

  for (let index = 0; index < sourceSlices.length; index += 1) {
    const normalized = normalizeSlice(sourceSlices[index], index, seenSliceIds, envelopeDiagnostics);
    allSlices.push(normalized);
  }

  const maxSlices = asNonNegativeInteger(input.maxSlices);
  const maxDiagnostics = asNonNegativeInteger(input.maxDiagnostics);

  const { slices, omittedSlices } = applySliceLimit(
    allSlices,
    maxSlices,
  );
  const maxedSliceDiagnostics = omittedSlices > 0 ? createSliceLimitDiagnostic(maxSlices!, allSlices.length) : [];
  const diagnosticsFromSlices = slices.flatMap((slice) => slice.diagnostics);
  const diagnosticsFromAll = [
    ...envelopeDiagnostics,
    ...diagnosticsFromSlices,
    ...maxedSliceDiagnostics,
  ];

  const mergedDiagnostics = [...diagnosticsFromAll];
  const { diagnostics: boundedDiagnostics, omittedDiagnostics } = applyDiagnosticLimit(
    mergedDiagnostics,
    maxDiagnostics,
  );

  const isPartial =
    (input.budgetSnapshot?.truncated === true) ||
    slices.some((slice) => slice.completeness !== 'complete') ||
    slices.some((slice) => slice.exhaustedResources.length > 0);

  const summary = buildSummary(slices, boundedDiagnostics);

  return {
    budgetSnapshot: input.budgetSnapshot,
    isPartial,
    slices,
    diagnostics: boundedDiagnostics,
    summary,
    truncation: {
      omittedSlices,
      omittedDiagnostics,
    },
  };
}

function normalizeSlice(
  sliceInput: unknown,
  index: number,
  seenSliceIds: Set<string>,
  envelopeDiagnostics: AnytimeResultDiagnostic[],
): AnytimeResultSlice {
  const record = isRecord(sliceInput) ? (sliceInput as Record<string, unknown>) : {};

  const id = asTrimmedString(record.id);
  const lane = normalizeLane(record.lane, envelopeDiagnostics, id, index);
  const completeness = normalizeCompleteness(record.completeness, envelopeDiagnostics, lane, id, index);
  const normalizedResources = normalizeExhaustedResources(
    record.exhaustedResources,
    envelopeDiagnostics,
    lane,
    id,
  );
  const emittedCount = asNonNegativeInteger(record.emittedCount) ?? 0;
  const payload = record.payload;

  if (id.length > 0) {
    if (seenSliceIds.has(id)) {
      envelopeDiagnostics.push({
        lane,
        sliceId: id,
        code: 'duplicate-slice-id',
        message: `slice with id ${id} is duplicated`,
        severity: 'warning',
      });
    } else {
      seenSliceIds.add(id);
    }
  }

  const sliceDiagnostics = normalizeSliceDiagnostics(
    record.diagnostics,
    lane,
    id,
  );

  return {
    id: id.length > 0 ? id : undefined,
    lane,
    completeness,
    exhaustedResources: normalizedResources,
    emittedCount,
    payload,
    diagnostics: sliceDiagnostics,
  };
}

function normalizeLane(
  raw: unknown,
  envelopeDiagnostics: AnytimeResultDiagnostic[],
  sliceId: string,
  index: number,
): AnytimeResultLane {
  const normalized = asTrimmedString(raw);
  if (normalized.length === 0) {
    envelopeDiagnostics.push({
      sliceId,
      code: 'invalid-lane',
      message: `slice[${index}] lane is missing`,
      severity: 'error',
    });
    return 'unknown';
  }
  if (!VALID_LANES.has(normalized as AnytimeResultLane)) {
    envelopeDiagnostics.push({
      sliceId,
      code: 'invalid-lane',
      message: `slice[${index}] lane ${normalized} is unsupported`,
      severity: 'error',
      lane: 'unknown',
    });
    return 'unknown';
  }
  return normalized as AnytimeResultLane;
}

function normalizeCompleteness(
  raw: unknown,
  envelopeDiagnostics: AnytimeResultDiagnostic[],
  lane: AnytimeResultLane,
  sliceId: string,
  index: number,
): AnytimeCompleteness {
  const normalized = asTrimmedString(raw);
  if (VALID_COMPLETENESS.has(normalized as AnytimeCompleteness)) {
    return normalized as AnytimeCompleteness;
  }
  envelopeDiagnostics.push({
    lane,
    sliceId,
    code: 'invalid-completeness',
    message: `slice[${index}] completeness ${normalized || '<missing>'} is unsupported`,
    severity: 'error',
  });
  return 'partial';
}

function normalizeExhaustedResources(
  raw: unknown,
  envelopeDiagnostics: AnytimeResultDiagnostic[],
  lane: AnytimeResultLane,
  sliceId: string,
): readonly AnytimeExhaustedResource[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalizedResources: AnytimeExhaustedResource[] = [];
  const seen = new Set<AnytimeExhaustedResource>();
  for (const rawResource of raw) {
    const value = asTrimmedString(rawResource);
    if (value.length === 0) {
      continue;
    }
    if (VALID_RESOURCES.has(value as AnytimeExhaustedResource)) {
      const resource = value as AnytimeExhaustedResource;
      if (!seen.has(resource)) {
        normalizedResources.push(resource);
        seen.add(resource);
      }
      continue;
    }

    envelopeDiagnostics.push({
      lane,
      sliceId,
      code: 'invalid-exhausted-resource',
      message: `slice ${sliceId || '<unknown>'} uses unsupported exhausted resource ${value}`,
      severity: 'error',
      // keep unsupported values as unknown for deterministic counting
      ...(lane === 'unknown' ? {} : { lane }),
    });
    if (!seen.has('unknown')) {
      normalizedResources.push('unknown');
      seen.add('unknown');
    }
  }
  return normalizedResources.sort((left, right) => left.localeCompare(right));
}

function normalizeSliceDiagnostics(
  rawDiagnostics: unknown,
  lane: AnytimeResultLane,
  sliceId: string,
): readonly AnytimeResultDiagnostic[] {
  if (!Array.isArray(rawDiagnostics)) {
    return [];
  }

  const diagnostics: AnytimeResultDiagnostic[] = [];
  for (const entry of rawDiagnostics) {
    const record = isRecord(entry) ? (entry as Record<string, unknown>) : {};
    const severity = asDiagnosticSeverity(record.severity);
    const message = asTrimmedString(record.message) || asTrimmedString(record.msg);
    const code = asTrimmedString(record.code);
    diagnostics.push({
      lane,
      sliceId,
      code: code.length > 0 ? code : 'slice-diagnostic',
      message: message.length > 0 ? message : 'slice diagnostic provided without message',
      severity,
    });
  }
  return diagnostics.sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const byCode = left.code.localeCompare(right.code);
    if (byCode !== 0) {
      return byCode;
    }
    return left.message.localeCompare(right.message);
  });
}

function applySliceLimit(
  slices: readonly AnytimeResultSlice[],
  maxSlices: number | undefined,
): {
  slices: readonly AnytimeResultSlice[];
  omittedSlices: number;
} {
  if (maxSlices === undefined || maxSlices >= slices.length) {
    return {
      slices,
      omittedSlices: 0,
    };
  }
  const omittedSlices = slices.length - maxSlices;
  return {
    slices: maxSlices === 0 ? [] : slices.slice(0, maxSlices),
    omittedSlices,
  };
}

function createSliceLimitDiagnostic(maxSlices: number, totalSlices: number): AnytimeResultDiagnostic[] {
  if (maxSlices <= 0) {
    return [
      {
        code: 'max-slices-truncated',
        message: `slices capped at 0; ${totalSlices} omitted`,
        severity: 'warning',
      },
    ];
  }
  return [
    {
      code: 'max-slices-truncated',
      message: `slices capped at ${maxSlices}; ${totalSlices - maxSlices} omitted`,
      severity: 'warning',
    },
  ];
}

function applyDiagnosticLimit(
  diagnostics: readonly AnytimeResultDiagnostic[],
  maxDiagnostics: number | undefined,
): {
  diagnostics: readonly AnytimeResultDiagnostic[];
  omittedDiagnostics: number;
} {
  if (maxDiagnostics === undefined || diagnostics.length <= maxDiagnostics) {
    return {
      diagnostics,
      omittedDiagnostics: 0,
    };
  }

  if (maxDiagnostics === 0) {
    return {
      diagnostics: [
        {
          code: 'max-diagnostics-truncated',
          message: `diagnostics capped at 0; ${diagnostics.length} omitted`,
          severity: 'warning',
        },
      ],
      omittedDiagnostics: diagnostics.length,
    };
  }

  const emitBudget = maxDiagnostics - 1;
  const omittedDiagnostics = diagnostics.length - emitBudget;
  return {
    diagnostics: [...diagnostics.slice(0, emitBudget), {
      code: 'max-diagnostics-truncated',
      message: `diagnostics capped at ${maxDiagnostics}; ${omittedDiagnostics} omitted`,
      severity: 'warning',
    }],
    omittedDiagnostics,
  };
}

function buildSummary(
  slices: readonly AnytimeResultSlice[],
  diagnostics: readonly AnytimeResultDiagnostic[],
): AnytimeResultEnvelopeSummary {
  const laneCounts = new Map<AnytimeResultLane, number>();
  const completenessCounts = new Map<AnytimeCompleteness, number>();
  const resourceCounts = new Map<AnytimeExhaustedResource, number>();
  const severityCounts = new Map<AnytimeResultDiagnosticSeverity, number>();

  for (const slice of slices) {
    laneCounts.set(slice.lane, (laneCounts.get(slice.lane) ?? 0) + 1);
    completenessCounts.set(slice.completeness, (completenessCounts.get(slice.completeness) ?? 0) + 1);
    for (const resource of slice.exhaustedResources) {
      resourceCounts.set(resource, (resourceCounts.get(resource) ?? 0) + 1);
    }
  }

  for (const diagnostic of diagnostics) {
    severityCounts.set(diagnostic.severity, (severityCounts.get(diagnostic.severity) ?? 0) + 1);
  }

  return {
    totalSlices: slices.length,
    totalDiagnostics: diagnostics.length,
    byLane: sortAndMapCounts(laneCounts, (lane, count) => ({ lane, count })),
    byCompleteness: sortAndMapCounts(completenessCounts, (completeness, count) => ({
      completeness,
      count,
    })),
    byExhaustedResource: sortAndMapCounts(resourceCounts, (resource, count) => ({
      resource,
      count,
    })),
    bySeverity: sortAndMapCounts(severityCounts, (severity, count) => ({
      severity,
      count,
    })),
  };
}

function sortAndMapCounts<T, TKey extends string>(
  counts: Map<TKey, number>,
  map: (key: TKey, count: number) => T,
): readonly T[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => map(key, count));
}

function asTrimmedString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function asNonNegativeInteger(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && Number.isFinite(raw)
    ? raw
    : undefined;
}

function asDiagnosticSeverity(raw: unknown): AnytimeResultDiagnosticSeverity {
  if (typeof raw === 'string' && KNOWN_SEVERITIES[raw as AnytimeResultDiagnosticSeverity]) {
    return raw as AnytimeResultDiagnosticSeverity;
  }
  return 'info';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
