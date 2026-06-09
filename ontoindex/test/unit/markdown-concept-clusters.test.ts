import { describe, expect, it } from 'vitest';

import {
  deriveMarkdownConceptClusters,
  type MarkdownConceptClusterEdgeReasonKind,
} from '../../src/core/ingestion/enrichment/markdown-concept-clusters.js';
import {
  CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
  type MarkdownApiSpecFact,
  type MarkdownChunkFact,
  type MarkdownCodeMentionFact,
  type MarkdownDocOwnerFact,
  type MarkdownDocumentFact,
  type MarkdownEntityFact,
  type MarkdownLinkFact,
  type MarkdownRequirementFact,
  type MarkdownTestMentionFact,
} from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from '../../src/core/ingestion/enrichment/markdown-doc-resolver.js';
import type { GraphIdentityCandidate } from '../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js';

describe('deriveMarkdownConceptClusters', () => {
  it('derives advisory concepts from existing Markdown facts and resolution records', () => {
    const facts: MarkdownDocumentFact[] = [
      chunk('chunk-profile', 'docs/adr/0029-native-knowledge-graph-document-sidecar.md', [
        'MCP Startup Profile',
      ]),
      entity('entity-profile', 'chunk-profile', 'MCP Startup Profile'),
      requirement('req-profile', 'REQ-MCP-1', 'MCP Startup Profile'),
      acceptanceCriterion('criterion-profile', 'REQ-MCP-1'),
      apiSpec('api-profile-a', 'docs/adr/0029-native-knowledge-graph-document-sidecar.md'),
      codeMention(
        'chunk-profile',
        'startMcpServer',
        { start: 20, end: 20 },
        'Function:startMcpServer',
        'src/mcp/server.ts',
      ),
      testMention('test-profile', 'src/mcp/server.ts'),
      owner('owner-profile-a', 'docs/adr/0029-native-knowledge-graph-document-sidecar.md'),
      chunk('chunk-api', 'docs/guides/docs-knowledge.md', ['MCP Startup Profile']),
      apiSpec('api-profile-b', 'docs/guides/docs-knowledge.md'),
      codeMention(
        'chunk-api',
        'startMcpServer',
        { start: 7, end: 7 },
        'Function:startMcpServer',
        'src/mcp/server.ts',
      ),
      owner('owner-profile-b', 'docs/guides/docs-knowledge.md'),
    ];
    const resolutions: MarkdownDocResolutionRecord[] = [
      resolution({
        fact: facts[4],
        factKey: 'api-profile-a',
        resolutionKey: 'resolution:route:a',
        subjectKind: 'route',
        targetGraphIdentity: {
          type: 'route',
          id: 'GET /api/docs/knowledge',
          method: 'GET',
          routePath: '/api/docs/knowledge',
          filePath: 'src/routes/docs.ts',
          confidence: 0.93,
        },
      }),
      resolution({
        fact: facts[5],
        factKey: codeMentionFactKey(facts[5] as MarkdownCodeMentionFact),
        resolutionKey: 'resolution:symbol:a',
        subjectKind: 'code-mention',
        targetGraphIdentity: {
          type: 'symbol',
          id: 'Function:startMcpServer',
          name: 'startMcpServer',
          filePath: 'src/mcp/server.ts',
          confidence: 0.95,
        },
      }),
      resolution({
        fact: facts[9],
        factKey: 'api-profile-b',
        resolutionKey: 'resolution:route:b',
        subjectKind: 'route',
        targetGraphIdentity: {
          type: 'route',
          id: 'GET /api/docs/knowledge',
          method: 'GET',
          routePath: '/api/docs/knowledge',
          filePath: 'src/routes/docs.ts',
          confidence: 0.91,
        },
      }),
      resolution({
        fact: facts[10],
        factKey: codeMentionFactKey(facts[10] as MarkdownCodeMentionFact),
        resolutionKey: 'resolution:symbol:b',
        subjectKind: 'code-mention',
        targetGraphIdentity: {
          type: 'symbol',
          id: 'Function:startMcpServer',
          name: 'startMcpServer',
          filePath: 'src/mcp/server.ts',
          confidence: 0.94,
        },
      }),
    ];

    const result = deriveMarkdownConceptClusters({
      facts,
      resolutions,
      sidecar: { freshness: 'fresh' },
    });

    expect(result.sidecar).toEqual({ freshness: 'fresh', reasons: [] });
    expect(result.warnings).toEqual([]);
    expect(result.concepts).toHaveLength(1);

    const [concept] = result.concepts;
    expect(concept).toEqual(
      expect.objectContaining({
        label: 'MCP Startup Profile',
        evidenceClass: 'docs_evidence',
        freshness: 'fresh',
        confidence: 'high',
      }),
    );
    expect(concept.id).toMatch(/^markdown-concept:mcp-startup-profile:/);
    expect(concept.sourceDocuments).toEqual([
      'docs/adr/0029-native-knowledge-graph-document-sidecar.md',
      'docs/guides/docs-knowledge.md',
    ]);
    expect(concept.sourceFactKeys).toEqual(
      expect.arrayContaining([
        'chunk-profile',
        'entity-profile',
        'req-profile',
        'criterion-profile',
        'api-profile-a',
        'api-profile-b',
        'owner-profile-a',
        'owner-profile-b',
      ]),
    );
    expect(concept.resolutionKeys).toEqual([
      'resolution:route:a',
      'resolution:route:b',
      'resolution:symbol:a',
      'resolution:symbol:b',
    ]);
    expect(concept.linkedGraphIdentities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'route', id: 'GET /api/docs/knowledge' }),
        expect.objectContaining({ type: 'symbol', id: 'Function:startMcpServer' }),
        expect.objectContaining({ type: 'test-file', id: 'src/mcp/server.ts' }),
      ]),
    );
    expect(reasonKinds(concept.clusterEdgeReasons)).toEqual(
      expect.arrayContaining([
        'same-normalized-label',
        'same-requirement-id',
        'same-route',
        'same-file',
        'same-symbol',
        'same-owner',
        'same-heading-path',
      ]),
    );
  });

  it('marks clusters stale from stale graph resolutions without promoting docs authority', () => {
    const mention = codeMention(
      'chunk-stale',
      'staleSymbol',
      { start: 4, end: 4 },
      'Function:staleSymbol',
      'src/stale.ts',
    );
    const result = deriveMarkdownConceptClusters({
      facts: [chunk('chunk-stale', 'docs/stale.md', ['Stale Symbol']), mention],
      resolutions: [
        resolution({
          fact: mention,
          factKey: codeMentionFactKey(mention),
          resolutionKey: 'resolution:stale-symbol',
          subjectKind: 'code-mention',
          status: 'stale',
          targetGraphIdentity: {
            type: 'symbol',
            id: 'Function:staleSymbol',
            filePath: 'src/stale.ts',
            sourceIndexId: 'old-index',
            confidence: 0.8,
          },
        }),
      ],
      sidecar: { freshness: 'fresh' },
    });

    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0]).toEqual(
      expect.objectContaining({
        evidenceClass: 'docs_evidence',
        freshness: 'stale',
      }),
    );
    expect(result.concepts[0].linkedGraphIdentities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'Function:staleSymbol',
          resolutionStatus: 'stale',
          resolutionKey: 'resolution:stale-symbol',
        }),
      ]),
    );
  });

  it('represents missing sidecar input without manufacturing concepts', () => {
    const result = deriveMarkdownConceptClusters({
      facts: [],
      resolutions: [],
      sidecar: { freshness: 'missing', reasons: ['no markdown sidecar manifest'] },
    });

    expect(result).toEqual({
      sidecar: {
        freshness: 'missing',
        reasons: ['no markdown sidecar manifest'],
      },
      concepts: [],
      totalConcepts: 0,
      warnings: ['markdown-sidecar-missing'],
    });
  });

  it('ignores link facts without corrupting cluster indexes', () => {
    const facts: MarkdownDocumentFact[] = [
      link('chunk-profile'),
      chunk('chunk-profile', 'docs/adr/0029-native-knowledge-graph-document-sidecar.md', [
        'MCP Startup Profile',
      ]),
      entity('entity-profile', 'chunk-profile', 'MCP Startup Profile'),
    ];

    const result = deriveMarkdownConceptClusters({ facts, sidecar: { freshness: 'fresh' } });

    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0].sourceFactKeys).toEqual(['chunk-profile', 'entity-profile']);
    expect(reasonKinds(result.concepts[0].clusterEdgeReasons)).toEqual(
      expect.arrayContaining(['same-normalized-label', 'same-heading-path']),
    );
  });

  it('does not warn about truncation when concept count exactly matches the limit', () => {
    const result = deriveMarkdownConceptClusters({
      facts: [
        chunk('chunk-one', 'docs/one.md', ['Concept One']),
        chunk('chunk-two', 'docs/two.md', ['Concept Two']),
      ],
      maxConcepts: 2,
      sidecar: { freshness: 'fresh' },
    });

    expect(result.concepts).toHaveLength(2);
    expect(result.totalConcepts).toBe(2);
    expect(result.warnings).not.toContain('markdown-concepts-truncated');
  });
});

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

function link(fromChunkKey: string): MarkdownLinkFact {
  return {
    kind: 'markdown-link',
    fromChunkKey,
    href: '#mcp-startup-profile',
    text: 'MCP Startup Profile',
    lineSpan: { start: 1, end: 1 },
  };
}

function requirement(
  normalizedKey: string,
  requirementId: string,
  title: string,
): MarkdownRequirementFact {
  return {
    ...typedFactBase(normalizedKey),
    kind: 'markdown-requirement',
    requirementId,
    title,
    source: 'heading',
  };
}

function acceptanceCriterion(normalizedKey: string, requirementId: string): MarkdownDocumentFact {
  return {
    ...typedFactBase(normalizedKey),
    kind: 'markdown-acceptance-criterion',
    criterion: `${requirementId} has deterministic clustering.`,
    ordinal: 1,
    requirementId,
  };
}

function apiSpec(normalizedKey: string, docPath: string): MarkdownApiSpecFact {
  return {
    ...typedFactBase(normalizedKey, docPath),
    kind: 'markdown-api-spec',
    method: 'GET',
    path: '/api/docs/knowledge',
    routeKey: 'GET /api/docs/knowledge',
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

function testMention(normalizedKey: string, targetPath: string): MarkdownTestMentionFact {
  return {
    ...typedFactBase(normalizedKey),
    kind: 'markdown-test-mention',
    mention: targetPath,
    targetPath,
    resolvable: true,
  };
}

function owner(normalizedKey: string, docPath: string): MarkdownDocOwnerFact {
  return {
    ...typedFactBase(normalizedKey, docPath),
    kind: 'markdown-doc-owner',
    owner: 'platform-docs',
    service: 'docs',
    status: 'implemented',
    ontoindexKind: 'feature',
  };
}

function typedFactBase(
  normalizedKey: string,
  docPath = 'docs/adr/0029-native-knowledge-graph-document-sidecar.md',
) {
  return {
    schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
    docPath,
    headingPath: ['MCP Startup Profile'],
    lineSpan: { start: 1, end: 1 },
    sourceChunkKey: docPath.includes('guides') ? 'chunk-api' : 'chunk-profile',
    normalizedKey,
    confidence: 0.9,
    evidence: {
      text: normalizedKey,
      raw: normalizedKey,
      lineSpan: { start: 1, end: 1 },
    },
  };
}

function resolution(input: {
  fact: MarkdownDocumentFact;
  factKey: string;
  resolutionKey: string;
  subjectKind: MarkdownDocResolutionRecord['subjectKind'];
  status?: MarkdownDocResolutionRecord['status'];
  targetGraphIdentity: GraphIdentityCandidate;
}): MarkdownDocResolutionRecord {
  return {
    kind: 'markdown-doc-resolution',
    schemaVersion: 1,
    resolverId: 'ontoindex.markdown-doc-resolver',
    resolverVersion: '1.0.0',
    sourceIndexId: 'index-a',
    sourceCommitHash: 'commit-a',
    graphSchemaVersion: 7,
    docPath: 'docPath' in input.fact ? input.fact.docPath : 'docs/adr/0029.md',
    factKey: input.factKey,
    factKind: input.fact.kind,
    subjectKind: input.subjectKind,
    resolutionKey: input.resolutionKey,
    status: input.status ?? 'resolved',
    confidence: input.targetGraphIdentity.confidence,
    evidenceKind:
      input.subjectKind === 'requirement' ? 'lexical-requirement-id' : 'graph-structural',
    reasons: ['single-candidate'],
    targetGraphIdentity: input.targetGraphIdentity,
    candidates: [input.targetGraphIdentity],
    lineSpan: 'lineSpan' in input.fact ? input.fact.lineSpan : undefined,
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

function reasonKinds(
  reasons: readonly { reason: MarkdownConceptClusterEdgeReasonKind }[],
): MarkdownConceptClusterEdgeReasonKind[] {
  return reasons.map((reason) => reason.reason);
}
