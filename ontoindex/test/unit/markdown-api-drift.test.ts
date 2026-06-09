import { describe, expect, it } from 'vitest';

import type { DocsReportEnvelope } from '../../src/core/ingestion/enrichment/docs-contracts.js';
import {
  createMarkdownApiDriftReport,
  type ApiDriftStatus,
} from '../../src/core/ingestion/enrichment/markdown-api-drift.js';
import type { NormalizedRouteCandidate } from '../../src/core/ingestion/enrichment/markdown-route-candidates.js';

describe('markdown api drift', () => {
  it('reports matched, documented-only, code-only, and method mismatch routes', () => {
    const report = createMarkdownApiDriftReport({
      baseReport: baseReport(),
      docCandidates: [
        route('doc', 'GET', '/users'),
        route('doc', 'POST', '/orders'),
        route('doc', 'DELETE', '/legacy'),
        route('doc', 'GET', '/method'),
      ],
      codeCandidates: [
        route('code', 'GET', '/users'),
        route('code', 'GET', '/internal'),
        route('code', 'POST', '/method'),
      ],
    });

    expect(statuses(report)).toEqual([
      'mismatch',
      'documented-missing-in-code',
      'documented-missing-in-code',
      'code-missing-in-docs',
      'matched',
    ]);
    expect(report.summary).toMatchObject({
      report: 'api-drift',
      api: {
        documentedRoutes: 4,
        codeRoutes: 3,
        byStatus: {
          'code-missing-in-docs': 1,
          'documented-missing-in-code': 2,
          matched: 1,
          mismatch: 1,
        },
      },
    });
    expect(report.items.find((item) => item.status === 'mismatch')).toMatchObject({
      routeKey: 'GET /method',
      reason: 'documented GET does not match code POST for /method',
    });
  });

  it('reports ambiguous duplicate route identities without forcing a match', () => {
    const report = createMarkdownApiDriftReport({
      baseReport: baseReport(),
      docCandidates: [route('doc', 'GET', '/ambiguous')],
      codeCandidates: [
        route('code', 'GET', '/ambiguous', { id: 'one' }),
        route('code', 'GET', '/ambiguous', { id: 'two' }),
      ],
    });

    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      status: 'ambiguous',
      routeKey: 'GET /ambiguous',
      code: [{ id: 'one' }, { id: 'two' }],
    });
  });

  it('keeps unsupported route extraction out of missing-code findings', () => {
    const report = createMarkdownApiDriftReport({
      baseReport: baseReport(),
      docCandidates: [route('doc', 'GET', '/rpc/users')],
      codeCandidates: [
        route('code', '*', '/rpc/users', {
          state: 'unsupported',
          confidence: 0,
          unsupported: {
            state: 'unsupported',
            reason: 'legacy-rpc has no route extractor',
            field: 'framework',
          },
        }),
      ],
    });

    expect(statuses(report)).toEqual(['unsupported']);
    expect(report.items[0]).toMatchObject({
      status: 'unsupported',
      reason: 'legacy-rpc has no route extractor',
      code: [
        {
          state: 'unsupported',
          unsupported: {
            reason: 'legacy-rpc has no route extractor',
          },
        },
      ],
    });
  });

  it('carries stale sidecar state and applies cardinality limits', () => {
    const report = createMarkdownApiDriftReport({
      baseReport: baseReport('stale'),
      docCandidates: [
        route('doc', 'GET', '/one'),
        route('doc', 'GET', '/two'),
        route('doc', 'GET', '/three'),
      ],
      codeCandidates: [],
      maxItems: 2,
    });

    expect(report.sidecar.status).toBe('stale');
    expect(report.limits).toMatchObject({ truncated: true, maxItems: 2 });
    expect(report.items).toHaveLength(2);
    expect(report.warnings).toContain('api drift report degraded by sidecar status stale');
    expect(report.warnings).toContain('api drift report truncated to 2 item(s)');
  });
});

function statuses(report: DocsReportEnvelope<{ status: ApiDriftStatus }>): ApiDriftStatus[] {
  return report.items.map((item) => item.status);
}

function baseReport(
  status: DocsReportEnvelope['sidecar']['status'] = 'complete',
): DocsReportEnvelope {
  return {
    version: 1,
    repo: {
      id: 'repo',
      path: '/repo',
      sourceIndexId: 'index-1',
      sourceCommitHash: 'abc123',
    },
    sidecar: {
      status,
      staleReasons: status === 'stale' ? ['source index mismatch'] : [],
      degradedReasons: status === 'partial' ? { partial: 1 } : {},
    },
    summary: {},
    items: [],
    warnings: [],
    limits: {
      truncated: false,
      maxItems: 100,
      maxCandidatesPerFact: 5,
    },
  };
}

function route(
  source: 'doc' | 'code',
  method: string,
  path: string,
  overrides: Partial<NormalizedRouteCandidate> = {},
): NormalizedRouteCandidate {
  return {
    method,
    path,
    source,
    id: `${source}:${method} ${path}`,
    filePath: source === 'doc' ? 'docs/api.md' : 'src/routes.ts',
    confidence: 0.9,
    state: 'supported',
    normalizationReasons: [],
    ...overrides,
  };
}
