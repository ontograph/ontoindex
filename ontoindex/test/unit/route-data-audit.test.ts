import { describe, expect, it } from 'vitest';

import fixtureRecords from '../fixtures/markdown-docs-code-graph/route-data-audit-records.json' with { type: 'json' };
import {
  createRouteDataAuditReport,
  type RouteDataAuditRecord,
} from '../../src/core/ingestion/enrichment/route-data-audit.js';

describe('createRouteDataAuditReport', () => {
  it('reports observed fields for supported route graph/backend records', () => {
    const report = createRouteDataAuditReport([fixtureRecords[0] as RouteDataAuditRecord]);

    expect(report.summary).toMatchObject({
      totalRecords: 1,
      supportedRecords: 1,
      partialRecords: 0,
      unsupportedRecords: 0,
    });
    expect(report.groups[0]).toMatchObject({
      framework: 'nextjs',
      source: 'nextjs-filesystem-route',
      observedFields: [
        'method',
        'path',
        'handler',
        'middleware',
        'consumers',
        'sourceFile',
        'lineSpan',
        'framework',
        'source',
      ],
      missingFields: [],
      unsupportedStates: [],
    });
    expect(report.groups[0].sampleRouteIdentities[0]).toMatchObject({
      identity: 'GET /api/users',
      state: 'supported',
      ambiguous: false,
      lineSpan: { startLine: 1, endLine: 32 },
    });
  });

  it('preserves unsupported extractor state without treating it as missing code', () => {
    const report = createRouteDataAuditReport([fixtureRecords[1] as RouteDataAuditRecord]);

    expect(report.summary).toMatchObject({
      supportedRecords: 0,
      partialRecords: 0,
      unsupportedRecords: 1,
    });
    expect(report.groups[0].unsupportedStates).toEqual([
      {
        state: 'unsupported',
        reason: 'legacy-rpc has no route extractor',
        count: 1,
        sampleRouteIdentities: ['* /rpc/users'],
      },
    ]);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({
        code: 'route-audit.unsupported-framework',
        framework: 'legacy-rpc',
      }),
    );
  });

  it('reports missing method data and unknown-method identities as partial and ambiguous', () => {
    const report = createRouteDataAuditReport([fixtureRecords[2] as RouteDataAuditRecord]);

    expect(report.summary).toMatchObject({
      partialRecords: 1,
      ambiguousRouteIdentities: 1,
    });
    expect(report.groups[0].missingFields).toContainEqual({
      field: 'method',
      count: 1,
      sampleRouteIdentities: ['* /api/orders/:id'],
    });
    expect(report.groups[0].sampleRouteIdentities[0]).toMatchObject({
      identity: '* /api/orders/:id',
      state: 'partial',
      missingFields: ['method'],
      ambiguous: true,
    });
  });

  it('reports missing line span as a partial route extraction state', () => {
    const report = createRouteDataAuditReport([fixtureRecords[3] as RouteDataAuditRecord]);

    expect(report.groups[0].missingFields).toContainEqual({
      field: 'lineSpan',
      count: 1,
      sampleRouteIdentities: ['POST /api/invoices'],
    });
    expect(report.groups[0].unsupportedStates).toContainEqual({
      state: 'partial',
      reason: 'route line span is unavailable',
      field: 'lineSpan',
      count: 1,
      sampleRouteIdentities: ['POST /api/invoices'],
    });
  });

  it('preserves duplicate route identity ambiguity with sample handlers', () => {
    const report = createRouteDataAuditReport(fixtureRecords.slice(4, 6) as RouteDataAuditRecord[]);

    expect(report.summary.ambiguousRouteIdentities).toBe(1);
    expect(report.groups[0].ambiguousRouteIdentities).toEqual([
      {
        identity: 'GET /api/ambiguous',
        count: 2,
        sampleHandlers: ['src/main/UserController.java', 'src/main/AdminController.java'],
      },
    ]);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({
        code: 'route-audit.ambiguous-identity',
        identity: 'GET /api/ambiguous',
      }),
    );
  });
});
