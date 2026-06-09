import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createMarkdownDocsCodeEvalReport,
  type MarkdownDocsCodeEvalFixture,
  type MarkdownDocsCodeEvalMetricName,
} from '../../src/core/ingestion/enrichment/markdown-docs-code-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  __dirname,
  '../fixtures/markdown-docs-code-graph/eval-baselines.json',
);

describe('markdown docs-to-code eval baselines', () => {
  it('emits deterministic metric results with required JSON shape', () => {
    const fixtures = loadFixtures();
    const report = createMarkdownDocsCodeEvalReport({ fixtures });

    expect(report.version).toBe(1);
    expect(report.summary).toMatchObject({
      fixtureCount: 7,
      failed: 0,
    });
    expect(report.summary.resultCount).toBe(report.results.length);
    expect(report.summary.passed).toBe(report.results.length);

    for (const result of report.results) {
      expect(result).toEqual({
        metricName: expect.any(String),
        fixtureId: expect.any(String),
        expectedValue: expect.anything(),
        actualValue: expect.anything(),
        pass: true,
        tokenCounts: expect.objectContaining({
          input: expect.any(Number),
          output: expect.any(Number),
          total: expect.any(Number),
        }),
        regressionNotes: expect.any(Array),
      });
      expect(result.tokenCounts.total).toBeGreaterThan(0);
    }
  });

  it('covers trace, drift, retrieval, state, compactness, and edit-readiness metrics', () => {
    const report = createMarkdownDocsCodeEvalReport({ fixtures: loadFixtures() });
    const metricNames = new Set(report.results.map((result) => result.metricName));

    expect(metricNames).toEqual(
      new Set<MarkdownDocsCodeEvalMetricName>([
        'trace-precision',
        'trace-recall',
        'drift-precision',
        'drift-recall',
        'docs-aware-retrieval',
        'edit-readiness-docs-evidence',
        'stale-state-detection',
        'unsupported-state-detection',
        'ambiguity-detection',
        'output-size',
        'token-footprint',
        'compactness-baseline',
        'codebase-memory-comparison',
      ]),
    );
  });

  it('tracks false positives, false negatives, and compactness against baselines', () => {
    const report = createMarkdownDocsCodeEvalReport({ fixtures: loadFixtures() });
    const tracePrecision = result(report, 'trace-precision', 'trace-precision-recall');
    const traceRecall = result(report, 'trace-recall', 'trace-precision-recall');
    const compactness = result(report, 'codebase-memory-comparison', 'compactness-baseline');

    expect(tracePrecision.actualValue).toMatchObject({
      falsePositives: [],
      truePositives: ['REQ-A'],
    });
    expect(traceRecall.actualValue).toMatchObject({
      falseNegatives: [],
      truePositives: ['REQ-A'],
    });
    expect(compactness.actualValue).toMatchObject({
      ratio: expect.any(Number),
      outputTokens: expect.any(Number),
      codebaseMemoryStyleTokens: expect.any(Number),
    });
  });
});

function loadFixtures(): MarkdownDocsCodeEvalFixture[] {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixtures;
}

function result(
  report: ReturnType<typeof createMarkdownDocsCodeEvalReport>,
  metricName: MarkdownDocsCodeEvalMetricName,
  fixtureId: string,
) {
  const match = report.results.find(
    (item) => item.metricName === metricName && item.fixtureId === fixtureId,
  );
  expect(match).toBeDefined();
  return match!;
}
