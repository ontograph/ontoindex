export type TopLevelCypherLimit =
  | { kind: 'found'; limit: number }
  | { kind: 'invalid' }
  | { kind: 'missing' };

const isIdentifierChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9_]/.test(ch);

const skipQuoted = (input: string, start: number, quote: '"' | "'"): number => {
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (input[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
};

const skipBacktickIdentifier = (input: string, start: number): number => {
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === '`') {
      if (input[i + 1] === '`') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
};

const skipTrivia = (input: string, start: number, allowSemicolon = false): number => {
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (allowSemicolon && ch === ';') {
      i++;
      continue;
    }
    if (ch === '/' && input[i + 1] === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i = Math.min(i + 2, input.length);
      continue;
    }
    return i;
  }
  return i;
};

const previousNonTriviaChar = (input: string, start: number): string | undefined => {
  let i = start - 1;
  while (i >= 0 && /\s/.test(input[i])) i--;
  return input[i];
};

const isKeywordAt = (input: string, index: number, keyword: string): boolean => {
  if (input.slice(index, index + keyword.length).toLowerCase() !== keyword) return false;
  return !isIdentifierChar(input[index - 1]) && !isIdentifierChar(input[index + keyword.length]);
};

export function findTopLevelResultLimit(cypher: string): TopLevelCypherLimit {
  let depth = 0;
  let i = 0;
  let sawInvalidLimitCandidate = false;

  while (i < cypher.length) {
    const ch = cypher[i];

    if (ch === '"' || ch === "'") {
      i = skipQuoted(cypher, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipBacktickIdentifier(cypher, i);
      continue;
    }
    if (ch === '/' && (cypher[i + 1] === '/' || cypher[i + 1] === '*')) {
      i = skipTrivia(cypher, i);
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }

    if (
      depth === 0 &&
      isKeywordAt(cypher, i, 'limit') &&
      previousNonTriviaChar(cypher, i) !== '.'
    ) {
      const valueStart = skipTrivia(cypher, i + 'limit'.length);
      let valueEnd = valueStart;
      while (/[0-9]/.test(cypher[valueEnd] ?? '')) valueEnd++;

      if (valueEnd === valueStart) {
        sawInvalidLimitCandidate = true;
        i += 'limit'.length;
        continue;
      }

      const rawLimit = cypher.slice(valueStart, valueEnd);
      const limit = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(limit) || limit < 1) return { kind: 'invalid' };

      const trailingStart = skipTrivia(cypher, valueEnd, true);
      if (trailingStart >= cypher.length) return { kind: 'found', limit };

      i = valueEnd;
      continue;
    }

    i++;
  }

  if (sawInvalidLimitCandidate) return { kind: 'invalid' };
  return { kind: 'missing' };
}
