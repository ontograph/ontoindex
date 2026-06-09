import { describe, expect, it } from 'vitest';

import { createDocsInlineContextBundle } from '../../src/core/ingestion/enrichment/docs-inline-context.js';

describe('createDocsInlineContextBundle', () => {
  it('formats a trace bundle with required sections and explicit states', () => {
    const bundle = createDocsInlineContextBundle({
      kind: 'trace',
      report: traceReport(),
    });

    expect(bundle).toMatchInlineSnapshot(`
      {
        "kind": "trace",
        "metadata": {
          "formatter": "docs-inline-context",
          "maxTokens": 900,
          "omittedLines": 0,
          "tokenEstimate": 149,
          "truncated": false,
        },
        "text": "Claim: requirement-trace; items=2
      Evidence:
      - REQ-1: implemented; resolved by graph evidence
      - REQ-2: ambiguous; multiple graph candidates remain unresolved
      Graph:
      - graph: REQ-1 -> symbol:handler
      - graph: REQ-2 -> symbol:a
      - graph: REQ-2 -> symbol:b
      Docs:
      - docs/requirements.md:10 (REQ-1)
      - docs/requirements.md:20 (REQ-2)
      Freshness:
      - sidecar=complete; stale=no; partial=no
      - stale reasons: none
      Risks:
      - states: stale=no; partial=no; ambiguous=yes; unresolved=yes; unsupported=no
      Next checks:
      - add explicit docs/code anchors for ambiguous identities
      - resolve missing graph or docs identity",
        "version": 1,
      }
    `);
  });

  it('formats a drift bundle with unsupported and stale vocabulary', () => {
    const bundle = createDocsInlineContextBundle({
      kind: 'drift',
      report: driftReport(),
    });

    expect(bundle.text).toMatchInlineSnapshot(`
      "Claim: api-drift; items=2
      Evidence:
      - GET /users: matched; no reason
      - * /rpc: unsupported; legacy-rpc has no route extractor
      Graph:
      - code-route: GET /users -> code:GET /users
      - code-route: * /rpc -> code:* /rpc
      Docs:
      - docs/api.md:4
      - docs/api.md:8
      Freshness:
      - sidecar=stale; stale=yes; partial=no
      - stale reasons: source index mismatch
      Risks:
      - states: stale=yes; partial=no; ambiguous=no; unresolved=no; unsupported=yes
      - warnings: api drift report degraded by sidecar status stale
      Next checks:
      - confirm unsupported extractor or framework gap
      - review warnings and skip reasons
      - run \`ontoindex docs refresh\` (or \`ontoindex analyze --markdown-sidecar\`) before trusting evidence"
    `);
  });

  it('formats a context bundle from compact MCP JSON', () => {
    const bundle = createDocsInlineContextBundle({
      kind: 'context',
      report: contextReport(),
    });

    expect(bundle.text).toMatchInlineSnapshot(`
      "Claim: docs-context; docs=1; graph=1
      Evidence:
      - markdown-requirement: docs/requirements.md
      Graph:
      - graph-target: REQ-1 -> Function:handler
      Docs:
      - docs/requirements.md:12 (REQ-1)
      Freshness:
      - sidecar=partial; stale=no; partial=yes
      - stale reasons: none
      Risks:
      - states: stale=no; partial=yes; ambiguous=no; unresolved=no; unsupported=no
      - skip reasons: sidecar-partial
      Next checks:
      - review warnings and skip reasons
      - run \`ontoindex docs refresh\` (or \`ontoindex analyze --markdown-sidecar\`) before relying on incomplete docs coverage"
    `);
  });

  it('formats an edit readiness bundle and keeps JSON-derived readiness states explicit', () => {
    const bundle = createDocsInlineContextBundle({
      kind: 'edit-readiness',
      report: {
        ...contextReport(),
        report: 'docs-readiness',
        action: 'readiness',
        skipReasons: ['sidecar-stale', 'identity-unresolved'],
        docsEvidence: [
          {
            kind: 'markdown-requirement',
            docPath: 'docs/requirements.md',
            status: 'stale',
            lineSpan: { start: 12, end: 12 },
          },
        ],
      },
    });

    expect(bundle.text).toContain('Claim: docs-readiness; docs=1; graph=1');
    expect(bundle.text).toContain('stale=yes; partial=yes');
    expect(bundle.text).toContain('- run pre-commit audit after edits');
    expect(bundle.text).toContain('- resolve missing graph or docs identity');
  });

  it('truncates over-budget bundles deterministically with metadata', () => {
    const bundle = createDocsInlineContextBundle({
      kind: 'trace',
      report: {
        ...traceReport(),
        items: Array.from({ length: 20 }, (_, index) => ({
          requirementId: `REQ-${index}`,
          status: index % 2 === 0 ? 'implemented' : 'unresolved',
          reason: `reason-${index}`,
          docs: [{ path: `docs/${index}.md`, lineSpan: { start: index + 1 } }],
        })),
      },
      maxTokens: 80,
    });

    expect(bundle.metadata).toMatchObject({
      formatter: 'docs-inline-context',
      maxTokens: 80,
      truncated: true,
    });
    expect(bundle.metadata.tokenEstimate).toBeLessThanOrEqual(80);
    expect(bundle.text).toMatchInlineSnapshot(`
      "Claim: requirement-trace; items=20
      Evidence:
      - REQ-0: implemented; reason-0
      - REQ-1: unresolved; reason-1
      - REQ-2: implemented; reason-2
      - REQ-3: unresolved; reason-3
      - REQ-4: implemented; reason-4
      - REQ-5: unresolved; reason-5
      Graph:
      - none
      Docs:
      - docs/0.md:1
      - docs/1.md:2
      ... [truncated: omitted 10 line(s)]"
    `);
  });
});

function traceReport(): Record<string, unknown> {
  return {
    summary: { report: 'requirement-trace' },
    sidecar: { status: 'complete', staleReasons: [], degradedReasons: {} },
    warnings: [],
    items: [
      {
        requirementId: 'REQ-1',
        status: 'implemented',
        reason: 'resolved by graph evidence',
        docs: [{ path: 'docs/requirements.md', lineSpan: { start: 10 }, headingPath: ['REQ-1'] }],
        implementationEvidence: [
          { kind: 'graph', factKey: 'REQ-1', target: { id: 'symbol:handler' } },
        ],
      },
      {
        requirementId: 'REQ-2',
        status: 'ambiguous',
        reason: 'multiple graph candidates remain unresolved',
        docs: [{ path: 'docs/requirements.md', lineSpan: { start: 20 }, headingPath: ['REQ-2'] }],
        implementationEvidence: [
          {
            kind: 'graph',
            factKey: 'REQ-2',
            candidates: [{ id: 'symbol:a' }, { id: 'symbol:b' }],
          },
        ],
      },
    ],
  };
}

function driftReport(): Record<string, unknown> {
  return {
    summary: { report: 'api-drift' },
    sidecar: {
      status: 'stale',
      staleReasons: ['source index mismatch'],
      degradedReasons: { stale: 1 },
    },
    warnings: ['api drift report degraded by sidecar status stale'],
    items: [
      {
        routeKey: 'GET /users',
        status: 'matched',
        docs: [{ docPath: 'docs/api.md', lineSpan: { start: 4 } }],
        code: [{ kind: 'code-route', routeKey: 'GET /users', id: 'code:GET /users' }],
      },
      {
        routeKey: '* /rpc',
        status: 'unsupported',
        reason: 'legacy-rpc has no route extractor',
        docs: [{ docPath: 'docs/api.md', lineSpan: { start: 8 } }],
        code: [{ kind: 'code-route', routeKey: '* /rpc', id: 'code:* /rpc', state: 'unsupported' }],
      },
    ],
  };
}

function contextReport(): Record<string, unknown> {
  return {
    report: 'docs-context',
    sidecar: { status: 'partial', staleReasons: [], degradedReasons: { partial: 1 } },
    warnings: [],
    skipReasons: ['sidecar-partial'],
    docsEvidence: [
      {
        kind: 'markdown-requirement',
        docPath: 'docs/requirements.md',
        status: 'partial',
        lineSpan: { start: 12 },
        headingPath: ['REQ-1'],
      },
    ],
    primaryGraphFacts: [
      {
        kind: 'graph-target',
        factKey: 'REQ-1',
        target: { id: 'Function:handler' },
      },
    ],
  };
}
