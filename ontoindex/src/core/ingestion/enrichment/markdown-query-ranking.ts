const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
]);
const BM25_K1 = 1.2;
const BM25_B = 0.75;
export const MARKDOWN_ARCHIVE_WEIGHT = 0.5;
export const MARKDOWN_LINK_BONUS = 0.25;

export interface MarkdownRankableChunk {
  chunkKey?: string;
  docPath: string;
  headingPath: readonly string[];
  excerpt?: string;
}

export function tokenizeMarkdownQueryText(text: string | undefined): string[] {
  if (!text) return [];
  const split = text
    .normalize('NFC')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2');
  return split
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

export function isLowAuthorityMarkdownPath(docPath: string): boolean {
  return (
    /(^|\/)\.memory-bank\/archive\//.test(docPath) ||
    /(^|\/)audit_session-[^/]*$/.test(docPath) ||
    /(^|\/)(?:[^/]*_PLAN[^/]*|TEST_PLAN[^/]*|RELEASE_READINESS[^/]*|IMPLEMENTATION_PLAN[^/]*)\.md$/i.test(
      docPath,
    ) ||
    /(^|\/)\.ontocode\/research-reports\//.test(docPath) ||
    /(^|\/)release-notes-[^/]*\.md$/i.test(docPath)
  );
}

export function scoreMarkdownChunks(
  query: string | undefined,
  chunks: readonly MarkdownRankableChunk[],
): Map<string, number> {
  const scores = new Map<string, number>();
  const queryTokens = [...new Set(tokenizeMarkdownQueryText(query))];
  if (queryTokens.length === 0 || chunks.length === 0) return scores;
  const documents = chunks.map((chunk) =>
    tokenizeMarkdownQueryText([...chunk.headingPath, chunk.excerpt ?? ''].join(' ')),
  );
  const averageLength =
    documents.reduce((sum, tokens) => sum + tokens.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  chunks.forEach((chunk, index) => {
    if (!chunk.chunkKey) return;
    const tokens = documents[index];
    const termFrequency = new Map<string, number>();
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const frequency = termFrequency.get(token) ?? 0;
      if (frequency === 0) continue;
      const containing = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (chunks.length - containing + 0.5) / (containing + 0.5));
      score +=
        (idf * frequency * (BM25_K1 + 1)) /
        (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / averageLength));
    }
    if (score <= 0) return;
    if (isLowAuthorityMarkdownPath(chunk.docPath)) score *= MARKDOWN_ARCHIVE_WEIGHT;
    scores.set(chunk.chunkKey, score);
  });
  return scores;
}

export function resolveMarkdownLinkTarget(fromDocPath: string, href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return undefined;
  const target = href.split('#')[0];
  if (!target) return undefined;
  const base = fromDocPath.includes('/') ? fromDocPath.slice(0, fromDocPath.lastIndexOf('/')) : '';
  const parts = (
    target.startsWith('/') ? target.slice(1) : base ? `${base}/${target}` : target
  ).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) return undefined;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

export function applyMarkdownLinkBonus(
  scores: Map<string, number>,
  chunks: readonly MarkdownRankableChunk[],
  links: ReadonlyArray<{ fromChunkKey: string; targetDocPath: string }>,
): void {
  let topKey: string | undefined;
  let topScore = 0;
  for (const [key, score] of scores) {
    if (score > topScore) {
      topScore = score;
      topKey = key;
    }
  }
  if (!topKey) return;
  const linkedDocs = new Set(
    links.filter((link) => link.fromChunkKey === topKey).map((link) => link.targetDocPath),
  );
  for (const chunk of chunks) {
    if (!chunk.chunkKey || chunk.chunkKey === topKey) continue;
    const score = scores.get(chunk.chunkKey);
    if (score !== undefined && linkedDocs.has(chunk.docPath)) {
      scores.set(chunk.chunkKey, score + MARKDOWN_LINK_BONUS * topScore);
    }
  }
}
