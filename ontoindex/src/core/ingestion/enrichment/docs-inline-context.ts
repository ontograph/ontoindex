export type DocsInlineContextKind = 'trace' | 'drift' | 'context' | 'edit-readiness';

export interface CreateDocsInlineContextBundleInput {
  kind: DocsInlineContextKind;
  report: Record<string, unknown>;
  maxTokens?: number;
  maxEvidenceItems?: number;
}

export interface DocsInlineContextBundle {
  version: 1;
  kind: DocsInlineContextKind;
  text: string;
  metadata: {
    formatter: 'docs-inline-context';
    tokenEstimate: number;
    maxTokens: number;
    truncated: boolean;
    omittedLines: number;
  };
}

const DEFAULT_MAX_TOKENS = 900;
const MIN_MAX_TOKENS = 80;
const DEFAULT_MAX_EVIDENCE_ITEMS = 6;
const STATE_WORDS = ['stale', 'partial', 'ambiguous', 'unresolved', 'unsupported'] as const;

export function createDocsInlineContextBundle(
  input: CreateDocsInlineContextBundleInput,
): DocsInlineContextBundle {
  const maxTokens = normalizePositiveInt(input.maxTokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS);
  const maxEvidenceItems = normalizePositiveInt(
    input.maxEvidenceItems,
    DEFAULT_MAX_EVIDENCE_ITEMS,
    1,
  );
  const lines = buildLines(input.kind, input.report, maxEvidenceItems);
  const truncated = truncateLines(lines, maxTokens);
  const text = truncated.lines.join('\n');
  return {
    version: 1,
    kind: input.kind,
    text,
    metadata: {
      formatter: 'docs-inline-context',
      tokenEstimate: estimateTokenCount(text),
      maxTokens,
      truncated: truncated.omittedLines > 0,
      omittedLines: truncated.omittedLines,
    },
  };
}

function buildLines(
  kind: DocsInlineContextKind,
  report: Record<string, unknown>,
  maxEvidenceItems: number,
): string[] {
  const items = readArray(report.items);
  const docsEvidence = readArray(report.docsEvidence);
  const graphFacts = readArray(report.primaryGraphFacts);
  const warnings = readStringArray(report.warnings);
  const skipReasons = readStringArray(report.skipReasons);
  const states = collectStates(report);
  const reportName =
    readString(report.report) ?? readString(readRecord(report.summary)?.report) ?? kind;
  const sidecar = readRecord(report.sidecar);
  const sidecarStatus = readString(sidecar?.status) ?? 'unknown';
  const staleReasons = readStringArray(sidecar?.staleReasons);

  return [
    `Claim: ${claimFor(kind, reportName, items, docsEvidence, graphFacts)}`,
    'Evidence:',
    ...evidenceLines(kind, items, docsEvidence, maxEvidenceItems),
    'Graph:',
    ...graphLines(items, graphFacts, maxEvidenceItems),
    'Docs:',
    ...docsLines(items, docsEvidence, maxEvidenceItems),
    ...advisoryMemorySection(report),
    'Freshness:',
    `- sidecar=${sidecarStatus}; stale=${states.has('stale') ? 'yes' : 'no'}; partial=${states.has('partial') ? 'yes' : 'no'}`,
    staleReasons.length > 0
      ? `- stale reasons: ${staleReasons.join(', ')}`
      : '- stale reasons: none',
    'Risks:',
    ...riskLines(states, warnings, skipReasons),
    'Next checks:',
    ...nextCheckLines(kind, states, warnings, skipReasons),
  ];
}

function advisoryMemorySection(report: Record<string, unknown>): string[] {
  const advisoryMemories = readRecord(report.advisoryMemories);
  if (!advisoryMemories) return [];
  const availability = readRecord(advisoryMemories.availability);
  const validity = readRecord(advisoryMemories.validity);
  const freshness = readRecord(advisoryMemories.freshness);
  return [
    'Advisory memories:',
    `- boundary: ${readString(advisoryMemories.note) ?? 'advisory only'}`,
    `- availability: ${readString(availability?.status) ?? 'unknown'}; total=${readNumber(availability?.total) ?? 0}; dir=${readString(availability?.directory) ?? '.ontoindex/memories'}`,
    `- validity: valid=${readNumber(validity?.valid) ?? 0}; invalid=${readNumber(validity?.invalid) ?? 0}`,
    `- freshness: fresh=${readNumber(freshness?.fresh) ?? 0}; stale-index=${readNumber(freshness?.['stale-index']) ?? 0}; unknown=${readNumber(freshness?.unknown) ?? 0}; invalid=${readNumber(freshness?.invalid) ?? 0}`,
  ];
}

function claimFor(
  kind: DocsInlineContextKind,
  reportName: string,
  items: readonly unknown[],
  docsEvidence: readonly unknown[],
  graphFacts: readonly unknown[],
): string {
  if (kind === 'context' || kind === 'edit-readiness') {
    return `${reportName}; docs=${docsEvidence.length}; graph=${graphFacts.length}`;
  }
  return `${reportName}; items=${items.length}`;
}

function evidenceLines(
  kind: DocsInlineContextKind,
  items: readonly unknown[],
  docsEvidence: readonly unknown[],
  maxItems: number,
): string[] {
  const source = items.length > 0 ? items : docsEvidence;
  const lines = source.slice(0, maxItems).map((value) => {
    const item = readRecord(value);
    if (!item) return `- ${shortValue(value)}`;
    if (kind === 'trace') {
      return `- ${readString(item.requirementId) ?? 'requirement'}: ${stateOf(item)}; ${readString(item.reason) ?? 'no reason'}`;
    }
    if (kind === 'drift') {
      return `- ${readString(item.routeKey) ?? 'route'}: ${stateOf(item)}; ${readString(item.reason) ?? 'no reason'}`;
    }
    return `- ${readString(item.kind) ?? readString(item.status) ?? 'evidence'}: ${readString(item.docPath) ?? readString(item.filePath) ?? shortValue(item)}`;
  });
  return withEmpty(lines, '- none');
}

function graphLines(
  items: readonly unknown[],
  graphFacts: readonly unknown[],
  maxItems: number,
): string[] {
  const candidates = graphFacts.length > 0 ? graphFacts : items.flatMap(extractGraphEvidence);
  return withEmpty(
    candidates.slice(0, maxItems).map((value) => {
      const item = readRecord(value);
      if (!item) return `- ${shortValue(value)}`;
      const target = readRecord(item.target) ?? readRecord(item.candidate);
      return `- ${readString(item.kind) ?? 'graph'}: ${readString(item.factKey) ?? readString(item.routeKey) ?? readString(item.requirementId) ?? 'n/a'} -> ${readString(target?.id) ?? readString(target?.name) ?? readString(item.id) ?? 'unresolved'}`;
    }),
    '- none',
  );
}

function docsLines(
  items: readonly unknown[],
  docsEvidence: readonly unknown[],
  maxItems: number,
): string[] {
  const docs = docsEvidence.length > 0 ? docsEvidence : items.flatMap(extractDocsEvidence);
  return withEmpty(
    docs.slice(0, maxItems).map((value) => {
      const item = readRecord(value);
      if (!item) return `- ${shortValue(value)}`;
      return `- ${readString(item.path) ?? readString(item.docPath) ?? 'doc'}${formatLineSpan(item.lineSpan)}${formatHeading(item.headingPath)}`;
    }),
    '- none',
  );
}

function riskLines(
  states: ReadonlySet<string>,
  warnings: readonly string[],
  skipReasons: readonly string[],
): string[] {
  const explicitStates = STATE_WORDS.map((state) => `${state}=${states.has(state) ? 'yes' : 'no'}`);
  const lines = [`- states: ${explicitStates.join('; ')}`];
  if (warnings.length > 0) lines.push(`- warnings: ${warnings.join('; ')}`);
  if (skipReasons.length > 0) lines.push(`- skip reasons: ${skipReasons.join('; ')}`);
  if (lines.length === 1 && [...states].length === 0) lines.push('- none');
  return lines;
}

function nextCheckLines(
  kind: DocsInlineContextKind,
  states: ReadonlySet<string>,
  warnings: readonly string[],
  skipReasons: readonly string[],
): string[] {
  const checks = new Set<string>();
  if (states.has('stale'))
    checks.add(
      'run `ontoindex docs refresh` (or `ontoindex analyze --markdown-sidecar`) before trusting evidence',
    );
  if (states.has('partial'))
    checks.add(
      'run `ontoindex docs refresh` (or `ontoindex analyze --markdown-sidecar`) before relying on incomplete docs coverage',
    );
  if (states.has('ambiguous'))
    checks.add('add explicit docs/code anchors for ambiguous identities');
  if (states.has('unresolved')) checks.add('resolve missing graph or docs identity');
  if (states.has('unsupported')) checks.add('confirm unsupported extractor or framework gap');
  if (warnings.length > 0 || skipReasons.length > 0) checks.add('review warnings and skip reasons');
  if (kind === 'edit-readiness') checks.add('run pre-commit audit after edits');
  if (checks.size === 0) checks.add('compare derived bundle with canonical JSON before acting');
  return [...checks].sort().map((check) => `- ${check}`);
}

function truncateLines(
  lines: readonly string[],
  maxTokens: number,
): { lines: string[]; omittedLines: number } {
  if (estimateTokenCount(lines.join('\n')) <= maxTokens)
    return { lines: [...lines], omittedLines: 0 };
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const omitted = lines.length - index;
    const marker = `... [truncated: omitted ${omitted} line(s)]`;
    const candidate = [...result, marker];
    if (estimateTokenCount(candidate.join('\n')) > maxTokens) break;
    result.push(lines[index]);
  }
  const omittedLines = Math.max(1, lines.length - result.length);
  const marker = `... [truncated: omitted ${omittedLines} line(s)]`;
  while (result.length > 0 && estimateTokenCount([...result, marker].join('\n')) > maxTokens) {
    result.pop();
  }
  return { lines: [...result, marker], omittedLines };
}

function collectStates(value: unknown): Set<string> {
  const states = new Set<string>();
  visit(value, (candidate) => {
    if (typeof candidate !== 'string') return;
    const normalized = candidate.toLowerCase();
    for (const state of STATE_WORDS) {
      if (
        normalized === state ||
        normalized.includes(`${state}-`) ||
        normalized.includes(`-${state}`) ||
        normalized.includes(` ${state}`) ||
        normalized.includes(`${state} `)
      ) {
        states.add(state);
      }
    }
  });
  return states;
}

function visit(value: unknown, onValue: (value: unknown) => void): void {
  onValue(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onValue);
    return;
  }
  if (!readRecord(value)) return;
  for (const child of Object.values(value)) visit(child, onValue);
}

function extractGraphEvidence(value: unknown): unknown[] {
  const item = readRecord(value);
  if (!item) return [];
  const evidence = [
    ...readArray(item.implementationEvidence),
    ...readArray(item.tests),
    ...readArray(item.code),
  ];
  return evidence.flatMap((entry) => {
    const record = readRecord(entry);
    const candidates = readArray(record?.candidates);
    if (candidates.length === 0) return [entry];
    return candidates.map((candidate) => ({ ...record, candidate }));
  });
}

function extractDocsEvidence(value: unknown): unknown[] {
  const item = readRecord(value);
  if (!item) return [];
  return [...readArray(item.docs), ...readArray(item.doc), ...readArray(item.documentation)];
}

function stateOf(item: Record<string, unknown>): string {
  return readString(item.status) ?? readString(item.state) ?? 'unknown';
}

function withEmpty(lines: string[], fallback: string): string[] {
  return lines.length > 0 ? lines : [fallback];
}

function formatLineSpan(value: unknown): string {
  const lineSpan = readRecord(value);
  if (!lineSpan) return '';
  const start =
    readString(lineSpan.start) ??
    (typeof lineSpan.start === 'number' ? String(lineSpan.start) : undefined);
  const end =
    readString(lineSpan.end) ??
    (typeof lineSpan.end === 'number' ? String(lineSpan.end) : undefined);
  if (!start) return '';
  return end && end !== start ? `:${start}-${end}` : `:${start}`;
}

function formatHeading(value: unknown): string {
  const heading = readStringArray(value);
  return heading.length > 0 ? ` (${heading.join(' > ')})` : '';
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value: unknown): string[] {
  return readArray(value).filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(sortJson(value));
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function estimateTokenCount(value: string): number {
  return Math.ceil(value.length / 4);
}

function normalizePositiveInt(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : fallback;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = readRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJson(record[key])]),
  );
}
