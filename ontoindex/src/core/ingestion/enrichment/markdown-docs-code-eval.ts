import type { DocsReportEnvelope } from './docs-contracts.js';

export const MARKDOWN_DOCS_CODE_EVAL_VERSION = 1 as const;

export type MarkdownDocsCodeEvalMetricName =
  | 'trace-precision'
  | 'trace-recall'
  | 'drift-precision'
  | 'drift-recall'
  | 'docs-aware-retrieval'
  | 'edit-readiness-docs-evidence'
  | 'stale-state-detection'
  | 'unsupported-state-detection'
  | 'ambiguity-detection'
  | 'output-size'
  | 'token-footprint'
  | 'compactness-baseline'
  | 'codebase-memory-comparison';

export interface MarkdownDocsCodeEvalTokenCounts {
  input: number;
  output: number;
  baseline?: number;
  total: number;
}

export interface MarkdownDocsCodeEvalResult {
  metricName: MarkdownDocsCodeEvalMetricName;
  fixtureId: string;
  expectedValue: unknown;
  actualValue: unknown;
  pass: boolean;
  tokenCounts: MarkdownDocsCodeEvalTokenCounts;
  regressionNotes: string[];
}

export interface MarkdownDocsCodeEvalReport {
  version: typeof MARKDOWN_DOCS_CODE_EVAL_VERSION;
  summary: {
    fixtureCount: number;
    resultCount: number;
    passed: number;
    failed: number;
  };
  results: MarkdownDocsCodeEvalResult[];
}

export interface MarkdownDocsCodeEvalSetExpectation {
  positiveIds: string[];
  positiveStatuses?: string[];
  minimumPrecision?: number;
  minimumRecall?: number;
}

export interface MarkdownDocsCodeRetrievalExpectation {
  chunkKeys: string[];
  minimumPrecision?: number;
  minimumRecall?: number;
}

export interface MarkdownDocsCodeStateExpectation {
  staleDetected?: boolean;
  unsupportedDetected?: boolean;
  ambiguousDetected?: boolean;
}

export interface MarkdownDocsCodeCompactnessBaseline {
  output: unknown;
  maxOutputBytes?: number;
  maxOutputTokens?: number;
  codebaseMemoryStyleOutput?: unknown;
  maxTokenRatioToCodebaseMemory?: number;
}

export interface MarkdownDocsCodeEvalFixture {
  fixtureId: string;
  input?: unknown;
  traceReport?: DocsReportEnvelope<Record<string, unknown>>;
  traceExpected?: MarkdownDocsCodeEvalSetExpectation;
  driftReport?: DocsReportEnvelope<Record<string, unknown>>;
  driftExpected?: MarkdownDocsCodeEvalSetExpectation;
  retrievalOutput?: {
    relatedChunks?: Array<{ chunkKey?: string }>;
    relatedDocs?: Array<{ docPath?: string }>;
    summary?: Record<string, unknown>;
    skipped?: Array<{ reason?: string; detail?: string }>;
  };
  retrievalExpected?: MarkdownDocsCodeRetrievalExpectation;
  editReadinessOutput?: Record<string, unknown>;
  editReadinessExpected?: {
    minimumDocsEvidenceCount: number;
  };
  stateExpected?: MarkdownDocsCodeStateExpectation;
  compactnessBaseline?: MarkdownDocsCodeCompactnessBaseline;
  regressionNotes?: string[];
}

export interface CreateMarkdownDocsCodeEvalReportInput {
  fixtures: readonly MarkdownDocsCodeEvalFixture[];
}

interface SetMetricActual {
  score: number;
  actualIds: string[];
  expectedIds: string[];
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
}

export function createMarkdownDocsCodeEvalReport(
  input: CreateMarkdownDocsCodeEvalReportInput,
): MarkdownDocsCodeEvalReport {
  const results = input.fixtures.flatMap(evaluateMarkdownDocsCodeFixture);
  const passed = results.filter((result) => result.pass).length;
  return {
    version: MARKDOWN_DOCS_CODE_EVAL_VERSION,
    summary: {
      fixtureCount: input.fixtures.length,
      resultCount: results.length,
      passed,
      failed: results.length - passed,
    },
    results,
  };
}

export function evaluateMarkdownDocsCodeFixture(
  fixture: MarkdownDocsCodeEvalFixture,
): MarkdownDocsCodeEvalResult[] {
  const results: MarkdownDocsCodeEvalResult[] = [];

  if (fixture.traceReport && fixture.traceExpected) {
    results.push(
      ...evaluateReportSetMetrics({
        fixture,
        metricPrefix: 'trace',
        report: fixture.traceReport,
        expectation: fixture.traceExpected,
        idField: 'requirementId',
        defaultPositiveStatuses: ['implemented'],
      }),
    );
  }

  if (fixture.driftReport && fixture.driftExpected) {
    results.push(
      ...evaluateReportSetMetrics({
        fixture,
        metricPrefix: 'drift',
        report: fixture.driftReport,
        expectation: fixture.driftExpected,
        idField: 'routeKey',
        defaultPositiveStatuses: ['documented-missing-in-code', 'code-missing-in-docs', 'mismatch'],
      }),
    );
  }

  if (fixture.retrievalOutput && fixture.retrievalExpected) {
    results.push(evaluateRetrievalMetric(fixture));
  }

  if (fixture.editReadinessOutput && fixture.editReadinessExpected) {
    results.push(evaluateEditReadinessMetric(fixture));
  }

  if (fixture.stateExpected) {
    results.push(...evaluateStateMetrics(fixture));
  }

  if (fixture.compactnessBaseline) {
    results.push(...evaluateCompactnessMetrics(fixture));
  }

  return results;
}

function evaluateReportSetMetrics(input: {
  fixture: MarkdownDocsCodeEvalFixture;
  metricPrefix: 'trace' | 'drift';
  report: DocsReportEnvelope<Record<string, unknown>>;
  expectation: MarkdownDocsCodeEvalSetExpectation;
  idField: string;
  defaultPositiveStatuses: string[];
}): MarkdownDocsCodeEvalResult[] {
  const actualIds = extractReportIds(
    input.report,
    input.idField,
    input.expectation.positiveStatuses ?? input.defaultPositiveStatuses,
  );
  const expectedIds = uniqueSorted(input.expectation.positiveIds);
  const precisionActual = createSetMetricActual(actualIds, expectedIds, 'precision');
  const recallActual = createSetMetricActual(actualIds, expectedIds, 'recall');
  const minimumPrecision = input.expectation.minimumPrecision ?? 1;
  const minimumRecall = input.expectation.minimumRecall ?? 1;

  return [
    createResult({
      metricName: `${input.metricPrefix}-precision` as MarkdownDocsCodeEvalMetricName,
      fixture: input.fixture,
      expectedValue: { minimum: minimumPrecision, positiveIds: expectedIds },
      actualValue: precisionActual,
      pass: precisionActual.score >= minimumPrecision,
      outputValue: input.report,
    }),
    createResult({
      metricName: `${input.metricPrefix}-recall` as MarkdownDocsCodeEvalMetricName,
      fixture: input.fixture,
      expectedValue: { minimum: minimumRecall, positiveIds: expectedIds },
      actualValue: recallActual,
      pass: recallActual.score >= minimumRecall,
      outputValue: input.report,
    }),
  ];
}

function evaluateRetrievalMetric(fixture: MarkdownDocsCodeEvalFixture): MarkdownDocsCodeEvalResult {
  const actualIds = uniqueSorted(
    (fixture.retrievalOutput?.relatedChunks ?? [])
      .map((chunk) => chunk.chunkKey)
      .filter(isNonEmptyString),
  );
  const expectedIds = uniqueSorted(fixture.retrievalExpected?.chunkKeys ?? []);
  const precisionActual = createSetMetricActual(actualIds, expectedIds, 'precision');
  const recallActual = createSetMetricActual(actualIds, expectedIds, 'recall');
  const minimumPrecision = fixture.retrievalExpected?.minimumPrecision ?? 1;
  const minimumRecall = fixture.retrievalExpected?.minimumRecall ?? 1;
  const actualValue = {
    precision: precisionActual.score,
    recall: recallActual.score,
    actualIds,
    expectedIds,
    falsePositives: precisionActual.falsePositives,
    falseNegatives: recallActual.falseNegatives,
  };

  return createResult({
    metricName: 'docs-aware-retrieval',
    fixture,
    expectedValue: { minimumPrecision, minimumRecall, chunkKeys: expectedIds },
    actualValue,
    pass: actualValue.precision >= minimumPrecision && actualValue.recall >= minimumRecall,
    outputValue: fixture.retrievalOutput,
  });
}

function evaluateEditReadinessMetric(
  fixture: MarkdownDocsCodeEvalFixture,
): MarkdownDocsCodeEvalResult {
  const actualCount = countDocsEvidence(fixture.editReadinessOutput);
  const minimum = fixture.editReadinessExpected?.minimumDocsEvidenceCount ?? 1;
  return createResult({
    metricName: 'edit-readiness-docs-evidence',
    fixture,
    expectedValue: { minimumDocsEvidenceCount: minimum },
    actualValue: { docsEvidenceCount: actualCount },
    pass: actualCount >= minimum,
    outputValue: fixture.editReadinessOutput,
  });
}

function evaluateStateMetrics(fixture: MarkdownDocsCodeEvalFixture): MarkdownDocsCodeEvalResult[] {
  const expected = fixture.stateExpected;
  const results: MarkdownDocsCodeEvalResult[] = [];
  const detectionOutput = {
    trace: fixture.traceReport,
    drift: fixture.driftReport,
    retrieval: fixture.retrievalOutput,
  };

  if (expected?.staleDetected !== undefined) {
    const actual = detectStaleState(fixture);
    results.push(
      createResult({
        metricName: 'stale-state-detection',
        fixture,
        expectedValue: expected.staleDetected,
        actualValue: actual,
        pass: actual === expected.staleDetected,
        outputValue: detectionOutput,
      }),
    );
  }

  if (expected?.unsupportedDetected !== undefined) {
    const actual = detectReportStatus(fixture.driftReport, 'unsupported');
    results.push(
      createResult({
        metricName: 'unsupported-state-detection',
        fixture,
        expectedValue: expected.unsupportedDetected,
        actualValue: actual,
        pass: actual === expected.unsupportedDetected,
        outputValue: detectionOutput,
      }),
    );
  }

  if (expected?.ambiguousDetected !== undefined) {
    const actual =
      detectReportStatus(fixture.traceReport, 'ambiguous') ||
      detectReportStatus(fixture.driftReport, 'ambiguous');
    results.push(
      createResult({
        metricName: 'ambiguity-detection',
        fixture,
        expectedValue: expected.ambiguousDetected,
        actualValue: actual,
        pass: actual === expected.ambiguousDetected,
        outputValue: detectionOutput,
      }),
    );
  }

  return results;
}

function evaluateCompactnessMetrics(
  fixture: MarkdownDocsCodeEvalFixture,
): MarkdownDocsCodeEvalResult[] {
  const baseline = fixture.compactnessBaseline;
  if (!baseline) return [];

  const outputBytes = byteLength(baseline.output);
  const outputTokens = estimateTokenCount(baseline.output);
  const results: MarkdownDocsCodeEvalResult[] = [];

  if (baseline.maxOutputBytes !== undefined) {
    results.push(
      createResult({
        metricName: 'output-size',
        fixture,
        expectedValue: { maxOutputBytes: baseline.maxOutputBytes },
        actualValue: { outputBytes },
        pass: outputBytes <= baseline.maxOutputBytes,
        outputValue: baseline.output,
      }),
    );
  }

  if (baseline.maxOutputTokens !== undefined) {
    results.push(
      createResult({
        metricName: 'token-footprint',
        fixture,
        expectedValue: { maxOutputTokens: baseline.maxOutputTokens },
        actualValue: { outputTokens },
        pass: outputTokens <= baseline.maxOutputTokens,
        outputValue: baseline.output,
      }),
    );
    results.push(
      createResult({
        metricName: 'compactness-baseline',
        fixture,
        expectedValue: { maxOutputTokens: baseline.maxOutputTokens },
        actualValue: { outputTokens },
        pass: outputTokens <= baseline.maxOutputTokens,
        outputValue: baseline.output,
      }),
    );
  }

  if (
    baseline.codebaseMemoryStyleOutput !== undefined &&
    baseline.maxTokenRatioToCodebaseMemory !== undefined
  ) {
    const codebaseMemoryTokens = estimateTokenCount(baseline.codebaseMemoryStyleOutput);
    const ratio = codebaseMemoryTokens === 0 ? 0 : round(outputTokens / codebaseMemoryTokens);
    results.push(
      createResult({
        metricName: 'codebase-memory-comparison',
        fixture,
        expectedValue: { maxTokenRatioToCodebaseMemory: baseline.maxTokenRatioToCodebaseMemory },
        actualValue: {
          outputTokens,
          codebaseMemoryStyleTokens: codebaseMemoryTokens,
          ratio,
        },
        pass: ratio <= baseline.maxTokenRatioToCodebaseMemory,
        outputValue: baseline.output,
        baselineValue: baseline.codebaseMemoryStyleOutput,
      }),
    );
  }

  return results;
}

function createResult(input: {
  metricName: MarkdownDocsCodeEvalMetricName;
  fixture: MarkdownDocsCodeEvalFixture;
  expectedValue: unknown;
  actualValue: unknown;
  pass: boolean;
  outputValue: unknown;
  baselineValue?: unknown;
}): MarkdownDocsCodeEvalResult {
  return {
    metricName: input.metricName,
    fixtureId: input.fixture.fixtureId,
    expectedValue: input.expectedValue,
    actualValue: input.actualValue,
    pass: input.pass,
    tokenCounts: createTokenCounts(input.fixture.input, input.outputValue, input.baselineValue),
    regressionNotes: input.fixture.regressionNotes ?? [],
  };
}

function createSetMetricActual(
  actualIds: readonly string[],
  expectedIds: readonly string[],
  metric: 'precision' | 'recall',
): SetMetricActual {
  const actual = uniqueSorted(actualIds);
  const expected = uniqueSorted(expectedIds);
  const truePositives = actual.filter((id) => expected.includes(id));
  const falsePositives = actual.filter((id) => !expected.includes(id));
  const falseNegatives = expected.filter((id) => !actual.includes(id));
  const denominator = metric === 'precision' ? actual.length : expected.length;
  const score = denominator === 0 ? 1 : round(truePositives.length / denominator);
  return {
    score,
    actualIds: actual,
    expectedIds: expected,
    truePositives,
    falsePositives,
    falseNegatives,
  };
}

function extractReportIds(
  report: DocsReportEnvelope<Record<string, unknown>>,
  idField: string,
  positiveStatuses: readonly string[],
): string[] {
  return report.items
    .filter((item) => positiveStatuses.includes(String(item.status)))
    .map((item) => {
      const direct = item[idField];
      if (isNonEmptyString(direct)) return direct;
      if (idField === 'routeKey') return routeKeyFromItem(item);
      return undefined;
    })
    .filter(isNonEmptyString);
}

function routeKeyFromItem(item: Record<string, unknown>): string | undefined {
  const method = item.method;
  const path = item.path;
  if (!isNonEmptyString(method) || !isNonEmptyString(path)) return undefined;
  return `${method} ${path}`;
}

function detectStaleState(fixture: MarkdownDocsCodeEvalFixture): boolean {
  return (
    fixture.traceReport?.sidecar.status === 'stale' ||
    fixture.driftReport?.sidecar.status === 'stale' ||
    (fixture.retrievalOutput?.skipped ?? []).some((skip) => skip.reason === 'stale-enrichment')
  );
}

function detectReportStatus(
  report: DocsReportEnvelope<Record<string, unknown>> | undefined,
  status: string,
): boolean {
  return (report?.items ?? []).some((item) => item.status === status);
}

function countDocsEvidence(output: Record<string, unknown> | undefined): number {
  if (!output) return 0;
  let count = 0;
  if (Array.isArray(output.docsEvidence)) count += output.docsEvidence.length;
  if (Array.isArray(output.markdownContext)) count += output.markdownContext.length;
  if (Array.isArray(output.evidence)) {
    count += output.evidence.filter((item) => isDocsEvidenceItem(item)).length;
  }
  return count;
}

function isDocsEvidenceItem(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const record = item as Record<string, unknown>;
  return [record.source, record.kind, record.type].some(
    (value) => isNonEmptyString(value) && /markdown|docs?/.test(value),
  );
}

function createTokenCounts(
  inputValue: unknown,
  outputValue: unknown,
  baselineValue?: unknown,
): MarkdownDocsCodeEvalTokenCounts {
  const input = estimateTokenCount(inputValue);
  const output = estimateTokenCount(outputValue);
  const baseline = baselineValue === undefined ? undefined : estimateTokenCount(baselineValue);
  return {
    input,
    output,
    baseline,
    total: input + output + (baseline ?? 0),
  };
}

function estimateTokenCount(value: unknown): number {
  return Math.ceil(byteLength(value) / 4);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
