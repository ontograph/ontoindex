import { describe, expect, it } from 'vitest';

import fixtureRecords from '../fixtures/markdown-docs-code-graph/route-data-audit-records.json' with { type: 'json' };
import type { MarkdownApiSpecFact } from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import {
  createCodeRouteCandidatesFromAuditRecords,
  createDocRouteCandidates,
  normalizeRouteTemplate,
} from '../../src/core/ingestion/enrichment/markdown-route-candidates.js';
import type { RouteDataAuditRecord } from '../../src/core/ingestion/enrichment/route-data-audit.js';

describe('markdown route candidates', () => {
  it('creates normalized doc candidates from markdown api spec facts', () => {
    const candidates = createDocRouteCandidates([
      apiSpec('GET', '/Users//{id}/', { routeKey: 'GET /Users//{id}/' }),
      apiSpec('post', 'orders/<orderId>', { routeKey: 'post orders/<orderId>' }),
    ] as MarkdownApiSpecFact[]);

    expect(candidates).toMatchObject([
      {
        method: 'GET',
        path: '/users/:param',
        source: 'doc',
        filePath: 'docs/api.md',
        lineSpan: { start: 10, end: 10 },
        confidence: 0.8,
        state: 'supported',
        normalizationReasons: [
          'path.duplicate-slashes-collapsed',
          'path.trailing-slash-removed',
          'path.parameter-normalized',
          'path.lowercase',
        ],
        metadata: {
          docPath: 'docs/api.md',
          routeKey: 'GET /Users//{id}/',
        },
      },
      {
        method: 'POST',
        path: '/orders/:param',
        source: 'doc',
        state: 'supported',
        normalizationReasons: [
          'method.uppercase',
          'path.leading-slash-added',
          'path.parameter-normalized',
        ],
      },
    ]);
  });

  it('normalizes supported code route candidates from audited route records', () => {
    const candidates = createCodeRouteCandidatesFromAuditRecords([
      fixtureRecords[0] as RouteDataAuditRecord,
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      method: 'GET',
      path: '/api/users',
      source: 'code',
      filePath: 'app/api/users/route.ts',
      lineSpan: { start: 1, end: 32 },
      framework: 'nextjs',
      confidence: 0.9,
      state: 'supported',
      metadata: {
        extractor: 'nextjs-filesystem-route',
      },
    });
  });

  it('preserves unsupported framework and unavailable extraction metadata', () => {
    const candidates = createCodeRouteCandidatesFromAuditRecords([
      fixtureRecords[1] as RouteDataAuditRecord,
    ]);

    expect(candidates[0]).toMatchObject({
      method: '*',
      path: '/rpc/users',
      source: 'code',
      framework: 'legacy-rpc',
      state: 'unsupported',
      confidence: 0,
      unsupported: {
        state: 'unsupported',
        reason: 'legacy-rpc has no route extractor',
      },
      ambiguous: {
        reason: 'unknown-method-or-path',
        identity: '* /rpc/users',
      },
      metadata: {
        missingFields: ['method', 'lineSpan'],
      },
    });
  });

  it('keeps partial missing method candidates explicit and ambiguous', () => {
    const candidates = createCodeRouteCandidatesFromAuditRecords([
      fixtureRecords[2] as RouteDataAuditRecord,
    ]);

    expect(candidates[0]).toMatchObject({
      method: '*',
      path: '/api/orders/:param',
      state: 'partial',
      unsupported: {
        state: 'partial',
        reason: 'route method is unavailable',
        field: 'method',
      },
      ambiguous: {
        reason: 'unknown-method-or-path',
        identity: '* /api/orders/:id',
      },
      normalizationReasons: ['method.missing', 'path.parameter-normalized'],
      metadata: {
        missingFields: ['method'],
      },
    });
  });

  it('preserves duplicate route ambiguity from audit reports', () => {
    const candidates = createCodeRouteCandidatesFromAuditRecords(
      fixtureRecords.slice(4, 6) as RouteDataAuditRecord[],
    );

    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({
        method: 'GET',
        path: '/api/ambiguous',
        state: 'supported',
        ambiguous: {
          reason: 'duplicate-route-identity',
          identity: 'GET /api/ambiguous',
          count: 2,
          sampleHandlers: ['src/main/UserController.java', 'src/main/AdminController.java'],
        },
      });
    }
  });

  it('keeps wildcard and catch-all route forms explicit', () => {
    expect(normalizeRouteTemplate('/files/*')).toEqual({
      path: '/files/*',
      reasons: ['path.wildcard-preserved'],
    });
    expect(normalizeRouteTemplate('/blog/[...slug]/')).toEqual({
      path: '/blog/[...slug]',
      reasons: ['path.trailing-slash-removed', 'path.wildcard-preserved'],
    });
  });

  it('marks malformed doc facts with missing method or path as partial', () => {
    const [candidate] = createDocRouteCandidates([
      apiSpec(undefined, undefined, { routeKey: 'missing route' }),
    ] as unknown as MarkdownApiSpecFact[]);

    expect(candidate).toMatchObject({
      method: '*',
      path: '<missing-path>',
      source: 'doc',
      state: 'partial',
      unsupported: {
        state: 'partial',
        reason: 'method, path unavailable in markdown api spec',
        field: 'method',
      },
      ambiguous: {
        reason: 'unknown-method-or-path',
        identity: '* <missing-path>',
      },
      normalizationReasons: ['method.missing', 'path.missing'],
    });
  });
});

function apiSpec(
  method: string | undefined,
  path: string | undefined,
  overrides: Partial<MarkdownApiSpecFact> = {},
): Partial<MarkdownApiSpecFact> {
  return {
    kind: 'markdown-api-spec',
    schemaVersion: 1,
    docPath: 'docs/api.md',
    headingPath: ['API'],
    lineSpan: { start: 10, end: 10 },
    sourceChunkKey: 'docs/api.md#api',
    normalizedKey: `${method ?? '*'} ${path ?? '<missing-path>'}`,
    confidence: 0.8,
    evidence: {
      text: `${method ?? '*'} ${path ?? '<missing-path>'}`,
      raw: `${method ?? '*'} ${path ?? '<missing-path>'}`,
      lineSpan: { start: 10, end: 10 },
    },
    ...(method ? { method } : {}),
    ...(path ? { path } : {}),
    routeKey: `${method ?? '*'} ${path ?? '<missing-path>'}`,
    ...overrides,
  };
}
