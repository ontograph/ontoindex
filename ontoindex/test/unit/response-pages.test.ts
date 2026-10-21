import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pageMcpResponse,
  serializedMcpToolResultBytes,
  validateResponseBudget,
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
  it('binds committed-view cursors to the original mode', async () => {
    const args = { repo: 'fixture', read_mode: 'committed' };
    const first = await pageMcpResponse({
      tool: 'gn_explore',
      args,
      text: JSON.stringify({ topSymbols: ['x'.repeat(5000)] }),
      maxBytes: 1500,
    });
    const cursor = (JSON.parse(first.text) as ResponsePageEnvelope).responsePage.nextCursor!;
    expect(cursor).toBeDefined();
    await expect(
      pageMcpResponse({ tool: 'gn_explore', args: { repo: 'fixture' }, cursor, maxBytes: 1500 }),
    ).rejects.toThrow();
    expect(
      (await pageMcpResponse({ tool: 'gn_explore', args, cursor, maxBytes: 1500 })).paged,
    ).toBe(true);
  });
  it('validates an opt-in budget as a positive safe integer', () => {
    expect(validateResponseBudget(undefined)).toBeUndefined();
    expect(validateResponseBudget(1024)).toBe(1024);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1024']) {
      expect(() => validateResponseBudget(value)).toThrow('positive safe integer');
    }
  });

  it('omits only known detail collections and reports stable serialized byte counts', async () => {
    const original = JSON.stringify(
      {
        status: 'ok',
        summary: 'kept',
        topSymbols: Array.from({ length: 20 }, (_, i) => ({
          name: `λ-symbol-${i}`,
          source: 'x'.repeat(300),
        })),
        warnings: [],
      },
      null,
      2,
    );
    const budget = 700;
    const result = await pageMcpResponse({
      tool: 'gn_explore',
      args: { response_budget_bytes: budget },
      text: original,
      responseBudgetBytes: budget,
    });
    const projected = JSON.parse(result.text) as Record<string, any>;
    expect(result.paged).toBe(false);
    expect(projected.summary).toBe('kept');
    expect(projected.topSymbols).toBeUndefined();
    expect(projected.warnings).toEqual([]);
    expect(projected.responseBudget).toMatchObject({
      requestedBytes: budget,
      truncated: true,
      omittedFields: ['topSymbols'],
    });
    expect(projected.responseBudget.returnedBytes).toBe(serializedMcpToolResultBytes(result.text));
    expect(serializedMcpToolResultBytes(result.text)).toBeLessThanOrEqual(budget);
  });

  it('fails closed for unknown layouts and refuses to omit detail containing diagnostics', async () => {
    const text = JSON.stringify({
      topSymbols: [{ name: 'x', warnings: ['retain me'] }],
      summary: 'x'.repeat(2000),
    });
    await expect(
      pageMcpResponse({
        tool: 'gn_explore',
        args: {},
        text,
        responseBudgetBytes: 400,
      }),
    ).rejects.toThrow('preserve the response diagnostics');
    await expect(
      pageMcpResponse({
        tool: 'unregistered',
        args: {},
        text,
        responseBudgetBytes: 400,
      }),
    ).rejects.toThrow('safe response projection');
  });

  it('projects known capability envelopes without losing protected diagnostics', async () => {
    const text = JSON.stringify({
      envelopeVersion: '1',
      tool: 'search',
      version: 1,
      status: 'ok',
      targetContext: { scope: 'global', reason: 'query' },
      capabilitiesUsed: [],
      capabilitiesMissing: [],
      freshness: { status: 'fresh', actionable: true, reason: 'current' },
      results: ['x'.repeat(1500)],
      evidence: [],
      warnings: [],
      limits: {},
      nextTools: [],
    });
    const budget = 1000;
    const result = await pageMcpResponse({
      tool: 'search',
      args: {},
      text,
      responseBudgetBytes: budget,
    });
    const projected = JSON.parse(result.text);
    expect(projected.results).toBeUndefined();
    expect(projected.freshness.status).toBe('fresh');
    expect(projected.responseBudget.omittedFields).toContain('results');
    expect(serializedMcpToolResultBytes(result.text)).toBeLessThanOrEqual(budget);
  });

  it('projects known repository wrappers while retaining repository identity', async () => {
    const text = JSON.stringify({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      result: { summary: 'kept', results: ['x'.repeat(1600)] },
    });
    const budget = 700;
    const result = await pageMcpResponse({
      tool: 'search',
      args: {},
      text,
      responseBudgetBytes: budget,
    });
    const projected = JSON.parse(result.text);
    expect(projected.repoLabel).toBe('fixture');
    expect(projected.repoPath).toBe('/repo/fixture');
    expect(projected.result.summary).toBe('kept');
    expect(projected.result.results).toBeUndefined();
    expect(serializedMcpToolResultBytes(result.text)).toBeLessThanOrEqual(budget);
  });

  it('binds cursor replay to the requested logical budget', async () => {
    const first = await pageMcpResponse({
      tool: 'gn_explore',
      args: { response_budget_bytes: 60_000 },
      text: 'x'.repeat(55_000),
      responseBudgetBytes: 60_000,
    });
    expect(first.paged).toBe(true);
    const cursor = (JSON.parse(first.text) as ResponsePageEnvelope).responsePage.nextCursor;
    expect(cursor).toBeDefined();
    await expect(
      pageMcpResponse({
        tool: 'gn_explore',
        args: { response_budget_bytes: 60_001 },
        cursor,
        responseBudgetBytes: 60_001,
      }),
    ).rejects.toThrow('does not match');
  });

  it('returns responses that already fit without paging', async () => {
    const result = await pageMcpResponse({ tool: 'gn_test', args: {}, text: 'small' });

    expect(result).toEqual({ text: 'small', paged: false });
  });

  it('preserves JSON identity on every page when display text includes a next-step hint', async () => {
    const identity = {
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      graphGenerationId: 'generation-1',
      graphManifestDigest: 'digest-1',
    };
    const identityText = JSON.stringify({
      repoLabel: identity.repoLabel,
      repoPath: identity.repoPath,
      freshness: {
        graphGenerationId: identity.graphGenerationId,
        graphManifestDigest: identity.graphManifestDigest,
      },
      data: 'x'.repeat(5000),
    });
    const text = identityText + '\n\n---\n**Next:** Inspect the graph.';
    const args = { repo: 'fixture' };
    let result = await pageMcpResponse({
      tool: 'gn_test',
      args,
      text,
      identityText,
      maxBytes: 1024,
    });
    let reconstructed = '';

    while (true) {
      expect(result.paged).toBe(true);
      expect(serializedMcpToolResultBytes(result.text)).toBeLessThanOrEqual(1024);
      const page = JSON.parse(result.text) as ResponsePageEnvelope;
      expect(page.responsePage.identity).toEqual(identity);
      reconstructed += page.chunk;
      const cursor = page.responsePage.nextCursor;
      if (!cursor) break;
      result = await pageMcpResponse({ tool: 'gn_test', args, cursor, maxBytes: 1024 });
    }

    expect(reconstructed).toBe(text);
  });

  it('extracts identity from display text when no separate identity text is supplied', async () => {
    const result = await pageMcpResponse({
      tool: 'gn_test',
      args: {},
      text: JSON.stringify({
        repoLabel: 'fixture',
        repoPath: '/repo/fixture',
        data: 'x'.repeat(5000),
      }),
      maxBytes: 1024,
    });

    expect((JSON.parse(result.text) as ResponsePageEnvelope).responsePage.identity).toEqual({
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
    });
  });

  it('uses nested repository identity fallbacks coherently on every page', async () => {
    const cases: Array<{
      name: string;
      envelope: Record<string, unknown>;
      expected: Record<string, string>;
    }> = [
      {
        name: 'target context',
        envelope: {
          targetContext: {
            repoKey: 'target-repo',
            repoPath: '/repo/target',
            graphIndexId: 'index-1',
            graphAuthority: { generationId: 'generation-1', manifestDigest: 'digest-1' },
          },
        },
        expected: {
          repoLabel: 'target-repo',
          repoPath: '/repo/target',
          graphIndexId: 'index-1',
          generationId: 'generation-1',
          manifestDigest: 'digest-1',
        },
      },
      {
        name: 'freshness',
        envelope: {
          freshness: {
            repoLabel: 'fresh-repo',
            repoPath: '/repo/fresh',
            graphGenerationId: 'fresh-generation',
            graphManifestDigest: 'fresh-digest',
          },
        },
        expected: {
          repoLabel: 'fresh-repo',
          repoPath: '/repo/fresh',
          graphGenerationId: 'fresh-generation',
          graphManifestDigest: 'fresh-digest',
        },
      },
      {
        name: 'root identity over conflicting nested identities',
        envelope: {
          repoLabel: 'root-repo',
          repoPath: '/repo/root',
          targetContext: { repoLabel: 'target-repo', repoPath: '/repo/target' },
          freshness: { repoLabel: 'fresh-repo', repoPath: '/repo/fresh' },
        },
        expected: { repoLabel: 'root-repo', repoPath: '/repo/root' },
      },
      {
        name: 'global target scope does not contribute incidental repository fields',
        envelope: {
          targetContext: {
            scope: 'global',
            repoLabel: 'incidental-label',
            repoKey: 'incidental-key',
            repoPath: '/repo/incidental',
            graphIndexId: 'global-index',
          },
        },
        expected: { graphIndexId: 'global-index' },
      },
      {
        name: 'complete nested pair replaces incomplete root without mixing fields',
        envelope: {
          repoLabel: 'partial-root',
          targetContext: { repoLabel: 'target-repo', repoPath: '/repo/target' },
        },
        expected: { repoLabel: 'target-repo', repoPath: '/repo/target' },
      },
      {
        name: 'partial root is retained when no complete nested pair exists',
        envelope: {
          repoLabel: 'partial-root',
          targetContext: { repoPath: '/repo/target' },
        },
        expected: { repoLabel: 'partial-root' },
      },
      {
        name: 'absent repository identity stays absent',
        envelope: { targetContext: { scope: 'global' } },
        expected: {},
      },
    ];

    for (const testCase of cases) {
      const identityText = JSON.stringify({ ...testCase.envelope, data: 'x'.repeat(5000) });
      const args = { repo: 'fixture' };
      let result = await pageMcpResponse({
        tool: 'gn_test',
        args,
        text: 'y'.repeat(5000),
        identityText,
        maxBytes: 1024,
      });

      while (true) {
        expect(result.paged, testCase.name).toBe(true);
        expect(serializedMcpToolResultBytes(result.text), testCase.name).toBeLessThanOrEqual(1024);
        const page = JSON.parse(result.text) as ResponsePageEnvelope;
        expect(page.responsePage.identity, testCase.name).toEqual(testCase.expected);
        const cursor = page.responsePage.nextCursor;
        if (!cursor) break;
        result = await pageMcpResponse({
          tool: 'gn_test',
          args,
          cursor,
          maxBytes: 1024,
        });
      }
    }
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
