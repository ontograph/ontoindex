import { describe, expect, it } from 'vitest';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';

describe('PHP casts around include and require expressions', () => {
  for (const tag of ['', '<?php\n']) {
    for (const operator of ['include', 'include_once', 'require', 'require_once']) {
      it(`parses ${operator} with ${tag ? 'tagged' : 'tagless'} PHP`, async () => {
        const source = `${tag}$config = (array) ${operator} $path;`;
        const parser = await createParserForLanguage('php', 'example.php', source);
        expect(parser?.parse(source).rootNode.hasError).toBe(false);
      });
    }
  }
});
