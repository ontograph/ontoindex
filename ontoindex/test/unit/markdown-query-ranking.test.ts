import { describe, expect, it } from 'vitest';
import {
  applyMarkdownLinkBonus,
  isLowAuthorityMarkdownPath,
  MARKDOWN_ARCHIVE_WEIGHT,
  resolveMarkdownLinkTarget,
  scoreMarkdownChunks,
  tokenizeMarkdownQueryText,
} from '../../src/core/ingestion/enrichment/markdown-query-ranking.js';

describe('Markdown query ranking', () => {
  it('tokenizes stop words and ordinary query terms', () => {
    expect(tokenizeMarkdownQueryText('how to add a new pipeline phase')).toEqual([
      'add',
      'new',
      'pipeline',
      'phase',
    ]);
  });

  it('splits camel-case identifiers and removes stop words', () => {
    expect(tokenizeMarkdownQueryText('mergeWithRRF URLParser')).toEqual([
      'merge',
      'rrf',
      'url',
      'parser',
    ]);
  });

  it('tokenizes Unicode query text', () => {
    expect(tokenizeMarkdownQueryText('Как добавить фазу')).toEqual(['как', 'добавить', 'фазу']);
  });

  it('R1-A normalizes canonically equivalent Unicode tokens', () => {
    expect(tokenizeMarkdownQueryText('cafe\u0301')).toEqual(tokenizeMarkdownQueryText('café'));
    expect(tokenizeMarkdownQueryText('cafe\u0301')).toHaveLength(1);
  });

  it('R1-B scores canonically equivalent Unicode text', () => {
    const scores = scoreMarkdownChunks('cafe\u0301', [
      { chunkKey: 'cafe', docPath: 'docs/cafe.md', headingPath: [], excerpt: 'café menu' },
    ]);

    expect(scores.get('cafe')).toBeGreaterThan(0);
  });

  it('R2-A preserves single-character tokens except stop words', () => {
    expect(tokenizeMarkdownQueryText('C')).toEqual(['c']);
    expect(tokenizeMarkdownQueryText('中')).toEqual(['中']);
    expect(tokenizeMarkdownQueryText('a')).toEqual([]);
  });

  it('R2-B scores single-character query terms', () => {
    const scores = scoreMarkdownChunks('C', [
      { chunkKey: 'compiler', docPath: 'docs/compiler.md', headingPath: [], excerpt: 'C compiler' },
    ]);

    expect(scores.get('compiler')).toBeGreaterThan(0);
  });

  it('returns no scores for an empty or missing query', () => {
    const chunks = [
      { chunkKey: 'a', docPath: 'docs/a.md', headingPath: ['Cache'], excerpt: 'cache eviction' },
    ];

    expect(scoreMarkdownChunks('', chunks).size).toBe(0);
    expect(scoreMarkdownChunks(undefined, chunks).size).toBe(0);
  });

  it('scores matching chunks and omits non-matching chunks', () => {
    const chunks = [
      { chunkKey: 'a', docPath: 'docs/a.md', headingPath: ['Cache'], excerpt: 'cache eviction' },
      { chunkKey: 'b', docPath: 'docs/b.md', headingPath: ['Logs'], excerpt: 'log rotation' },
    ];
    const scores = scoreMarkdownChunks('cache', chunks);

    expect(scores.get('a')).toBeGreaterThan(0);
    expect(scores.has('b')).toBe(false);
  });

  it('limits scoring to the first 32 distinct query tokens', () => {
    const tokens = Array.from({ length: 100 }, (_, index) => `term${index}`);
    const chunks = [
      {
        chunkKey: 'first-32',
        docPath: 'docs/first-32.md',
        headingPath: [],
        excerpt: tokens.slice(0, 32).join(' '),
      },
      {
        chunkKey: 'last-68',
        docPath: 'docs/last-68.md',
        headingPath: [],
        excerpt: tokens.slice(32).join(' '),
      },
    ];

    expect(scoreMarkdownChunks(tokens.join(' '), chunks)).toEqual(
      scoreMarkdownChunks(tokens.slice(0, 32).join(' '), chunks),
    );
  });

  it('scores 20,000 synthetic chunks within a generous time bound', () => {
    const chunks = Array.from({ length: 20_000 }, (_, index) => ({
      chunkKey: `chunk-${index}`,
      docPath: `docs/chunk-${index}.md`,
      headingPath: ['Synthetic chunk'],
      excerpt: index % 100 === 0 ? 'needle appears here' : 'unrelated corpus content',
    }));
    const startedAt = performance.now();

    const scores = scoreMarkdownChunks('needle', chunks);

    expect(scores.size).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('downweights low-authority archive chunks', () => {
    const chunks = [
      {
        chunkKey: 'current',
        docPath: 'docs/x.md',
        headingPath: ['Cache'],
        excerpt: 'cache eviction',
      },
      {
        chunkKey: 'archive',
        docPath: '.memory-bank/archive/x.md',
        headingPath: ['Cache'],
        excerpt: 'cache eviction',
      },
    ];
    const scores = scoreMarkdownChunks('cache', chunks);

    expect(scores.get('archive')).toBe(MARKDOWN_ARCHIVE_WEIGHT * (scores.get('current') ?? 0));
  });

  it('identifies audit-session paths as low authority, but not ordinary audit documents', () => {
    expect(isLowAuthorityMarkdownPath('.memory-bank/audit_session-2026-10-12-x.md')).toBe(true);
    expect(isLowAuthorityMarkdownPath('docs/audit.md')).toBe(false);
  });

  it('R3-A identifies low-authority plans and reports only', () => {
    for (const path of [
      'REFACTORING_PLAN_X.md',
      'TEST_PLAN_GROK.md',
      'RELEASE_READINESS_V2.md',
      'IMPLEMENTATION_PLAN_Y.md',
      '.ontocode/research-reports/a/report.md',
      'release-notes-v2.md',
      '.memory-bank/Z_PROJECT_PLAN.md',
    ]) {
      expect(isLowAuthorityMarkdownPath(path), path).toBe(true);
    }

    for (const path of [
      'ARCHITECTURE.md',
      'docs/plan.md',
      'RUNBOOK.md',
      'ontoindex/skills/ontoindex-cli.md',
    ]) {
      expect(isLowAuthorityMarkdownPath(path), path).toBe(false);
    }
  });

  it('R3-B applies the archive weight to plan chunks', () => {
    const scores = scoreMarkdownChunks('cache', [
      {
        chunkKey: 'current',
        docPath: 'docs/x.md',
        headingPath: ['Cache'],
        excerpt: 'cache eviction',
      },
      {
        chunkKey: 'plan',
        docPath: 'TEST_PLAN_X.md',
        headingPath: ['Cache'],
        excerpt: 'cache eviction',
      },
    ]);

    expect(scores.get('plan')).toBe(MARKDOWN_ARCHIVE_WEIGHT * (scores.get('current') ?? 0));
  });
});

describe('Markdown link proximity', () => {
  it('resolves relative links and rejects external or escaping targets', () => {
    expect(resolveMarkdownLinkTarget('docs/a.md', '../README.md')).toBe('README.md');
    expect(resolveMarkdownLinkTarget('docs/a.md', 'b.md#x')).toBe('docs/b.md');
    expect(resolveMarkdownLinkTarget('docs/a.md', 'https://x.io')).toBeUndefined();
    expect(resolveMarkdownLinkTarget('a.md', '../x.md')).toBeUndefined();
  });

  it('boosts matching chunks in the document linked from the top chunk', () => {
    const chunks = [
      {
        chunkKey: 'A',
        docPath: 'docs/a-guide.md',
        headingPath: ['Guide', 'Cache eviction policy'],
        excerpt: 'Cache eviction policy overview. See details in other doc.',
      },
      {
        chunkKey: 'B',
        docPath: 'docs/b-details.md',
        headingPath: ['Details', 'Eviction'],
        excerpt: 'Eviction runs nightly.',
      },
      {
        chunkKey: 'C',
        docPath: 'docs/c-unlinked.md',
        headingPath: ['Other', 'Eviction'],
        excerpt: 'Eviction runs nightly.',
      },
    ];
    const scores = scoreMarkdownChunks('cache eviction policy', chunks);
    expect(scores.get('B')).toBe(scores.get('C'));

    applyMarkdownLinkBonus(scores, chunks, [
      { fromChunkKey: 'A', targetDocPath: 'docs/b-details.md' },
    ]);

    expect(scores.get('B')).toBeGreaterThan(scores.get('C') ?? 0);
  });

  it('leaves scores unchanged when there are no links', () => {
    const chunks = [
      {
        chunkKey: 'A',
        docPath: 'docs/a-guide.md',
        headingPath: ['Guide', 'Cache eviction policy'],
        excerpt: 'Cache eviction policy overview. See details in other doc.',
      },
      {
        chunkKey: 'B',
        docPath: 'docs/b-details.md',
        headingPath: ['Details', 'Eviction'],
        excerpt: 'Eviction runs nightly.',
      },
    ];
    const scores = scoreMarkdownChunks('cache eviction policy', chunks);
    const before = new Map(scores);

    applyMarkdownLinkBonus(scores, chunks, []);

    expect(scores).toEqual(before);
  });
});
