import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLogicalResponseBudget,
  pageMcpResponse,
  serializedMcpToolResultBytes,
  type ResponsePageEnvelope,
} from '../../src/mcp/shared/response-pages.js';

let resultDir: string;
beforeEach(async () => {
  resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-response-pages-small-'));
  process.env.ONTOINDEX_MCP_RESULT_DIR = resultDir;
});
afterEach(async () => {
  delete process.env.ONTOINDEX_MCP_RESULT_DIR;
  await fs.rm(resultDir, { recursive: true, force: true });
});

async function collectPages(
  text: string,
  maxBytes?: number,
): Promise<{
  reconstructed: string;
  pages: Array<ResponsePageEnvelope & { budgetRaisedTo?: number }>;
}> {
  const args = { repo: 'test' };
  let result = await pageMcpResponse({ tool: 'test', args, text, maxBytes });
  let reconstructed = '';
  const pages: Array<ResponsePageEnvelope & { budgetRaisedTo?: number }> = [];
  while (true) {
    const page = JSON.parse(result.text) as ResponsePageEnvelope & { budgetRaisedTo?: number };
    pages.push(page);
    reconstructed += page.chunk;
    const cursor = page.responsePage.nextCursor;
    if (!cursor) return { reconstructed, pages };
    result = await pageMcpResponse({ tool: 'test', args, cursor, maxBytes });
  }
}

async function collect(text: string, maxBytes?: number): Promise<string> {
  return (await collectPages(text, maxBytes)).reconstructed;
}

describe('applyLogicalResponseBudget retry hints', () => {
  it.each([false, true])(
    'reports the full size for an unsupported tool (isError=%s)',
    (isError) => {
      const text = JSON.stringify({ message: '日本語🙂'.repeat(100) });
      const fullSize = serializedMcpToolResultBytes(text, isError);
      expect(() => applyLogicalResponseBudget(text, 'manage', 1, isError)).toThrow(
        `response_budget_bytes is too small for a safe response projection. Requested 1 bytes; this response cannot be projected and needs at least ${fullSize} bytes (its full size).`,
      );
      expect(applyLogicalResponseBudget(text, 'manage', fullSize, isError)).toBe(text);
    },
  );

  it.each([false, true])('reports a retryable smallest projection (wrapped=%s)', (wrapped) => {
    const result = { results: [{ name: '日本語🙂'.repeat(500) }], evidence: ['x'.repeat(500)] };
    const text = JSON.stringify(
      wrapped ? { repoLabel: 'test', repoPath: '/test', result } : result,
    );
    let message = '';
    try {
      applyLogicalResponseBudget(text, 'search', 1);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /^response_budget_bytes is too small to preserve the response diagnostics\. Requested 1 bytes; the smallest safe projection needs \d+ bytes\.$/,
    );
    const minimumBytes = Number(message.match(/needs (\d+) bytes/)?.[1]);
    const projected = applyLogicalResponseBudget(text, 'search', minimumBytes);
    expect(serializedMcpToolResultBytes(projected)).toBe(minimumBytes);
    expect(JSON.parse(projected).responseBudget).toMatchObject({
      requestedBytes: minimumBytes,
      returnedBytes: minimumBytes,
      truncated: true,
      omittedFields: wrapped ? ['result.results', 'result.evidence'] : ['results', 'evidence'],
    });
  });

  it('reports the full size when diagnostic-bearing detail cannot be removed', () => {
    const text = JSON.stringify({ results: [{ warnings: ['keep this warning'] }] });
    const fullSize = serializedMcpToolResultBytes(text);
    expect(() => applyLogicalResponseBudget(text, 'search', 1)).toThrow(
      `response_budget_bytes is too small to preserve the response diagnostics. Requested 1 bytes; this response cannot be projected and needs at least ${fullSize} bytes (its full size).`,
    );
    expect(applyLogicalResponseBudget(text, 'search', fullSize)).toBe(text);
  });

  it('reports the full size for a non-JSON response', () => {
    const text = '日本語🙂';
    const fullSize = serializedMcpToolResultBytes(text);
    expect(() => applyLogicalResponseBudget(text, 'search', 1)).toThrow(
      `response_budget_bytes cannot fit this non-JSON response without losing diagnostics. Requested 1 bytes; the response needs ${fullSize} bytes.`,
    );
    expect(applyLogicalResponseBudget(text, 'search', fullSize)).toBe(text);
  });
});

describe('pageMcpResponse small budgets', () => {
  it.each([1, 10, 100])(
    'reassembles ASCII and multibyte text with maxBytes=%i',
    async (maxBytes) => {
      const ascii = 'abc'.repeat(400);
      const multibyte = '日本語🙂'.repeat(200);
      const asciiPages = await collectPages(ascii, maxBytes);
      const multibytePages = await collectPages(multibyte, maxBytes);
      expect(asciiPages.reconstructed).toBe(ascii);
      expect(multibytePages.reconstructed).toBe(multibyte);
      for (const page of [...asciiPages.pages, ...multibytePages.pages]) {
        if (page.budgetRaisedTo === undefined) {
          expect(serializedMcpToolResultBytes(JSON.stringify(page))).toBeLessThanOrEqual(maxBytes);
        }
      }
    },
  );

  it('honors a budget that fits the page envelope and raises an impossibly small budget', async () => {
    const text = 'x'.repeat(500);
    const probe = JSON.parse(
      (
        await pageMcpResponse({
          tool: 'test',
          args: { repo: 'test' },
          text: 'x'.repeat(20_000),
          maxBytes: 10_000,
        })
      ).text,
    ) as ResponsePageEnvelope;
    const envelopeBytes = serializedMcpToolResultBytes(JSON.stringify({ ...probe, chunk: '' }));
    const maxBytes = envelopeBytes + 20;
    const pages = await collectPages(text, maxBytes);
    expect(pages.reconstructed).toBe(text);
    expect(pages.pages.every((page) => page.budgetRaisedTo === undefined)).toBe(true);
    expect(
      pages.pages.every((page) => serializedMcpToolResultBytes(JSON.stringify(page)) <= maxBytes),
    ).toBe(true);

    const tiny = await collectPages(text, 1);
    expect(tiny.reconstructed).toBe(text);
    expect(tiny.pages.every((page) => typeof page.budgetRaisedTo === 'number')).toBe(true);
  });

  it('preserves multibyte characters at a tight page budget', async () => {
    const text = '日本語🙂'.repeat(80);
    const probe = JSON.parse(
      (
        await pageMcpResponse({
          tool: 'test',
          args: { repo: 'test' },
          text: 'x'.repeat(20_000),
          maxBytes: 10_000,
        })
      ).text,
    ) as ResponsePageEnvelope;
    const budget = serializedMcpToolResultBytes(JSON.stringify({ ...probe, chunk: '' })) + 20;
    const pages = await collectPages(text, budget);
    expect(pages.reconstructed).toBe(text);
    expect(pages.pages.every((page) => page.budgetRaisedTo === undefined)).toBe(true);
    expect(
      pages.pages.every((page) => serializedMcpToolResultBytes(JSON.stringify(page)) <= budget),
    ).toBe(true);
  });

  it('uses the default budget for non-positive and NaN limits', async () => {
    const text = 'x'.repeat(200_000);
    const expected = await collect(text);
    for (const maxBytes of [0, -1, Number.NaN]) {
      await expect(collect(text, maxBytes)).resolves.toBe(expected);
    }
  });
});
