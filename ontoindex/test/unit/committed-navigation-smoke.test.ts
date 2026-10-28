import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The executable is deliberately importable without spawning an MCP server.
import {
  classifyResult,
  parseArgs,
  payloadOf,
  readPackageIdentity,
  runSmoke,
  runFacadeSmoke,
  recordServerIdentity,
} from '../../scripts/committed-navigation-smoke.mjs';

const options = { repoLabel: 'fixture', symbol: 'baseline', file: 'src/base.ts', timeout: 30000 };
const readContext = { mode: 'committed', indexedCommit: 'head', workingTreeIncluded: false };
const wrap = (payload: unknown, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) + '\n\n---\nNext hint' }],
  isError,
});

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageFixture(manifest?: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'committed-navigation-identity-'));
  temporaryRoots.push(root);
  const cli = path.join(root, 'dist', 'cli', 'index.js');
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, '// fixture CLI; never executed\n');
  const packagePath = path.join(root, 'package.json');
  if (manifest !== undefined) writeFileSync(packagePath, manifest);
  return { root, cli, packagePath };
}

function fixture(
  overrides: {
    stale?: boolean;
    wrongRepo?: boolean;
    excessive?: boolean;
    refused?: boolean;
    refusalCode?: string;
    defaultInspect?: Record<string, unknown>;
    defaultImpact?: Record<string, unknown>;
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
      if (request.name === 'inspect')
        return wrap({
          readContext,
          status: 'found',
          ...(!args.read_mode ? overrides.defaultInspect : {}),
        });
      return wrap({
        readContext,
        risk: 'LOW',
        ...(!args.read_mode ? overrides.defaultImpact : {}),
      });
    },
  };
  return { calls, client };
}

describe('installed committed-navigation smoke', () => {
  it('reads the nearest package owning a nested CLI and hashes its exact bytes', () => {
    const bytes = '{\n  "name": "ontoindex", "version": "rc.8"\n}\n';
    const owner = packageFixture(bytes);
    expect(readPackageIdentity(owner.cli)).toEqual({
      packagePath: realpathSync(owner.packagePath),
      packageSha256: createHash('sha256').update(bytes).digest('hex'),
      packageName: 'ontoindex',
      packageVersion: 'rc.8',
    });
  });

  it('resolves a symlinked CLI to its actual package owner', () => {
    const bytes = '{"name":"ontoindex","version":"rc.8"}\n';
    const owner = packageFixture(bytes);
    const linkOwner = packageFixture('{"name":"ontoindex","version":"wrong-owner"}');
    const link = path.join(linkOwner.root, 'linked-cli.js');
    symlinkSync(owner.cli, link);
    expect(readPackageIdentity(link)).toEqual(readPackageIdentity(owner.cli));
    expect(readPackageIdentity(link).packagePath).toBe(realpathSync(owner.packagePath));
  });

  it.each([
    ['wrong package name', '{"name":"other-package","version":"rc.8"}'],
    ['malformed JSON', '{"name":'],
    ['missing version', '{"name":"ontoindex"}'],
    ['empty version', '{"name":"ontoindex","version":""}'],
    ['non-string version', '{"name":"ontoindex","version":8}'],
  ])('rejects the nearest manifest with %s instead of finding a valid ancestor', (_, invalid) => {
    const owner = packageFixture('{"name":"ontoindex","version":"rc.8"}');
    writeFileSync(path.join(owner.root, 'dist', 'package.json'), invalid);
    expect(() => readPackageIdentity(owner.cli)).toThrow();
  });

  it('rejects a CLI with no owning package manifest', () => {
    const owner = packageFixture();
    expect(() => readPackageIdentity(owner.cli)).toThrow();
  });

  it.each([
    [{ name: 'ontoindex', version: 'rc.8' }, true],
    [{ name: 'ontoindex', version: 'rc.3' }, false],
    [{ name: 'other-server', version: 'rc.8' }, false],
    [{ name: 'ontoindex', version: '' }, false],
    [{ name: 'ontoindex' }, false],
    [undefined, false],
  ])('records advertised server identity and verifies package agreement: %j', (server, matches) => {
    const manifest = Object.freeze({
      cliVersion: 'rc.8',
      cliSha256: 'artifact-hash',
      packagePath: '/installed/package.json',
      packageSha256: 'package-hash',
      packageName: 'ontoindex',
      packageVersion: 'rc.8',
    });
    expect(recordServerIdentity(manifest, { getServerVersion: () => server })).toEqual({
      ...manifest,
      serverInfo: server ? { name: server.name, version: server.version } : null,
      serverIdentityMatches: matches,
    });
    expect(manifest).not.toHaveProperty('serverInfo');
    expect(manifest).not.toHaveProperty('serverIdentityMatches');
  });
  it('parses JSON before a generated continuation and refuses partial evidence', () => {
    expect(payloadOf(wrap({ status: 'found' }))).toEqual({ status: 'found' });
    expect(classifyResult(wrap({ truncated: true })).kind).toBe('partial');
    expect(() => payloadOf({ content: [{ type: 'text', text: '{"truncated":' }] })).toThrow();
  });

  it('classifies plain-text MCP errors while rejecting non-error non-JSON results', () => {
    const content = [{ type: 'text', text: 'Error: read_mode=committed requires support.' }];
    expect(classifyResult({ isError: true, content })).toEqual({
      kind: 'error',
      payload: { error: content[0].text },
    });
    expect(() => classifyResult({ content })).toThrow(SyntaxError);
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

  it.each([
    ['missing source', {}],
    ['committed source', { source: 'committed-graph' }],
  ])('does not claim workspace availability for complete defaults with %s', async (_, payload) => {
    const fake = fixture({ defaultInspect: payload, defaultImpact: payload });
    const result = await runSmoke(options, { ...fake, head: 'head', repoPath: '/repo' });
    expect(result.contractPassed).toBe(true);
    expect(result.workspaceNavigationAvailable).toBe(false);
  });

  it('requires both default target lookups to resolve from the workspace graph', async () => {
    const workspace = { source: 'workspace-graph', readContext: undefined };
    const fake = fixture({ defaultInspect: workspace, defaultImpact: workspace });
    const result = await runSmoke(options, { ...fake, head: 'head', repoPath: '/repo' });
    expect(result.contractPassed).toBe(true);
    expect(result.workspaceNavigationAvailable).toBe(true);
    expect(result.workspace.slice(2)).toEqual([
      {
        name: 'inspect',
        classification: 'ok',
        code: undefined,
        source: 'workspace-graph',
        status: 'found',
      },
      {
        name: 'impact',
        classification: 'ok',
        code: undefined,
        source: 'workspace-graph',
        risk: 'LOW',
      },
    ]);
  });

  it.each([
    ['inspect', { source: undefined }],
    ['impact', { source: undefined }],
    ['inspect', { source: 'committed-graph' }],
    ['impact', { source: 'committed-graph' }],
    ['inspect', { readContext }],
    ['impact', { readContext }],
    ['inspect', { graphImpactAvailable: false }],
    ['impact', { graphImpactAvailable: false }],
    ['inspect', { status: 'ambiguous' }],
    ['impact', { risk: 'UNKNOWN' }],
    ['impact', { risk: undefined }],
  ])(
    'does not qualify workspace availability when default %s returns %j',
    async (name, payload) => {
      const workspace = { source: 'workspace-graph', readContext: undefined };
      const fake = fixture({
        defaultInspect: { ...workspace, ...(name === 'inspect' ? payload : {}) },
        defaultImpact: { ...workspace, ...(name === 'impact' ? payload : {}) },
      });
      const result = await runSmoke(options, { ...fake, head: 'head', repoPath: '/repo' });
      expect(result.contractPassed).toBe(true);
      expect(result.workspaceNavigationAvailable).toBe(false);
    },
  );

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
    expect(parseArgs(args).mode).toBe('navigation');
    expect(parseArgs([...args, '--mode', 'facade']).mode).toBe('facade');
    expect(() => parseArgs([...args, '--mode', 'unknown'])).toThrow();
    expect(() => parseArgs([...args, '--timeout', '60001'])).toThrow('timeout');
    expect(() => parseArgs([...args, '--provider', 'anything'])).toThrow('Invalid argument');
  });
});

function facadeFixture(
  overrides: {
    missingAction?: string;
    missingCommittedReadMode?: boolean;
    plainRelatedError?: 'gn_find_related' | 'inspect';
    nextCursor?: string;
    stale?: boolean;
    wrongRepo?: boolean;
    wrongHead?: boolean;
    wrongSymbol?: boolean;
    differentRelationships?: boolean;
    missingCallers?: 'gn_find_related' | 'inspect';
    relatedRefusal?: 'same' | 'different';
    relatedProvenance?: {
      tool: 'gn_find_related' | 'inspect';
      variant?:
        | 'missing readContext'
        | 'wrong mode'
        | 'wrong indexedCommit'
        | 'workingTreeIncluded:true';
    };
    refactorError?: string;
    refactorIsError?: boolean;
    throwRefactorError?: boolean;
    plainRefactorError?: boolean;
    budgetedRelatedError?: boolean;
    budgetedRelatedPartial?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const schemas = [
    ['inspect', 'related', { symbol: { type: 'string' }, maxItemsPerCategory: { type: 'number' } }],
    ['manage', 'ensure_fresh', { autoAnalyze: { type: 'boolean' } }],
    [
      'refactor',
      'safe_refactor',
      {
        intent: { type: 'string', enum: ['rename'] },
        params: { type: 'object' },
        dryRun: { type: 'boolean' },
      },
    ],
  ] as const;
  const tools = [
    ...schemas.map(([name, action, properties]) => ({
      name,
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: overrides.missingAction === name ? [] : [action] },
          ...properties,
          ...(name === 'inspect'
            ? {
                read_mode: {
                  type: 'string',
                  enum: overrides.missingCommittedReadMode
                    ? ['workspace']
                    : ['workspace', 'committed'],
                },
              }
            : {}),
        },
      },
    })),
    {
      name: 'gn_find_related',
      description: 'Legacy navigation — fixture',
      inputSchema: { type: 'object' },
    },
  ];
  const client = {
    listTools: async () => {
      calls.push({ name: 'tools/list' });
      return {
        tools,
        ...(overrides.nextCursor ? { nextCursor: overrides.nextCursor } : {}),
      };
    },
    callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(request);
      if (request.name === overrides.plainRelatedError)
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Error: read_mode=committed requires an explicit single repository and a supported navigation operation.',
            },
          ],
        };
      if (
        request.name === 'inspect' &&
        request.arguments.response_budget_bytes === 4096 &&
        overrides.budgetedRelatedError
      )
        return wrap({ error: 'budgeted related unavailable' }, true);
      if (request.name === 'gn_ensure_fresh' || request.name === 'manage')
        return wrap({
          repoLabel: 'fixture',
          repoPath: overrides.wrongRepo && request.name === 'manage' ? '/wrong' : '/repo',
          isStale: Boolean(overrides.stale),
          indexedCommit: overrides.wrongHead && request.name === 'manage' ? 'other' : 'head',
          headCommit: 'head',
        });
      if (
        overrides.relatedRefusal &&
        (request.name === 'gn_find_related' || request.name === 'inspect')
      )
        return wrap(
          {
            error: 'workspace_preparation_failed: workspace_too_large',
            code: 'workspace_too_large',
            retryable: false,
            diagnostics: {
              observedIndexedFiles:
                overrides.relatedRefusal === 'different' && request.name === 'inspect' ? 2 : 1,
            },
          },
          true,
        );
      if (request.name === 'gn_find_related' || request.name === 'inspect') {
        let context: Record<string, unknown> | undefined = readContext;
        if (overrides.relatedProvenance && overrides.relatedProvenance.tool === request.name) {
          const { variant } = overrides.relatedProvenance;
          if (variant === 'missing readContext') {
            context = undefined;
          } else if (variant === 'wrong mode') {
            context = { ...readContext, mode: 'workspace' };
          } else if (variant === 'wrong indexedCommit') {
            context = { ...readContext, indexedCommit: 'other' };
          } else if (variant === 'workingTreeIncluded:true') {
            context = { ...readContext, workingTreeIncluded: true };
          }
        }
        return wrap({
          ...(context !== undefined ? { readContext: context } : {}),
          ...(request.arguments.response_budget_bytes === 4096 && overrides.budgetedRelatedPartial
            ? { detailTruncated: true }
            : {}),
          ...(overrides.missingCallers === request.name
            ? {}
            : {
                callers: [
                  {
                    nodeId: 'Function:caller',
                    name: 'caller',
                    filePath: 'src/a.ts',
                    relationshipKind: 'CALLS',
                  },
                ],
              }),
          callees: [
            {
              nodeId:
                overrides.differentRelationships && request.name === 'inspect'
                  ? 'Function:other'
                  : 'Function:callee',
              name: 'callee',
              filePath: 'src/b.ts',
              relationshipKind: 'CALLS',
            },
          ],
          resolvedSymbol: {
            nodeId:
              overrides.wrongSymbol && request.name === 'inspect'
                ? 'Function:other'
                : 'Function:baseline',
            name: 'baseline',
          },
        });
      }
      if (overrides.throwRefactorError)
        throw new Error('response_budget_bytes must be a positive safe integer.');
      if (overrides.plainRefactorError)
        return {
          isError: true,
          content: [
            { type: 'text', text: 'Error: response_budget_bytes must be a positive safe integer.' },
          ],
        };
      return wrap(
        overrides.refactorIsError === false
          ? { status: 'ok' }
          : {
              error:
                overrides.refactorError ?? 'response_budget_bytes must be a positive safe integer.',
            },
        overrides.refactorIsError !== false,
      );
    },
  };
  return { client, calls, tools };
}

describe('installed facade smoke', () => {
  it.each([undefined, 'query-projects'])(
    'records exact advertised tool costs with startup profile %s',
    async (startupProfile) => {
      const previous = process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
      try {
        if (startupProfile === undefined) delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
        else process.env.ONTOINDEX_MCP_STARTUP_PROFILE = startupProfile;
        const fake = facadeFixture();
        const result = await runFacadeSmoke(options, {
          client: fake.client,
          head: 'head',
          repoPath: '/repo',
        });
        expect(result.contractPassed).toBe(true);
        expect(result.advertisement).toEqual({
          startupProfile: startupProfile ?? 'core',
          toolCount: 4,
          legacyToolCount: 1,
          toolsListBytes: Buffer.byteLength(JSON.stringify(fake.tools)),
          toolsListResultBytes: Buffer.byteLength(JSON.stringify({ tools: fake.tools })),
          schemaBytes: fake.tools.reduce(
            (total, tool) => total + Buffer.byteLength(JSON.stringify(tool.inputSchema)),
            0,
          ),
          compatibilityToolBytes: fake.tools
            .filter((tool) => tool.name.startsWith('gn_'))
            .reduce((total, tool) => total + Buffer.byteLength(JSON.stringify(tool)), 0),
        });
        expect(result.advertisement.toolsListBytes).toBeGreaterThan(
          JSON.stringify(fake.tools).length,
        );
        expect(result.advertisement.toolsListResultBytes).toBeGreaterThan(
          JSON.stringify({ tools: fake.tools }).length,
        );
        expect(result.advertisement.compatibilityToolBytes).toBeGreaterThan(
          JSON.stringify(fake.tools.find((tool) => tool.name === 'gn_find_related')).length,
        );
        expect(result.callCount).toBe(8);
        expect(fake.calls).toHaveLength(8);
      } finally {
        if (previous === undefined) delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
        else process.env.ONTOINDEX_MCP_STARTUP_PROFILE = previous;
      }
    },
  );

  it('checks advertised schemas and legacy/facade parity within a read-only call bound', async () => {
    const fake = facadeFixture();
    const records: Array<Array<{ response?: unknown }>> = [];
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
      record: (calls: Array<{ response?: unknown }>) => records.push(structuredClone(calls)),
    });
    expect(result.contractPassed).toBe(true);
    expect(result.mode).toBe('facade');
    expect(result.relatedAvailable).toBe(true);
    expect(result.invalidBudgetSurfaces).toEqual({
      gn_safe_refactor: 'isError',
      refactor: 'isError',
    });
    expect(result.checks).toContainEqual({
      name: 'positive logical budget keeps identity and provenance',
      pass: true,
    });
    expect(result.callCount).toBe(fake.calls.length);
    expect(result.callCount).toBeLessThanOrEqual(12);
    expect(fake.calls.map(({ name }) => name)).toEqual([
      'tools/list',
      'gn_ensure_fresh',
      'manage',
      'gn_find_related',
      'inspect',
      'inspect',
      'gn_safe_refactor',
      'refactor',
    ]);
    expect(records.length).toBeGreaterThan(0);
    expect(result.capturedResponseBytes).toBe(
      records
        .at(-1)!
        .filter((call) => call.response !== undefined)
        .reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call.response)), 0),
    );
    for (const call of fake.calls) {
      expect(call.arguments?.autoAnalyze).not.toBe(true);
      expect(call.arguments?.dryRun).not.toBe(false);
      expect(call.arguments?.confirm).not.toBe(true);
    }
    expect(
      fake.calls
        .filter(({ name }) => ['gn_ensure_fresh', 'manage'].includes(name))
        .map(({ arguments: args }) => args?.autoAnalyze),
    ).toEqual([false, false]);
    expect(
      fake.calls
        .filter(({ name }) => ['gn_find_related', 'inspect'].includes(name))
        .map(({ arguments: args }) => ({
          symbol: args?.symbol,
          read_mode: args?.read_mode,
          maxItemsPerCategory: args?.maxItemsPerCategory,
          includeCoChanged: args?.includeCoChanged,
          includeCrossRepo: args?.includeCrossRepo,
        })),
    ).toEqual(
      Array(3).fill({
        symbol: 'baseline',
        read_mode: 'committed',
        maxItemsPerCategory: 3,
        includeCoChanged: false,
        includeCrossRepo: false,
      }),
    );
    expect(
      fake.calls.filter(
        ({ name, arguments: args }) => name === 'inspect' && args?.response_budget_bytes === 4096,
      ),
    ).toHaveLength(1);
    expect(
      fake.calls
        .filter(({ name }) => ['gn_safe_refactor', 'refactor'].includes(name))
        .map(({ arguments: args }) => ({
          dryRun: args?.dryRun,
          response_budget_bytes: args?.response_budget_bytes,
        })),
    ).toEqual([
      { dryRun: true, response_budget_bytes: -1 },
      { dryRun: true, response_budget_bytes: -1 },
    ]);
  });

  it.each(['inspect', 'manage', 'refactor'])(
    'rejects an advertised %s schema missing its facade action',
    async (missingAction) => {
      const fake = facadeFixture({ missingAction });
      const result = await runFacadeSmoke(options, {
        client: fake.client,
        head: 'head',
        repoPath: '/repo',
      });
      expect(result.contractPassed).toBe(false);
      expect(fake.calls).toEqual([{ name: 'tools/list' }]);
    },
  );

  it('stops after the first stale freshness response', async () => {
    const fake = facadeFixture({ stale: true });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(false);
    expect(fake.calls.map(({ name }) => name)).toEqual(['tools/list', 'gn_ensure_fresh']);
  });

  it('stops before related calls when inspect does not advertise committed reads', async () => {
    const fake = facadeFixture({ missingCommittedReadMode: true });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(false);
    expect(result.checks).toContainEqual({
      name: 'inspect: advertises committed read_mode',
      pass: false,
    });
    expect(fake.calls).toEqual([{ name: 'tools/list' }]);
  });

  it.each(['gn_find_related', 'inspect'] as const)(
    'names plain-text committed-read errors from %s',
    async (plainRelatedError) => {
      const fake = facadeFixture({ plainRelatedError });
      const result = await runFacadeSmoke(options, {
        client: fake.client,
        head: 'head',
        repoPath: '/repo',
      });
      expect(result.contractPassed).toBe(false);
      expect(result.checks).toContainEqual({
        name: 'related committed read accepted',
        pass: false,
        error:
          'Error: read_mode=committed requires an explicit single repository and a supported navigation operation.',
      });
      expect(result.checks.some(({ name }) => name === 'facade smoke execution')).toBe(false);
    },
  );

  it('stops after a paginated tool listing', async () => {
    const fake = facadeFixture({ nextCursor: 'next' });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(false);
    expect(fake.calls).toEqual([{ name: 'tools/list' }]);
  });

  it.each([
    { differentRelationships: true },
    { missingCallers: 'gn_find_related' },
    { missingCallers: 'inspect' },
  ] as const)('rejects mismatched or missing related relationships %j', async (overrides) => {
    const fake = facadeFixture(overrides);
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.relatedAvailable).toBe(false);
    expect(result.contractPassed).toBe(false);
  });

  it.each([{ wrongRepo: true }, { wrongHead: true }, { wrongSymbol: true }])(
    'rejects mismatched legacy/facade identity %j',
    async (overrides) => {
      const fake = facadeFixture(overrides);
      const result = await runFacadeSmoke(options, {
        client: fake.client,
        head: 'head',
        repoPath: '/repo',
      });
      expect(result.contractPassed).toBe(false);
      expect(fake.calls.length).toBeLessThanOrEqual(12);
    },
  );

  it('rejects backend failures as proof of safe argument rejection', async () => {
    const fake = facadeFixture({ refactorError: 'backend unavailable' });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(false);
  });

  it('rejects a successful response to an invalid refactor budget', async () => {
    const fake = facadeFixture({ refactorIsError: false });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(false);
    expect(result.invalidBudgetSurfaces).toEqual({ gn_safe_refactor: null, refactor: null });
  });

  it('rejects an error from the positive-budget related call', async () => {
    const fake = facadeFixture({ budgetedRelatedError: true });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.relatedAvailable).toBe(true);
    expect(result.contractPassed).toBe(false);
    expect(result.checks).toContainEqual({
      name: 'positive logical budget keeps identity and provenance',
      pass: false,
    });
  });

  it('accepts a partial positive-budget response retaining identity and provenance', async () => {
    const fake = facadeFixture({ budgetedRelatedPartial: true });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(true);
  });

  it('accepts SDK-thrown argument errors for the invalid refactor budget', async () => {
    const fake = facadeFixture({ throwRefactorError: true });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(true);
    expect(result.callCount).toBe(8);
    expect(result.invalidBudgetSurfaces).toEqual({ gn_safe_refactor: 'throw', refactor: 'throw' });
  });

  it('accepts plain MCP argument errors for the invalid refactor budget', async () => {
    const fake = facadeFixture({ plainRefactorError: true });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.contractPassed).toBe(true);
    expect(result.callCount).toBe(8);
    expect(result.invalidBudgetSurfaces).toEqual({
      gn_safe_refactor: 'isError',
      refactor: 'isError',
    });
  });

  it('rejects identical related workspace refusals for explicit committed reads', async () => {
    const fake = facadeFixture({ relatedRefusal: 'same' });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result).toMatchObject({ contractPassed: false, relatedAvailable: false, callCount: 8 });
  });

  it('rejects different related workspace refusals', async () => {
    const fake = facadeFixture({ relatedRefusal: 'different' });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result).toMatchObject({ contractPassed: false, relatedAvailable: false });
  });

  it.each([
    ['gn_find_related', 'missing readContext'],
    ['gn_find_related', 'wrong mode'],
    ['gn_find_related', 'wrong indexedCommit'],
    ['gn_find_related', 'workingTreeIncluded:true'],
    ['inspect', 'missing readContext'],
    ['inspect', 'wrong mode'],
    ['inspect', 'wrong indexedCommit'],
    ['inspect', 'workingTreeIncluded:true'],
  ] as const)('rejects invalid committed provenance for %s with %s', async (tool, variant) => {
    const fake = facadeFixture({ relatedProvenance: { tool, variant } });
    const result = await runFacadeSmoke(options, {
      client: fake.client,
      head: 'head',
      repoPath: '/repo',
    });
    expect(result.relatedAvailable).toBe(false);
    expect(result.contractPassed).toBe(false);
  });
});
