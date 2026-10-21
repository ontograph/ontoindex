import { describe, expect, it } from 'vitest';
// The executable is deliberately importable without spawning an MCP server.
import {
  classifyResult,
  parseArgs,
  payloadOf,
  runSmoke,
  recordServerIdentity,
} from '../../scripts/committed-navigation-smoke.mjs';

const options = { repoLabel: 'fixture', symbol: 'baseline', file: 'src/base.ts', timeout: 30000 };
const readContext = { mode: 'committed', indexedCommit: 'head', workingTreeIncluded: false };
const wrap = (payload: unknown, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) + '\n\n---\nNext hint' }],
  isError,
});

function fixture(
  overrides: {
    stale?: boolean;
    wrongRepo?: boolean;
    excessive?: boolean;
    refused?: boolean;
    refusalCode?: string;
  } = {},
) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const client = {
    callTool: async (request: (typeof calls)[number]) => {
      calls.push(request);
      const args = request.arguments;
      if (request.name === 'gn_ensure_fresh')
        return wrap({
          repoLabel: 'fixture',
          repoPath: overrides.wrongRepo ? '/wrong' : '/repo',
          isStale: Boolean(overrides.stale),
          indexedCommit: 'head',
          headCommit: 'head',
        });
      if (request.name === 'gn_verify_diff') {
        const omitted = !Object.hasOwn(args, 'expectedSymbols');
        const matches = omitted || (args.expectedSymbols as string[]).includes('smoke_expected');
        return wrap({
          status: matches ? 'PASS' : 'FAIL',
          actual: { changedSymbols: ['smoke_expected'] },
          unexpectedChangedSymbols: matches ? [] : ['smoke_expected'],
          skipReasons: omitted
            ? ['expectedSymbols not provided; symbol scope was not checked.']
            : [],
        });
      }
      if (!args.read_mode && overrides.refused)
        return wrap(
          {
            error: 'workspace_preparation_failed: workspace_too_large',
            code: overrides.refusalCode ?? 'workspace_too_large',
            retryable: false,
            remediation: { read_mode: 'committed' },
          },
          true,
        );
      if (request.name === 'gn_explore')
        return wrap({
          readContext,
          topSymbols: [{ name: 'baseline' }],
          taskPack: {
            nextCalls: [
              'inspect({ action: "context", repo: "fixture", uid: "Function:baseline", read_mode: "committed" })',
            ],
          },
        });
      if (request.name === 'search')
        return wrap({
          readContext,
          definitions: Array.from({ length: overrides.excessive ? 4 : 1 }, () => ({
            name: 'baseline',
          })),
        });
      if (request.name === 'inspect') return wrap({ readContext, status: 'found' });
      return wrap({ readContext, risk: 'LOW' });
    },
  };
  return { calls, client };
}

describe('installed committed-navigation smoke', () => {
  it('records advertised server identity alongside artifact provenance', () => {
    const manifest = { cliVersion: 'rc.8', cliSha256: 'artifact-hash' };
    expect(
      recordServerIdentity(manifest, {
        getServerVersion: () => ({ name: 'ontoindex', version: 'rc.3' }),
      }),
    ).toEqual({
      ...manifest,
      serverInfo: { name: 'ontoindex', version: 'rc.3' },
    });
    expect(recordServerIdentity(manifest, { getServerVersion: () => undefined })).toEqual({
      ...manifest,
      serverInfo: null,
    });
    expect(manifest).not.toHaveProperty('serverInfo');
  });
  it('parses JSON before a generated continuation and refuses partial evidence', () => {
    expect(payloadOf(wrap({ status: 'found' }))).toEqual({ status: 'found' });
    expect(classifyResult(wrap({ truncated: true })).kind).toBe('partial');
    expect(() => payloadOf({ content: [{ type: 'text', text: '{"truncated":' }] })).toThrow();
  });

  it.each([false, true])('keeps errors visible despite truncation (isError=%s)', (isError) => {
    const error = {
      error: 'workspace_preparation_failed: workspace_too_large',
      code: 'workspace_too_large',
      retryable: false,
      remediation: { read_mode: 'committed' },
    };
    for (const marker of [
      { truncated: true },
      { detailTruncated: true },
      { response_cursor: 'next' },
      { nextCursor: 'next' },
    ]) {
      expect(classifyResult(wrap({ ...error, ...marker }, isError)).kind).toBe('error');
    }
    expect(classifyResult(wrap({ truncated: true }, true)).kind).toBe('error');
  });

  it.each([{ stale: true }, { wrongRepo: true }])(
    'stops before navigation on freshness mismatch %j',
    async (overrides) => {
      const fake = fixture(overrides);
      const result = await runSmoke(options, { ...fake, head: 'head', repoPath: '/repo' });
      expect(result.contractPassed).toBe(false);
      expect(fake.calls).toHaveLength(1);
    },
  );

  it('records nonretryable workspace refusal separately and never repeats a request', async () => {
    const fake = fixture({ refused: true });
    const result = await runSmoke(options, { ...fake, head: 'head', repoPath: '/repo' });
    expect(result.contractPassed).toBe(true);
    expect(result.workspaceNavigationAvailable).toBe(false);
    expect(
      fake.calls.filter(
        (call) =>
          ['gn_explore', 'search', 'inspect', 'impact'].includes(call.name) &&
          !call.arguments.read_mode,
      ),
    ).toHaveLength(4);
    expect(result.callCount).toBeLessThanOrEqual(20);
    const diff = fake.calls.filter((call) => call.name === 'gn_verify_diff');
    expect(Object.hasOwn(diff[0].arguments, 'expectedSymbols')).toBe(false);
    expect(diff.slice(1).map((call) => call.arguments.expectedSymbols)).toEqual([
      [],
      ['smoke_expected'],
      ['different'],
    ]);
  });

  it('rejects a server that exceeds the semantic limit', async () => {
    const fake = fixture({ excessive: true });
    const result = await runSmoke(options, { ...fake, head: 'head', repoPath: '/repo' });
    expect(result.contractPassed).toBe(false);
    expect(result.checks).toContainEqual({ name: 'semantic limit is respected', pass: false });
  });

  it('rejects unrelated nonretryable errors with forged committed remediation', async () => {
    const fake = fixture({ refused: true, refusalCode: 'query_failed' });
    const result = await runSmoke(options, { ...fake, head: 'head', repoPath: '/repo' });
    expect(result.contractPassed).toBe(false);
    expect(result.workspace).toEqual(
      ['gn_explore', 'search', 'inspect', 'impact'].map((name) => ({
        name,
        classification: 'error',
        code: 'query_failed',
      })),
    );
  });

  it('requires explicit installed CLI and evidence location and caps timeout', () => {
    expect(() => parseArgs([])).toThrow('Missing');
    const args = [
      '--repo',
      '/repo',
      '--repo-label',
      'fixture',
      '--cli',
      '/installed/index.js',
      '--output-dir',
      '/new/evidence',
    ];
    expect(parseArgs(args).timeout).toBe(30000);
    expect(() => parseArgs([...args, '--timeout', '60001'])).toThrow('timeout');
    expect(() => parseArgs([...args, '--provider', 'anything'])).toThrow('Invalid argument');
  });
});
