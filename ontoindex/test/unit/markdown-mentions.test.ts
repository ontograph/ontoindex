import { describe, it, expect } from 'vitest';
import { extractMentions } from '../../src/core/ingestion/markdown-mentions.js';

describe('Markdown Mentions Extractor', () => {
  const knownSymbols = new Set(['AuthService', 'login', 'User', 'validate']);

  it('returns empty array for plain prose without backticks', () => {
    const text = 'This is a normal sentence about auth service and login.';
    const results = extractMentions(text, knownSymbols);
    expect(results).toHaveLength(0);
  });

  it('identifies single inline mention', () => {
    const text = 'Check the `AuthService` for details.';
    const results = extractMentions(text, knownSymbols);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ symbol: 'AuthService', confidence: 0.4 });
  });

  it('identifies mention in code block with lower confidence', () => {
    // We want to simulate a code block where the symbol is mentioned inside backticks
    const text = 'Example:\n```ts\nconst x = `login()`;\n```';
    const results = extractMentions(text, knownSymbols);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ symbol: 'login', confidence: 0.3 });
  });

  it('ignores unknown symbols in backticks', () => {
    const text = 'Run `npm install` first.';
    const results = extractMentions(text, knownSymbols);
    expect(results).toHaveLength(0);
  });

  it('handles mixed content and picks highest confidence', () => {
    const text =
      'Use `AuthService` to log in.\n\n```ts\n`AuthService`.init();\n```\n\nAlso `User` model is important.';
    const results = extractMentions(text, knownSymbols);
    expect(results).toHaveLength(2);

    const auth = results.find((r) => r.symbol === 'AuthService');
    const user = results.find((r) => r.symbol === 'User');

    expect(auth?.confidence).toBe(0.4); // Inline wins over block
    expect(user?.confidence).toBe(0.4);
  });

  it('identifies multiple mentions on one line', () => {
    const text = 'Both `login` and `validate` are required.';
    const results = extractMentions(text, knownSymbols);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.symbol)).toContain('login');
    expect(results.map((r) => r.symbol)).toContain('validate');
  });
});
