import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('MCP git capture remains asynchronous', () => {
  it.each(['diff-impact', 'pre-commit-audit'])('%s avoids blocking subprocesses', async (name) => {
    const source = await readFile(
      new URL(`../../../src/mcp/super/${name}.ts`, import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('execFileSync');
  });
});
