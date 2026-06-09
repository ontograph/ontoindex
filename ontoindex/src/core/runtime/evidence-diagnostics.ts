export type EvidenceDiagnosticAuthority = 'authoritative' | 'advisory';
export type EvidenceDiagnosticQualityKind =
  | 'ambiguous'
  | 'degraded'
  | 'extracted'
  | 'inferred'
  | 'stale'
  | 'truncated';

const QUALITY_KIND_CATEGORY_VALUES = new Set<string>([
  'ambiguous',
  'degraded',
  'extracted',
  'inferred',
  'stale',
  'truncated',
]);

export interface EvidenceDiagnosticRecord {
  category: string;
  kind: EvidenceDiagnosticQualityKind;
  source: string;
  authority: EvidenceDiagnosticAuthority;
  subject: string;
  reason: string;
  count?: number;
  freshness?: string;
  advisory: boolean;
  ambiguous?: boolean;
  degraded?: boolean;
  truncated?: boolean;
}

export interface EvidenceDiagnosticSummary {
  total: number;
  authoritative: number;
  advisory: number;
  ambiguous: number;
  degraded: number;
  truncated: number;
}

export interface EvidenceDiagnostics<TRecord extends EvidenceDiagnosticRecord> {
  schemaVersion: 1;
  summary: EvidenceDiagnosticSummary;
  records: TRecord[];
}

export interface SummarizeEvidenceDiagnosticsOptions<TRecord extends EvidenceDiagnosticRecord> {
  maxRecords?: number;
  createTruncationRecord?: (omitted: number) => TRecord;
}

export function isEvidenceDiagnosticQualityCategory(category: string): boolean {
  return QUALITY_KIND_CATEGORY_VALUES.has(category);
}

export function assertEvidenceDiagnosticCategory(category: string): void {
  if (isEvidenceDiagnosticQualityCategory(category)) {
    throw new Error(
      `Evidence diagnostic category "${category}" is a quality state; use kind instead.`,
    );
  }
}

export function assertEvidenceDiagnosticKind(kind: string): void {
  if (!QUALITY_KIND_CATEGORY_VALUES.has(kind)) {
    throw new Error(`Evidence diagnostic kind "${kind}" is not a supported quality state.`);
  }
}

export function evidenceDiagnosticDedupKey(record: EvidenceDiagnosticRecord): string {
  assertEvidenceDiagnosticCategory(record.category);
  assertEvidenceDiagnosticKind(record.kind);
  return [record.category, record.source, record.authority, record.subject, record.reason].join(
    '\0',
  );
}

export function normalizeEvidenceDiagnosticRecords<TRecord extends EvidenceDiagnosticRecord>(
  records: readonly TRecord[],
): TRecord[] {
  const seen = new Set<string>();
  const normalized: TRecord[] = [];

  for (const record of records) {
    const key = evidenceDiagnosticDedupKey(record);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(record);
    }
  }

  return normalized;
}

export function summarizeEvidenceDiagnostics<TRecord extends EvidenceDiagnosticRecord>(
  records: readonly TRecord[],
  options: SummarizeEvidenceDiagnosticsOptions<TRecord> = {},
): EvidenceDiagnostics<TRecord> {
  const normalizedRecords = normalizeEvidenceDiagnosticRecords(records);
  let boundedRecords = normalizedRecords;

  if (options.maxRecords !== undefined && normalizedRecords.length > options.maxRecords) {
    if (!options.createTruncationRecord) {
      throw new Error('createTruncationRecord is required when maxRecords is exceeded');
    }
    const omitted = normalizedRecords.length - options.maxRecords + 1;
    boundedRecords = [
      ...normalizedRecords.slice(0, options.maxRecords - 1),
      options.createTruncationRecord(omitted),
    ];
  }

  return {
    schemaVersion: 1,
    summary: {
      total: boundedRecords.length,
      authoritative: boundedRecords.filter((record) => record.authority === 'authoritative').length,
      advisory: boundedRecords.filter((record) => record.authority === 'advisory').length,
      ambiguous: boundedRecords.filter((record) => record.ambiguous).length,
      degraded: boundedRecords.filter((record) => record.degraded).length,
      truncated: boundedRecords.filter((record) => record.truncated).length,
    },
    records: boundedRecords,
  };
}

export function isEvidenceDiagnosticTruncationReason(reason: string): boolean {
  return /\b(capped|truncated|limit|omitted)\b/i.test(reason);
}

export function numericEvidenceDiagnosticSummaryValue(
  summary: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = summary[key];
  return typeof value === 'number' ? value : undefined;
}

export function summarizeReasonParts(reasons: readonly string[], fallback = ''): string {
  const normalized = reasons.map((reason) => reason.trim()).filter((reason) => reason.length > 0);
  return normalized.length > 0 ? normalized.join(', ') : fallback;
}

export function renderEvidenceDiagnosticSummaryLine(
  summary: EvidenceDiagnosticSummary,
  separator = ' | ',
): string {
  return [
    `Records: **${summary.total}**`,
    `authoritative: **${summary.authoritative}**`,
    `advisory: **${summary.advisory}**`,
    `ambiguous: **${summary.ambiguous}**`,
    `degraded: **${summary.degraded}**`,
    `truncated: **${summary.truncated}**`,
  ].join(separator);
}

export function renderEvidenceDiagnosticRecordLine(record: EvidenceDiagnosticRecord): string {
  const count = typeof record.count === 'number' ? ` (${record.count})` : '';
  const freshness = record.freshness ? `; freshness: ${record.freshness}` : '';
  return `- [${record.authority}/${record.source}] ${record.subject}${count}: ${record.reason}${freshness}`;
}

export function renderEvidenceDiagnosticGroup(
  title: string,
  records: readonly EvidenceDiagnosticRecord[],
): string[] {
  const lines = [`### ${title}`, ''];
  if (records.length === 0) {
    lines.push('- None recorded.', '');
    return lines;
  }

  for (const record of records) {
    lines.push(renderEvidenceDiagnosticRecordLine(record));
  }
  lines.push('');
  return lines;
}
