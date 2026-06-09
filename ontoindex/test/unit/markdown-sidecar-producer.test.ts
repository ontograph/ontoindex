import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
  createMarkdownChunkKey,
  isMarkdownAcceptanceCriterionFact,
  isMarkdownApiSpecFact,
  isMarkdownDocOwnerFact,
  isMarkdownRequirementFact,
  isMarkdownTestMentionFact,
  normalizeMarkdownAnchor,
  type MarkdownCodeMentionFact,
} from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import {
  capExcerpt,
  hashText,
  produceMarkdownSidecarFacts,
  type MarkdownCodeMentionResolution,
} from '../../src/core/ingestion/enrichment/markdown-sidecar-producer.js';

const fixturePath = path.join(process.cwd(), 'test/fixtures/markdown-rag/architecture-notes.md');
const fixtureSource = readFileSync(fixturePath, 'utf8');

describe('markdown sidecar producer', () => {
  it('emits deterministic chunk facts with citation spans and stable identity metadata', () => {
    const facts = produceMarkdownSidecarFacts({
      docPath: 'docs/architecture-notes.md',
      source: fixtureSource,
      sourceCommitHash: 'commit-a',
    });
    const chunks = facts.filter((fact) => fact.kind === 'markdown-chunk');

    expect(chunks).toHaveLength(4);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      [],
      ['Overview'],
      ['Overview', 'Details'],
      ['Overview', 'Details'],
    ]);
    expect(chunks.map((chunk) => chunk.lineSpan)).toEqual([
      { start: 1, end: 7 },
      { start: 8, end: 13 },
      { start: 14, end: 30 },
      { start: 31, end: 39 },
    ]);
    expect(chunks.map((chunk) => chunk.normalizedAnchor)).toEqual([
      '',
      'overview',
      'details',
      'details-1',
    ]);

    const details = chunks[2];
    expect(details.contentHash).toBe(hashText(details.excerpt ?? ''));
    expect(details.chunkKey).toBe(
      createMarkdownChunkKey({
        docPath: details.docPath,
        fileHash: details.fileHash,
        headingPath: details.headingPath,
        normalizedAnchor: details.normalizedAnchor,
        contentHash: details.contentHash,
      }),
    );
    expect(details.chunkKey).not.toContain(`:${details.chunkIndex}:`);
  });

  it('keeps chunk identity stable when nearby text changes outside the chunk', () => {
    const before = produceMarkdownSidecarFacts({
      docPath: 'docs/architecture-notes.md',
      source: fixtureSource,
      sourceCommitHash: 'commit-a',
    }).filter((fact) => fact.kind === 'markdown-chunk');
    const after = produceMarkdownSidecarFacts({
      docPath: 'docs/architecture-notes.md',
      source: fixtureSource.replace('# Overview', '# Preface\n\nNearby insertion.\n\n# Overview'),
      sourceCommitHash: 'commit-b',
    }).filter((fact) => fact.kind === 'markdown-chunk');
    const afterDetails = after.find(
      (chunk) => chunk.normalizedAnchor === 'details' && chunk.headingPath.at(-1) === 'Details',
    );

    expect(afterDetails).toBeDefined();
    expect(before[2].contentHash).toBe(afterDetails?.contentHash);
    expect(before[2].normalizedAnchor).toBe(afterDetails?.normalizedAnchor);
    expect(before[2].headingPath).toEqual(afterDetails?.headingPath);
    expect(before[2].chunkIndex).not.toBe(afterDetails?.chunkIndex);
  });

  it('extracts inline links, reference links, headings, frontmatter tags, tables, lists, and code fences', () => {
    const facts = produceMarkdownSidecarFacts({
      docPath: 'docs/architecture-notes.md',
      source: fixtureSource,
      sourceCommitHash: 'commit-a',
    });
    const links = facts.filter((fact) => fact.kind === 'markdown-link');
    const entities = facts.filter((fact) => fact.kind === 'markdown-entity');
    const details = facts.find(
      (fact) => fact.kind === 'markdown-chunk' && fact.normalizedAnchor === 'details',
    );

    expect(links.map((link) => [link.text, link.href, link.lineSpan])).toEqual([
      ['Pipeline', './pipeline.md#stages', { start: 10, end: 10 }],
      ['ADR-001', '../adr/001-markdown-rag.md', { start: 10, end: 10 }],
      ['local heading', '#overview', { start: 37, end: 37 }],
    ]);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'rag', entityType: 'tag' }),
        expect.objectContaining({ label: 'docs', entityType: 'tag' }),
        expect.objectContaining({ label: 'Overview', normalizedLabel: 'overview' }),
        expect.objectContaining({ label: 'Details', normalizedLabel: 'details' }),
      ]),
    );
    expect(details?.excerpt).toContain('| chunk  | stable document evidence |');
    expect(details?.excerpt).toContain('  - Preserve nested list spans');
    expect(details?.excerpt).toContain('```ts');
  });

  it('emits code mention facts as resolved, ambiguous, unresolved, stale, and low-confidence metadata', () => {
    const facts = produceMarkdownSidecarFacts({
      docPath: 'docs/architecture-notes.md',
      source: fixtureSource,
      sourceCommitHash: 'commit-a',
      options: {
        resolveCodeMention: (mention): MarkdownCodeMentionResolution | undefined => {
          if (mention === 'runAnalyze') {
            return {
              resolutionStatus: 'resolved',
              target: { type: 'symbol', id: 'Function:runAnalyze' },
              confidence: 0.95,
            };
          }
          if (mention === 'ambiguousSymbol') {
            return {
              resolutionStatus: 'ambiguous',
              confidence: 0.5,
              candidates: [
                { type: 'symbol', id: 'Function:ambiguousA', confidence: 0.5 },
                { type: 'symbol', id: 'Function:ambiguousB', confidence: 0.5 },
              ],
            };
          }
          if (mention === 'oldSymbol') {
            return {
              resolutionStatus: 'stale',
              target: { type: 'symbol', id: 'Function:oldSymbol' },
              confidence: 0.2,
            };
          }
          if (mention === 'lowConfidenceSymbol') {
            return {
              resolutionStatus: 'resolved',
              target: { type: 'symbol', id: 'Function:lowConfidenceSymbol' },
              confidence: 0.25,
            };
          }
          return undefined;
        },
      },
    });
    const mentions = facts.filter((fact) => fact.kind === 'markdown-code-mention');

    expect(mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: { text: 'runAnalyze', lineSpan: { start: 12, end: 12 } },
          resolutionStatus: 'resolved',
          target: { type: 'symbol', id: 'Function:runAnalyze', filePath: undefined },
        }),
        expect.objectContaining({
          evidence: { text: 'ambiguousSymbol', lineSpan: { start: 23, end: 23 } },
          resolutionStatus: 'ambiguous',
          target: { type: 'symbol', id: undefined, filePath: undefined },
          candidates: expect.arrayContaining([
            expect.objectContaining({ id: 'Function:ambiguousA' }),
          ]),
        }),
        expect.objectContaining({
          evidence: { text: 'missingSymbol', lineSpan: { start: 35, end: 35 } },
          resolutionStatus: 'unresolved',
          resolutionReason: 'resolver-returned-no-match',
          confidence: 0,
        }),
        expect.objectContaining({
          evidence: { text: 'oldSymbol', lineSpan: { start: 35, end: 35 } },
          resolutionStatus: 'stale',
        }),
        expect.objectContaining({
          evidence: { text: 'lowConfidenceSymbol', lineSpan: { start: 35, end: 35 } },
          resolutionStatus: 'resolved',
          confidence: 0.25,
        }),
      ]),
    );
  });

  it('marks code mentions unresolved with an explicit no-resolver reason', () => {
    const facts = produceMarkdownSidecarFacts({
      docPath: 'docs/no-resolver.md',
      source: 'Mention `firstSymbol` and `secondSymbol` while no resolver exists.',
      sourceCommitHash: 'commit-a',
    });
    const mentions = facts.filter((fact) => fact.kind === 'markdown-code-mention');

    expect(mentions).toHaveLength(2);
    expect(mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: { text: 'firstSymbol', lineSpan: { start: 1, end: 1 } },
          target: { type: 'symbol', id: undefined, filePath: undefined },
          resolutionStatus: 'unresolved',
          resolutionReason: 'no-resolver-configured',
          confidence: 0,
        }),
        expect.objectContaining({
          evidence: { text: 'secondSymbol', lineSpan: { start: 1, end: 1 } },
          resolutionStatus: 'unresolved',
          resolutionReason: 'no-resolver-configured',
          confidence: 0,
        }),
      ]),
    );
  });

  it('preserves resolver-provided unresolved reasons on passive code mentions', () => {
    const facts = produceMarkdownSidecarFacts({
      docPath: 'docs/resolver-miss.md',
      source: 'Mention `explicitMiss` and `implicitMiss`.',
      sourceCommitHash: 'commit-a',
      options: {
        resolveCodeMention: (mention): MarkdownCodeMentionResolution | undefined => {
          if (mention === 'explicitMiss') {
            return {
              resolutionStatus: 'unresolved',
              resolutionReason: 'resolver-returned-unresolved',
              confidence: 0,
            };
          }
          return undefined;
        },
      },
    });
    const mentions = facts.filter((fact) => fact.kind === 'markdown-code-mention');

    expect(mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: { text: 'explicitMiss', lineSpan: { start: 1, end: 1 } },
          resolutionStatus: 'unresolved',
          resolutionReason: 'resolver-returned-unresolved',
        }),
        expect.objectContaining({
          evidence: { text: 'implicitMiss', lineSpan: { start: 1, end: 1 } },
          resolutionStatus: 'unresolved',
          resolutionReason: 'resolver-returned-no-match',
        }),
      ]),
    );
  });

  it('accepts legacy passive code mention facts without resolution reasons', () => {
    const legacyFact: MarkdownCodeMentionFact = {
      kind: 'markdown-code-mention',
      chunkKey: 'legacy-chunk',
      target: { type: 'symbol' },
      confidence: 0,
      resolutionStatus: 'unresolved',
      evidence: {
        text: 'legacySymbol',
        lineSpan: { start: 1, end: 1 },
      },
    };

    expect(legacyFact.resolutionStatus).toBe('unresolved');
    expect(legacyFact.resolutionReason).toBeUndefined();
    expect(legacyFact.target.id).toBeUndefined();
  });

  it('emits typed markdown requirement, acceptance, API, test, and owner facts', () => {
    const source = [
      '---',
      'ontoindex:',
      '  kind: feature',
      '  service: docs-api',
      '  owner: platform-docs',
      '  status: implemented',
      '---',
      '# REQ-API-1 User API',
      '',
      'Body mentions REQ-BODY-2 and implementation in `src/user.ts`.',
      '',
      '## Acceptance Criteria',
      '',
      '- REQ-API-1 returns a user document.',
      '- Covers implemented tests in `test/unit/user-api.test.ts`.',
      '- Unsafe path remains `../../../outside/escape.test.ts`.',
      '',
      '## Route',
      '',
      'GET /api/users/{id}',
      '',
      '| Method | Path | Purpose |',
      '| --- | --- | --- |',
      '| POST | /api/users | create |',
    ].join('\n');

    const facts = produceMarkdownSidecarFacts({
      docPath: 'docs/api/user.md',
      source,
      sourceCommitHash: 'commit-a',
    });
    const chunks = facts.filter((fact) => fact.kind === 'markdown-chunk');
    const requirements = facts.filter(isMarkdownRequirementFact);
    const criteria = facts.filter(isMarkdownAcceptanceCriterionFact);
    const apiSpecs = facts.filter(isMarkdownApiSpecFact);
    const testMentions = facts.filter(isMarkdownTestMentionFact);
    const owners = facts.filter(isMarkdownDocOwnerFact);

    expect(chunks.length).toBeGreaterThan(0);
    expect(requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
          requirementId: 'REQ-API-1',
          title: 'REQ-API-1 User API',
          source: 'heading',
          headingPath: ['REQ-API-1 User API'],
          lineSpan: { start: 8, end: 8 },
          confidence: 0.95,
          evidence: expect.objectContaining({ raw: 'REQ-API-1 User API' }),
          metadata: {
            ontoindexKind: 'feature',
            service: 'docs-api',
            owner: 'platform-docs',
            status: 'implemented',
          },
        }),
        expect.objectContaining({
          requirementId: 'REQ-BODY-2',
          source: 'body',
          lineSpan: { start: 10, end: 10 },
        }),
      ]),
    );
    expect(criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: 'REQ-API-1 returns a user document.',
          requirementId: 'REQ-API-1',
          ordinal: 1,
          sourceChunkKey: expect.stringContaining('markdown-chunk:docs/api/user.md:'),
          normalizedKey: expect.stringContaining('markdown-acceptance-criterion:docs/api/user.md:'),
        }),
      ]),
    );
    expect(apiSpecs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'GET',
          path: '/api/users/{id}',
          routeKey: 'GET /api/users/{id}',
          lineSpan: { start: 20, end: 20 },
        }),
        expect.objectContaining({
          method: 'POST',
          path: '/api/users',
          routeKey: 'POST /api/users',
          lineSpan: { start: 24, end: 24 },
        }),
      ]),
    );
    expect(testMentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mention: 'test/unit/user-api.test.ts',
          targetPath: 'test/unit/user-api.test.ts',
          resolvable: true,
        }),
        expect.objectContaining({
          mention: '../../../outside/escape.test.ts',
          targetPath: '../outside/escape.test.ts',
          resolvable: false,
          unsafeReason: 'path-outside-repo',
        }),
      ]),
    );
    expect(owners).toEqual([
      expect.objectContaining({
        owner: 'platform-docs',
        service: 'docs-api',
        status: 'implemented',
        ontoindexKind: 'feature',
        lineSpan: { start: 5, end: 5 },
      }),
    ]);
    expect(facts.some((fact) => fact.kind === 'markdown-code-mention')).toBe(true);
  });

  it('enforces excerpt byte and line caps', () => {
    expect(capExcerpt('one\ntwo\nthree', { maxBytes: 100, maxLines: 2 })).toBe('one\ntwo');
    expect(
      Buffer.byteLength(capExcerpt('abcdef', { maxBytes: 3, maxLines: 10 })),
    ).toBeLessThanOrEqual(3);

    const chunks = produceMarkdownSidecarFacts({
      docPath: 'docs/architecture-notes.md',
      source: fixtureSource,
      sourceCommitHash: 'commit-a',
      options: { excerptMaxBytes: 24, excerptMaxLines: 2 },
    }).filter((fact) => fact.kind === 'markdown-chunk');

    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.excerpt ?? '')).toBeLessThanOrEqual(24);
      expect((chunk.excerpt ?? '').split('\n').length).toBeLessThanOrEqual(2);
    }
  });

  it('normalizes anchors without requiring chunk order', () => {
    expect(normalizeMarkdownAnchor('API `runAnalyze` &amp; Docs!')).toBe('api-runanalyze-and-docs');
  });
});
