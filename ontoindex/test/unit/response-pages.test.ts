import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pageMcpResponse,
  serializedMcpToolResultBytes,
  type ResponsePageEnvelope,
} from '../../src/mcp/shared/response-pages.js';

const originalResultDir = process.env.ONTOINDEX_MCP_RESULT_DIR;
let resultDir: string;

beforeEach(async () => {
  resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-response-pages-'));
  process.env.ONTOINDEX_MCP_RESULT_DIR = resultDir;
});

afterEach(async () => {
  if (originalResultDir === undefined) delete process.env.ONTOINDEX_MCP_RESULT_DIR;
  else process.env.ONTOINDEX_MCP_RESULT_DIR = originalResultDir;
  await fs.rm(resultDir, { recursive: true, force: true });
});

describe('pageMcpResponse', () => {
  it('returns responses that already fit without paging', async () => {
    const result = await pageMcpResponse({ tool: 'gn_test', args: {}, text: 'small' });

    expect(result).toEqual({ text: 'small', paged: false });
  });

  it('reconstructs multibyte text exactly while keeping every page within the byte limit', async () => {
    const maxBytes = 1024;
    const text = 'alpha-\u{1f600}-\u7d42\n'.repeat(4000);
    const args = { repo: 'ontoindex', limit: 7 };
    let result = await pageMcpResponse({ tool: 'gn_test', args, text, maxBytes });
    let reconstructed = '';

    while (true) {
      expect(result.paged).toBe(true);
      expect(serializedMcpToolResultBytes(result.text)).toBeLessThanOrEqual(maxBytes);
      const page = JSON.parse(result.text) as ResponsePageEnvelope;
      reconstructed += page.chunk;
      const cursor = page.responsePage.nextCursor;
      if (!cursor) break;
      result = await pageMcpResponse({
        tool: 'gn_test',
        args: { ...args, response_cursor: cursor },
        cursor,
        maxBytes,
      });
    }

    expect(reconstructed).toBe(text);
  });

  it('rejects cursors used with a different request', async () => {
    const first = await pageMcpResponse({
      tool: 'gn_test',
      args: { repo: 'ontoindex' },
      text: 'x'.repeat(5000),
      maxBytes: 1024,
    });
    const cursor = (JSON.parse(first.text) as ResponsePageEnvelope).responsePage.nextCursor!;

    await expect(
      pageMcpResponse({
        tool: 'gn_test',
        args: { repo: 'different', response_cursor: cursor },
        cursor,
        maxBytes: 1024,
      }),
    ).rejects.toThrow('Response cursor does not match this tool request.');
  });

  it('rejects a cursor with a modified integrity token', async () => {
    const first = await pageMcpResponse({
      tool: 'gn_test',
      args: {},
      text: 'x'.repeat(5000),
      maxBytes: 1024,
    });
    const cursor = (JSON.parse(first.text) as ResponsePageEnvelope).responsePage.nextCursor!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`;

    await expect(
      pageMcpResponse({
        tool: 'gn_test',
        args: { response_cursor: tampered },
        cursor: tampered,
        maxBytes: 1024,
      }),
    ).rejects.toThrow('Response cursor integrity check failed.');
  });
});
