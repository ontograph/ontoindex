import { describe, expect, it } from 'vitest';

import type { DocsReportEnvelope } from '../../src/core/ingestion/enrichment/docs-contracts.js';
import {
  type MarkdownChunkFact,
  type MarkdownCodeMentionFact,
  type MarkdownDocumentFact,
  type MarkdownEntityFact,
} from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from '../../src/core/ingestion/enrichment/markdown-doc-resolver.js';
import type { GraphIdentityCandidate } from '../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js';
import { createMarkdownKnowledgeReport } from '../../src/core/ingestion/enrichment/markdown-knowledge-report.js';

describe('createMarkdownKnowledgeReport', () => {
  it('wraps derived concept clusters in an advisory knowledge report', () => {
    const facts: MarkdownDocumentFact[] = [
      chunk('chunk-profile', 'docs/adr/0029-native-knowledge-graph-document-sidecar.md', [
        'MCP Startup Profile',
      ]),
      entity('entity-profile', 'chunk-profile', 'MCP Startup Profile'),
      codeMention(
        'chunk-profile',
        'startMcpServer',
        { start: 12, end: 12 },
        'Function:startMcpServer',
        'src/mcp/server.ts',
      ),
    ];
    const mention = facts[2] as MarkdownCodeMentionFact;
    const report = createMarkdownKnowledgeReport({
      baseReport: baseReport(),
      facts,
      resolutions: [
        resolution({
          fact: mention,
          factKey: codeMentionFactKey(mention),
          resolutionKey: 'resolution:symbol:start',
          targetGraphIdentity: {
            type: 'symbol',
            id: 'Function:startMcpServer',
            name: 'startMcpServer',
            filePath: 'src/mcp/server.ts',
            confidence: 0.95,
          },
        }),
      ],
    });

    expect(report.summary).toMatchObject({
      report: 'knowledge',
      knowledge: {
        totalConcepts: 1,
        emittedConcepts: 1,
        staleConcepts: 0,
        disconnectedConcepts: 0,
        authority: 'advisory',
        byEvidenceClass: { docs_evidence: 1 },
      },
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      label: 'MCP Startup Profile',
      aliases: ['startMcpServer'],
      evidenceClass: 'docs_evidence',
      authority: 'authoritative',
      freshness: 'fresh',
      confidence: 'high',
      sourceDocuments: ['docs/adr/0029-native-knowledge-graph-document-sidecar.md'],
      sourceFactKeys: expect.arrayContaining(['chunk-profile', 'entity-profile']),
      resolutionKeys: ['resolution:symbol:start'],
      linkedGraphIdentities: expect.arrayContaining([
        expect.objectContaining({
          type: 'symbol',
          id: 'Function:startMcpServer',
          resolutionKey: 'resolution:symbol:start',
        }),
      ]),
      suggestedNextChecks: ['review linked graph identities and source documents before acting'],
      flags: {
        stale: false,
        disconnected: false,
        overloaded: false,
        orphanAdrLike: false,
        hub: false,
      },
    });
    expect(report.items[0].conceptId).toMatch(/^markdown-concept:mcp-startup-profile:/);
    expect(report.items[0].clusterEdgeReasons.map((reason) => reason.reason)).toEqual(
      expect.arrayContaining(['same-heading-path', 'same-normalized-label']),
    );
  });

  it('reports stale, disconnected, overloaded, orphan ADR-like, and hub metrics', () => {
    const staleMention = codeMention(
      'chunk-stale',
      'Stale Symbol',
      { start: 5, end: 5 },
      'Function:staleSymbol',
      'src/stale.ts',
    );
    const facts: MarkdownDocumentFact[] = [
      chunk('chunk-stale', 'docs/stale.md', ['Stale Symbol']),
      staleMention,
      chunk('chunk-adr', 'docs/adr/0030-orphan-decision.md', ['ADR 0030 Orphan Decision']),
      ...['one', 'two', 'three', 'four'].flatMap((name, index) => [
        chunk(`chunk-shared-${name}`, `docs/${name}/shared.md`, ['Shared Knowledge Hub']),
        codeMention(
          `chunk-shared-${name}`,
          `sharedSymbol${index}`,
          { start: 10 + index, end: 10 + index },
          `Function:sharedSymbol${index}`,
          `src/${name}/shared.ts`,
        ),
      ]),
    ];
    const sharedMentions = facts.filter(
      (fact): fact is MarkdownCodeMentionFact =>
        fact.kind === 'markdown-code-mention' && fact.evidence.text.startsWith('sharedSymbol'),
    );
    const report = createMarkdownKnowledgeReport({
      baseReport: baseReport('stale'),
      facts,
      resolutions: [
        resolution({
          fact: staleMention,
          factKey: codeMentionFactKey(staleMention),
          resolutionKey: 'resolution:stale',
          status: 'stale',
          targetGraphIdentity: {
            type: 'symbol',
            id: 'Function:staleSymbol',
            filePath: 'src/stale.ts',
            confidence: 0.8,
          },
        }),
        ...sharedMentions.map((mention, index) =>
          resolution({
            fact: mention,
            factKey: codeMentionFactKey(mention),
            resolutionKey: `resolution:shared:${index}`,
            targetGraphIdentity: {
              type: 'symbol',
              id: `Function:sharedSymbol${index}`,
              filePath: `src/${index}/shared.ts`,
              confidence: 0.9,
            },
          }),
        ),
      ],
    });

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        'knowledge report degraded by sidecar status stale',
        'knowledge report sidecar stale: source index mismatch',
      ]),
    );
    expect(report.summary.knowledge).toMatchObject({
      totalConcepts: 3,
      staleConcepts: 3,
      disconnectedConcepts: 1,
      overloadedConcepts: 1,
      orphanAdrLikeConcepts: 1,
      hubConcepts: 1,
    });
    expect(report.items.find((item) => item.label === 'Stale Symbol')).toMatchObject({
      freshness: 'stale',
      flags: expect.objectContaining({ stale: true }),
      suggestedNextChecks: expect.arrayContaining([
        'refresh markdown sidecar and resolution records',
      ]),
    });
    expect(report.items.find((item) => item.label === 'ADR 0030 Orphan Decision')).toMatchObject({
      flags: expect.objectContaining({ disconnected: true, orphanAdrLike: true }),
      suggestedNextChecks: expect.arrayContaining([
        'link the ADR-like concept to implementation symbols, routes, tests, or requirements',
      ]),
    });
    expect(report.items.find((item) => item.label === 'Shared Knowledge Hub')).toMatchObject({
      flags: expect.objectContaining({ overloaded: true, hub: true }),
      metrics: expect.objectContaining({ documentCount: 4, degree: 12 }),
    });
  });

  it('surfaces missing and partial sidecar states as explicit checks', () => {
    const missing = createMarkdownKnowledgeReport({
      baseReport: baseReport('missing'),
      facts: [],
      resolutions: [],
    });

    expect(missing.items).toEqual([]);
    expect(missing.warnings).toEqual(
      expect.arrayContaining([
        'markdown-sidecar-missing',
        'knowledge report degraded by sidecar status missing',
      ]),
    );
    expect(missing.summary.knowledge).toMatchObject({
      totalConcepts: 0,
      suggestedNextChecks: expect.arrayContaining([
        'generate markdown sidecar facts before interpreting concept coverage',
        'generate or refresh markdown sidecar facts before interpreting this report',
      ]),
    });

    const partial = createMarkdownKnowledgeReport({
      baseReport: baseReport('partial'),
      facts: [chunk('chunk-partial', 'docs/partial.md', ['Partial Concept'])],
      resolutions: [],
    });
    expect(partial.warnings).toEqual(
      expect.arrayContaining([
        'knowledge report degraded by sidecar status partial',
        'knowledge report sidecar degraded: partial=1',
      ]),
    );
    expect(partial.items[0].suggestedNextChecks).toEqual(
      expect.arrayContaining([
        'inspect sidecar degraded reasons before acting on missing or disconnected concepts',
      ]),
    );
  });

  it('exposes Phase 4 rationale snippets schema evidence and normalized sidecar state', () => {
    const facts: MarkdownDocumentFact[] = [
      chunk('chunk-api', 'docs/api.md', ['API Contracts']),
      apiSpec('api:GET:/v1/users', 'chunk-api', 'docs/api.md', 'GET', '/v1/users'),
    ];
    const report = createMarkdownKnowledgeReport({
      baseReport: baseReport('available'),
      facts,
      resolutions: [],
    });

    expect(report.summary.knowledge).toMatchObject({
      diagnosticSidecarStatus: 'complete',
      authority: 'advisory',
      byEvidenceClass: { docs_evidence: 1 },
    });
    expect(report.items[0]).toMatchObject({
      diagnosticSidecarStatus: 'complete',
      authority: 'advisory',
      evidenceClass: 'docs_evidence',
      rationaleSnippets: expect.arrayContaining([
        expect.objectContaining({
          sourceFactKey: 'api:GET:/v1/users',
          factKind: 'markdown-api-spec',
          docPath: 'docs/api.md',
          lineSpan: { start: 12, end: 12 },
          excerpt: 'GET /v1/users',
          evidenceClass: 'docs_evidence',
          authority: 'advisory',
        }),
      ]),
      schemaEvidence: [
        expect.objectContaining({
          sourceFactKey: 'api:GET:/v1/users',
          routeKey: 'GET /v1/users',
          method: 'GET',
          path: '/v1/users',
          evidenceClass: 'docs_evidence',
          authority: 'advisory',
        }),
      ],
    });

    const partial = createMarkdownKnowledgeReport({
      baseReport: baseReport('running'),
      facts: [chunk('chunk-running', 'docs/running.md', ['Running Concept'])],
      resolutions: [],
    });
    expect(partial.summary.knowledge).toMatchObject({ diagnosticSidecarStatus: 'partial' });
    expect(partial.items[0]).toMatchObject({ diagnosticSidecarStatus: 'partial' });
  });

  it('bounds concept and graph identity output deterministically', () => {
    const ambiguousMention = codeMention(
      'chunk-ambiguous',
      'resolveThing',
      { start: 4, end: 4 },
      'Function:resolveThing',
      'src/resolve.ts',
    );
    const report = createMarkdownKnowledgeReport({
      baseReport: baseReport(),
      facts: [
        chunk('chunk-a', 'docs/a.md', ['A Concept']),
        chunk('chunk-b', 'docs/b.md', ['B Concept']),
        chunk('chunk-ambiguous', 'docs/c.md', ['C Concept']),
        ambiguousMention,
      ],
      resolutions: [
        resolution({
          fact: ambiguousMention,
          factKey: codeMentionFactKey(ambiguousMention),
          resolutionKey: 'resolution:ambiguous',
          status: 'ambiguous',
          candidates: [
            candidate('Function:resolveThingA', 'src/a.ts'),
            candidate('Function:resolveThingB', 'src/b.ts'),
            candidate('Function:resolveThingC', 'src/c.ts'),
          ],
        }),
      ],
      maxItems: 2,
      maxCandidatesPerFact: 2,
    });

    expect(report.items.map((item) => item.label)).toEqual(['A Concept', 'B Concept']);
    expect(report.limits).toMatchObject({ truncated: true, maxItems: 2, maxCandidatesPerFact: 2 });
    expect(report.warnings).toContain('knowledge report truncated to 2 concept(s)');

    const unbounded = createMarkdownKnowledgeReport({
      baseReport: baseReport(),
      facts: [chunk('chunk-ambiguous', 'docs/c.md', ['C Concept']), ambiguousMention],
      resolutions: [
        resolution({
          fact: ambiguousMention,
          factKey: codeMentionFactKey(ambiguousMention),
          resolutionKey: 'resolution:ambiguous',
          status: 'ambiguous',
          candidates: [
            candidate('Function:resolveThingA', 'src/a.ts'),
            candidate('Function:resolveThingB', 'src/b.ts'),
            candidate('Function:resolveThingC', 'src/c.ts'),
          ],
        }),
      ],
      maxCandidatesPerFact: 2,
    });

    expect(unbounded.items[0]).toMatchObject({
      linkedGraphIdentities: expect.arrayContaining([
        expect.objectContaining({ id: 'Function:resolveThing' }),
        expect.objectContaining({ id: 'Function:resolveThingA' }),
      ]),
      metrics: expect.objectContaining({
        linkedGraphIdentityCount: 4,
        emittedGraphIdentityCount: 2,
      }),
      bounds: { linkedGraphIdentitiesTruncated: true },
    });
    expect(unbounded.warnings).toContain(
      'knowledge report graph identities truncated to 2 per concept',
    );
  });
});

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
      graphSchemaVersion: 1,
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

function chunk(chunkKey: string, docPath: string, headingPath: string[]): MarkdownChunkFact {
  return {
    kind: 'markdown-chunk',
    docPath,
    fileHash: `hash:${docPath}`,
    sourceCommitHash: 'commit-a',
    headingPath,
    lineSpan: { start: 1, end: 3 },
    chunkIndex: 0,
    normalizedAnchor: headingPath.at(-1)?.toLowerCase().replace(/\s+/g, '-') ?? '',
    contentHash: `hash:${chunkKey}`,
    chunkKey,
    excerpt: headingPath.at(-1),
  };
}

function entity(entityKey: string, sourceChunkKey: string, label: string): MarkdownEntityFact {
  return {
    kind: 'markdown-entity',
    entityKey,
    label,
    normalizedLabel: label.toLowerCase().replace(/\s+/g, '-'),
    entityType: 'concept',
    sourceChunkKey,
    evidence: { text: label, lineSpan: { start: 2, end: 2 } },
  };
}

function codeMention(
  chunkKey: string,
  text: string,
  lineSpan: { start: number; end: number },
  id: string,
  filePath: string,
): MarkdownCodeMentionFact {
  return {
    kind: 'markdown-code-mention',
    chunkKey,
    target: { type: 'symbol', id, filePath },
    confidence: 0.8,
    resolutionStatus: 'resolved',
    evidence: { text, lineSpan },
  };
}

function apiSpec(
  normalizedKey: string,
  sourceChunkKey: string,
  docPath: string,
  method: 'GET',
  routePath: string,
): MarkdownDocumentFact {
  return {
    kind: 'markdown-api-spec',
    schemaVersion: 1,
    docPath,
    headingPath: ['API Contracts'],
    lineSpan: { start: 12, end: 12 },
    sourceChunkKey,
    normalizedKey,
    confidence: 0.9,
    evidence: {
      text: `${method} ${routePath}`,
      raw: `GET ${routePath}`,
      lineSpan: { start: 12, end: 12 },
    },
    method,
    path: routePath,
    routeKey: `${method} ${routePath}`,
  };
}

function resolution(input: {
  fact: MarkdownDocumentFact;
  factKey: string;
  resolutionKey: string;
  status?: MarkdownDocResolutionRecord['status'];
  targetGraphIdentity?: GraphIdentityCandidate;
  candidates?: GraphIdentityCandidate[];
}): MarkdownDocResolutionRecord {
  const candidates =
    input.candidates ?? (input.targetGraphIdentity ? [input.targetGraphIdentity] : []);
  return {
    kind: 'markdown-doc-resolution',
    schemaVersion: 1,
    resolverId: 'ontoindex.markdown-doc-resolver',
    resolverVersion: '1.0.0',
    sourceIndexId: 'index-a',
    sourceCommitHash: 'commit-a',
    graphSchemaVersion: 7,
    docPath: 'docPath' in input.fact ? input.fact.docPath : 'docs/knowledge.md',
    factKey: input.factKey,
    factKind: input.fact.kind,
    subjectKind: 'code-mention',
    resolutionKey: input.resolutionKey,
    status: input.status ?? 'resolved',
    confidence: input.targetGraphIdentity?.confidence ?? candidates[0]?.confidence ?? 0,
    evidenceKind: 'graph-structural',
    reasons: ['single-candidate'],
    targetGraphIdentity: input.targetGraphIdentity,
    candidates,
    lineSpan: 'lineSpan' in input.fact ? input.fact.lineSpan : undefined,
  };
}

function candidate(id: string, filePath: string): GraphIdentityCandidate {
  return {
    type: 'symbol',
    id,
    filePath,
    confidence: 0.8,
  };
}

function codeMentionFactKey(fact: MarkdownCodeMentionFact): string {
  return [
    'markdown-code-mention',
    fact.chunkKey,
    fact.evidence.lineSpan.start,
    fact.evidence.lineSpan.end,
    fact.evidence.text,
  ].join(':');
}
