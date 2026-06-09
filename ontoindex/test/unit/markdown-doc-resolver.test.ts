import { describe, expect, it } from 'vitest';

import type { SourceIndexIdentity } from '../../src/core/ingestion/enrichment/docs-contracts.js';
import {
  CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
  type MarkdownApiSpecFact,
  type MarkdownCodeMentionFact,
  type MarkdownRequirementFact,
  type MarkdownTestMentionFact,
} from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import { resolveMarkdownDocumentFacts } from '../../src/core/ingestion/enrichment/markdown-doc-resolver.js';
import { InMemoryGraphIdentityProvider } from '../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js';

const sourceIndex: SourceIndexIdentity = {
  repoId: 'repo-a',
  repoPath: '/repo/a',
  sourceIndexId: 'index-a',
  sourceCommitHash: 'commit-a',
  graphSchemaVersion: 7,
};

describe('resolveMarkdownDocumentFacts', () => {
  it('resolves an exact code mention to one symbol candidate', async () => {
    const provider = new InMemoryGraphIdentityProvider({
      symbols: [
        {
          type: 'symbol',
          id: 'Function:resolveMarkdownDocumentFacts',
          name: 'resolveMarkdownDocumentFacts',
          filePath: 'src/resolver.ts',
          sourceIndexId: 'index-a',
          graphSchemaVersion: 7,
          confidence: 0.96,
        },
      ],
    });

    const [record] = await resolveMarkdownDocumentFacts({
      facts: [codeMention('resolveMarkdownDocumentFacts')],
      sourceIndex,
      provider,
    });

    expect(record).toEqual(
      expect.objectContaining({
        kind: 'markdown-doc-resolution',
        factKind: 'markdown-code-mention',
        subjectKind: 'code-mention',
        status: 'resolved',
        confidence: 0.96,
        targetGraphIdentity: expect.objectContaining({
          id: 'Function:resolveMarkdownDocumentFacts',
        }),
      }),
    );
  });

  it('preserves ambiguous symbol candidates and caps them deterministically', async () => {
    const provider = new InMemoryGraphIdentityProvider({
      symbols: [
        {
          type: 'symbol',
          id: 'Function:parse:c',
          name: 'parse',
          filePath: 'src/c.ts',
          confidence: 0.6,
        },
        {
          type: 'symbol',
          id: 'Function:parse:a',
          name: 'parse',
          filePath: 'src/a.ts',
          confidence: 0.9,
        },
        {
          type: 'symbol',
          id: 'Function:parse:b',
          name: 'parse',
          filePath: 'src/b.ts',
          confidence: 0.8,
        },
      ],
    });

    const [record] = await resolveMarkdownDocumentFacts({
      facts: [codeMention('parse')],
      sourceIndex,
      provider,
      maxCandidatesPerFact: 2,
    });

    expect(record.status).toBe('ambiguous');
    expect(record.reasons).toEqual(['multiple-candidates']);
    expect(record.candidates.map((candidate) => candidate.id)).toEqual([
      'Function:parse:a',
      'Function:parse:b',
    ]);
  });

  it('stores unresolved code mentions instead of dropping them', async () => {
    const [record] = await resolveMarkdownDocumentFacts({
      facts: [codeMention('missingSymbol')],
      sourceIndex,
      provider: new InMemoryGraphIdentityProvider(),
    });

    expect(record).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        confidence: 0,
        reasons: ['symbol-not-found'],
        candidates: [],
      }),
    );
  });

  it('marks stale graph identities separately from unresolved facts', async () => {
    const provider = new InMemoryGraphIdentityProvider({
      symbols: [
        {
          type: 'symbol',
          id: 'Function:stale',
          name: 'stale',
          filePath: 'src/stale.ts',
          sourceIndexId: 'old-index',
          graphSchemaVersion: 7,
          confidence: 0.9,
        },
      ],
    });

    const [record] = await resolveMarkdownDocumentFacts({
      facts: [codeMention('stale')],
      sourceIndex,
      provider,
    });

    expect(record.status).toBe('stale');
    expect(record.reasons).toEqual(['stale-graph-identity']);
    expect(record.targetGraphIdentity).toEqual(
      expect.objectContaining({ sourceIndexId: 'old-index' }),
    );
  });

  it('resolves test mentions to test files first', async () => {
    const provider = new InMemoryGraphIdentityProvider({
      testFiles: [
        {
          type: 'test-file',
          id: 'File:test/unit/markdown-doc-resolver.test.ts',
          filePath: 'test/unit/markdown-doc-resolver.test.ts',
          confidence: 0.93,
        },
      ],
    });

    const [record] = await resolveMarkdownDocumentFacts({
      facts: [testMention('markdown-doc-resolver.test.ts')],
      sourceIndex,
      provider,
    });

    expect(record).toEqual(
      expect.objectContaining({
        subjectKind: 'test-mention',
        status: 'resolved',
        targetGraphIdentity: expect.objectContaining({ type: 'test-file' }),
      }),
    );
  });

  it('stores lexical-only requirement ID evidence separately from structural graph evidence', async () => {
    const [record] = await resolveMarkdownDocumentFacts({
      facts: [requirement('REQ-M2')],
      sourceIndex,
      provider: new InMemoryGraphIdentityProvider(),
      lexicalRequirementEvidence: [
        {
          requirementId: 'REQ-M2',
          graphIdentity: {
            type: 'file',
            id: 'File:src/resolver.ts',
            filePath: 'src/resolver.ts',
            confidence: 0.71,
          },
          lineSpan: { start: 12, end: 12 },
        },
      ],
    });

    expect(record).toEqual(
      expect.objectContaining({
        subjectKind: 'requirement',
        evidenceKind: 'lexical-requirement-id',
        status: 'resolved',
        targetGraphIdentity: expect.objectContaining({ id: 'File:src/resolver.ts' }),
      }),
    );
  });

  it('resolves API spec route facts through route candidates', async () => {
    const provider = new InMemoryGraphIdentityProvider({
      routes: [
        {
          type: 'route',
          id: 'GET /users/:id',
          name: 'GET /users/:id',
          method: 'GET',
          routePath: '/users/:id',
          filePath: 'src/routes/users.ts',
          confidence: 0.94,
        },
      ],
    });

    const [record] = await resolveMarkdownDocumentFacts({
      facts: [apiSpec('GET', '/users/:id')],
      sourceIndex,
      provider,
    });

    expect(record).toEqual(
      expect.objectContaining({
        subjectKind: 'route',
        status: 'resolved',
        targetGraphIdentity: expect.objectContaining({ type: 'route', id: 'GET /users/:id' }),
      }),
    );
  });
});

function codeMention(mention: string): MarkdownCodeMentionFact {
  return {
    kind: 'markdown-code-mention',
    chunkKey: 'chunk-a',
    target: { type: 'symbol', id: mention },
    confidence: 0.5,
    resolutionStatus: 'unresolved',
    evidence: { text: mention, lineSpan: { start: 10, end: 10 } },
  };
}

function requirement(requirementId: string): MarkdownRequirementFact {
  return {
    ...typedFactBase('markdown-requirement', `requirement:${requirementId}`),
    kind: 'markdown-requirement',
    requirementId,
    title: 'Resolver contract',
    source: 'heading',
  };
}

function testMention(mention: string): MarkdownTestMentionFact {
  return {
    ...typedFactBase('markdown-test-mention', `test:${mention}`),
    kind: 'markdown-test-mention',
    mention,
    targetPath: `test/unit/${mention}`,
    resolvable: true,
  };
}

function apiSpec(method: MarkdownApiSpecFact['method'], path: string): MarkdownApiSpecFact {
  return {
    ...typedFactBase('markdown-api-spec', `api:${method}:${path}`),
    kind: 'markdown-api-spec',
    method,
    path,
    routeKey: `${method} ${path}`,
  };
}

function typedFactBase(kind: string, normalizedKey: string) {
  return {
    kind,
    schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
    docPath: 'docs/requirements.md',
    headingPath: ['M2'],
    lineSpan: { start: 1, end: 1 },
    sourceChunkKey: 'chunk-a',
    normalizedKey,
    confidence: 0.8,
    evidence: {
      text: normalizedKey,
      raw: normalizedKey,
      lineSpan: { start: 1, end: 1 },
    },
  };
}
