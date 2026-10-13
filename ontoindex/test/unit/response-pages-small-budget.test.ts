import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pageMcpResponse, type ResponsePageEnvelope } from '../../src/mcp/shared/response-pages.js';

let resultDir: string;
beforeEach(async () => {
  resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-response-pages-small-'));
  process.env.ONTOINDEX_MCP_RESULT_DIR = resultDir;
});
afterEach(async () => {
  delete process.env.ONTOINDEX_MCP_RESULT_DIR;
  await fs.rm(resultDir, { recursive: true, force: true });
});

async function collect(text: string, maxBytes?: number): Promise<string> {
  const args = { repo: 'test' };
  let result = await pageMcpResponse({ tool: 'test', args, text, maxBytes });
  let reconstructed = '';
  while (true) {
    const page = JSON.parse(result.text) as ResponsePageEnvelope;
    reconstructed += page.chunk;
    const cursor = page.responsePage.nextCursor;
    if (!cursor) return reconstructed;
    result = await pageMcpResponse({ tool: 'test', args, cursor, maxBytes });
  }
}

describe('pageMcpResponse small budgets', () => {
  it.each([1, 10, 100])(
    'reassembles ASCII and multibyte text with maxBytes=%i',
    async (maxBytes) => {
      const ascii = 'abc'.repeat(400);
      const multibyte = '日本語🙂'.repeat(200);
      await expect(collect(ascii, maxBytes)).resolves.toBe(ascii);
      await expect(collect(multibyte, maxBytes)).resolves.toBe(multibyte);
    },
  );

  it('uses the default budget for non-positive and NaN limits', async () => {
    const text = 'x'.repeat(200_000);
    const expected = await collect(text);
    for (const maxBytes of [0, -1, Number.NaN]) {
      await expect(collect(text, maxBytes)).resolves.toBe(expected);
    }
  });
});
