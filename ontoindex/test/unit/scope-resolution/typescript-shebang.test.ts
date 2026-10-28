import { describe, expect, it } from 'vitest';
import { type CaptureMatch, SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { ScopeUnsupportedSyntaxError } from '../../../src/core/ingestion/scope-unsupported-syntax.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from '../../../src/core/ingestion/languages/typescript-scope-captures.js';

async function parse(source: string, filePath: string) {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  return { parser, root: parser.parse(source).rootNode };
}

const shebang = '#!/usr/bin/env node\n';
const code = 'export function make() { return 1; }\nmake();\n';

function withoutShebangLine(captures: CaptureMatch[]) {
  return captures.map((match) =>
    Object.fromEntries(
      Object.entries(match).map(([key, capture]) => [
        key,
        {
          ...capture,
          range: {
            ...capture.range,
            // The module still starts at line 1; all other ranges move with the code.
            startLine: key === '@scope.module' ? 1 : capture.range.startLine - 1,
            endLine: capture.range.endLine - 1,
          },
        },
      ]),
    ),
  );
}

describe.each(['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'])(
  'leading shebang captures in %s',
  (filePath) => {
    it('preserves the complete capture set after normalizing the added line', async () => {
      const { root } = await parse(shebang + code, filePath);
      const { root: plainRoot } = await parse(code, filePath);
      expect(root.hasError).toBe(false);
      expect(root.children[0]!.type).toBe('hash_bang_line');
      expect(withoutShebangLine(emitTypeScriptCaptures(root))).toEqual(
        emitTypeScriptCaptures(plainRoot),
      );
    });

    it('accepts a comment between the shebang and executable code', async () => {
      const commentedCode = '// executable module\n' + code;
      const { root } = await parse(shebang + commentedCode, filePath);
      const { root: plainRoot } = await parse(commentedCode, filePath);
      expect(root.hasError).toBe(false);
      expect(root.children.slice(0, 2).map((node) => node.type)).toEqual([
        'hash_bang_line',
        'comment',
      ]);
      expect(withoutShebangLine(emitTypeScriptCaptures(root))).toEqual(
        emitTypeScriptCaptures(plainRoot),
      );
    });

    it('keeps a shebang-only program equivalent to an empty module', async () => {
      const { root } = await parse(shebang, filePath);
      const { root: emptyRoot } = await parse('', filePath);
      expect(root.hasError).toBe(false);
      const captures = emitTypeScriptCaptures(root);
      const emptyCaptures = emitTypeScriptCaptures(emptyRoot);
      expect(captures).toEqual(emitTypeScriptLexicalScopeCaptures(root));
      expect(emptyCaptures).toEqual(emitTypeScriptLexicalScopeCaptures(emptyRoot));
      // Module ranges describe their respective source, so compare capture names and text.
      const contents = (matches: CaptureMatch[]) =>
        matches.map((match) =>
          Object.fromEntries(
            Object.entries(match).map(([key, { name, text }]) => [key, { name, text }]),
          ),
        );
      expect(contents(captures)).toEqual(contents(emptyCaptures));
      expect(captures.map((match) => Object.keys(match))).toEqual([['@scope.module']]);
    });

    it('refuses an error-free shebang that follows a comment', async () => {
      const { root } = await parse('// preceding comment\n' + shebang + code, filePath);
      expect(root.hasError).toBe(false);
      expect(root.children.slice(0, 2).map((node) => node.type)).toEqual([
        'comment',
        'hash_bang_line',
      ]);
      expect(() => emitTypeScriptCaptures(root)).toThrow(ScopeUnsupportedSyntaxError);
    });
  },
);

describe.each(['fixture.ts', 'fixture.tsx'])('type-only shebang captures in %s', (filePath) => {
  it('retains nominal declarations and type imports alongside lexical module captures', async () => {
    const source = "import type { A } from './a';\nexport type B = A;\n";
    const { root } = await parse(shebang + source, filePath);
    expect(root.hasError).toBe(false);
    expect(root.children[0]!.type).toBe('hash_bang_line');
    const captures = emitTypeScriptCaptures(root);
    expect(
      captures.filter((match) => Object.keys(match).some((key) => key.startsWith('@scope.'))),
    ).toEqual(emitTypeScriptLexicalScopeCaptures(root));
    expect(captures.map((match) => Object.keys(match))).toEqual([
      ['@scope.module'],
      ['@declaration.typealias', '@declaration.name'],
      ['@import.binding', '@import.source', '@import.name', '@import.kind', '@import.namespace'],
      ['@export.local', '@export.name'],
    ]);
    expect(captures[1]!['@declaration.name']!.text).toBe('B');
    expect(captures[2]!['@import.binding']!.text).toBe('A');
    expect(captures[2]!['@import.namespace']!.text).toBe('type');
    expect(captures[3]!['@export.name']!.text).toBe('B');
    const { root: plainRoot } = await parse(source, filePath);
    expect(withoutShebangLine(captures)).toEqual(emitTypeScriptCaptures(plainRoot));
  });
});
