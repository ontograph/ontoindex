/**
 * Markdown Mention Extractor
 *
 * Scans markdown text for backticked identifiers that match known code symbols.
 * Used to create MENTIONS edges between documentation and code.
 */

interface Mention {
  symbol: string;
  confidence: number;
}

/**
 * Extract symbol mentions from markdown text.
 *
 * @param mdText - The markdown content to scan
 * @param knownSymbols - Set of all known symbol names in the codebase
 * @returns Array of identified mentions with confidence scores
 */
export function extractMentions(mdText: string, knownSymbols: Set<string>): Mention[] {
  const mentions = new Map<string, number>();

  // Rule v0: Match backticked identifiers `SymbolName`
  // We avoid triple backticks (blocks) by using a lookahead/lookbehind approach
  // and ensuring the content doesn't contain newlines.
  const backtickRegex = /(?<!`)`([^`\n]+)`(?!`)/g;
  let match;

  while ((match = backtickRegex.exec(mdText)) !== null) {
    const rawCandidate = match[1].trim();
    // Strip trailing parens from `func()`
    const candidate = rawCandidate.replace(/\(\)$/, '');

    // Check if the candidate or rawCandidate is a known symbol
    if (knownSymbols.has(candidate) || knownSymbols.has(rawCandidate)) {
      const symbol = knownSymbols.has(candidate) ? candidate : rawCandidate;
      // Heuristic: Check if we are inside a code block (``` ... ```)
      const prefix = mdText.substring(0, match.index);
      const isCodeBlock = (prefix.match(/```/g) || []).length % 2 !== 0;

      const confidence = isCodeBlock ? 0.3 : 0.4;

      // Keep the highest confidence if seen multiple times
      const current = mentions.get(symbol) || 0;
      if (confidence > current) {
        mentions.set(symbol, confidence);
      }
    }
  }

  return Array.from(mentions.entries()).map(([symbol, confidence]) => ({
    symbol,
    confidence,
  }));
}
