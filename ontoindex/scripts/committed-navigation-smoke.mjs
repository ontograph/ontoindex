#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const options = {
    mode: 'navigation',
    symbol: 'SubagentNotification',
    file: 'ontocode-rs/core/src/context/subagent_notification.rs',
    timeout: 30000,
  };
  const keys = {
    '--repo': 'repo',
    '--repo-label': 'repoLabel',
    '--cli': 'cli',
    '--output-dir': 'outputDir',
    '--symbol': 'symbol',
    '--file': 'file',
    '--timeout': 'timeout',
    '--mode': 'mode',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]],
      value = argv[i + 1];
    if (!key || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${argv[i]}`);
    options[key] = key === 'timeout' ? Number(value) : value;
  }
  for (const key of ['repo', 'repoLabel', 'cli', 'outputDir'])
    if (!options[key]) throw new Error(`Missing ${key}`);
  if (!path.isAbsolute(options.cli) || !/\.m?js$/.test(options.cli))
    throw new Error('--cli must be an absolute JavaScript file');
  if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 60000)
    throw new Error('timeout must be 1..60000 ms');
  if (!['navigation', 'facade'].includes(options.mode))
    throw new Error('--mode must be navigation or facade');
  return options;
}

export function payloadOf(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('Missing MCP JSON payload');
  return JSON.parse(text.split(/\n(?:\n)?---(?:\n|$)/)[0]);
}

export function classifyResult(result) {
  let payload;
  try {
    payload = payloadOf(result);
  } catch (error) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (!result.isError || !(error instanceof SyntaxError) || !text) throw error;
    return { kind: 'error', payload: { error: text } };
  }
  const partial = Boolean(
    payload.truncated === true ||
    payload.detailTruncated === true ||
    payload.response_cursor ||
    payload.nextCursor,
  );
  if (result.isError || payload.error)
    return {
      kind:
        !partial && payload.code === 'workspace_too_large' && payload.retryable === false
          ? 'refused'
          : 'error',
      payload,
    };
  if (partial) return { kind: 'partial', payload };
  return { kind: 'ok', payload };
}

export function readPackageIdentity(cli) {
  let directory = path.dirname(realpathSync(cli));
  for (;;) {
    const candidate = path.join(directory, 'package.json');
    let bytes;
    try {
      bytes = readFileSync(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (bytes !== undefined) {
      const identity = JSON.parse(bytes.toString('utf8'));
      if (
        identity?.name !== 'ontoindex' ||
        typeof identity.version !== 'string' ||
        identity.version.trim().length === 0
      )
        throw new Error(`Invalid ontoindex package identity: ${candidate}`);
      return {
        packagePath: realpathSync(candidate),
        packageSha256: createHash('sha256').update(bytes).digest('hex'),
        packageName: identity.name,
        packageVersion: identity.version,
      };
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No package.json found for CLI: ${cli}`);
    directory = parent;
  }
}

export function recordServerIdentity(manifest, client) {
  const server = client.getServerVersion();
  return {
    ...manifest,
    serverInfo: server ? { name: server.name, version: server.version } : null,
    serverIdentityMatches: Boolean(
      server?.name === 'ontoindex' &&
      typeof server.version === 'string' &&
      server.version.trim().length > 0 &&
      server.version === manifest.packageVersion,
    ),
  };
}

export function hasCommittedProvenance(result, head) {
  const context = result?.payload?.readContext;
  return (
    result?.kind === 'ok' &&
    context?.mode === 'committed' &&
    context?.indexedCommit === head &&
    context?.workingTreeIncluded === false
  );
}

// One attempt per request; explicit committed reads are a separate requested mode.
export async function runSmoke(options, { client, head, repoPath, record = () => {} }) {
  const checks = [],
    calls = [],
    workspace = [];
  let workspaceTargetResolved = true;
  const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  const call = async (name, args) => {
    if (calls.length >= 20) throw new Error('20-call limit exceeded');
    const entry = {
      name,
      arguments: { repo: options.repoLabel, ...args },
      startedAt: new Date().toISOString(),
    };
    calls.push(entry);
    const start = performance.now();
    try {
      entry.response = await client.callTool({ name, arguments: entry.arguments }, undefined, {
        timeout: options.timeout,
      });
      return classifyResult(entry.response);
    } catch (error) {
      entry.error = String(error);
      throw error;
    } finally {
      entry.elapsedMs = performance.now() - start;
      record(calls);
    }
  };
  const provenance = (result, name) => {
    check(`${name}: committed provenance`, hasCommittedProvenance(result, head));
  };
  try {
    const fresh = await call('gn_ensure_fresh', { autoAnalyze: false });
    const valid =
      fresh.kind === 'ok' &&
      fresh.payload.isStale === false &&
      fresh.payload.indexedCommit === head &&
      fresh.payload.headCommit === head &&
      fresh.payload.repoLabel === options.repoLabel &&
      fresh.payload.repoPath === repoPath;
    check('fresh index matches requested repository and HEAD', valid);
    if (!valid) throw new Error('Freshness or target mismatch; navigation stopped');
    const navigation = [
      [
        'gn_explore',
        { query: options.symbol, depth: 'shallow', includeSkeletons: false, profile: 'task-pack' },
      ],
      ['search', { action: 'semantic', query: options.symbol, limit: 3, include_content: false }],
      [
        'inspect',
        {
          action: 'context',
          target: options.symbol,
          file_path: options.file,
          include_content: false,
        },
      ],
      [
        'impact',
        { action: 'symbol', target: options.symbol, file_path: options.file, maxDepth: 1 },
      ],
    ];
    for (const [name, args] of navigation) {
      const result = await call(name, args);
      const payload = result.payload;
      workspace.push({
        name,
        classification: result.kind,
        code: payload.code,
        ...(payload.source !== undefined ? { source: payload.source } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.risk !== undefined ? { risk: payload.risk } : {}),
      });
      if (name === 'inspect' || name === 'impact')
        workspaceTargetResolved &&=
          payload.source === 'workspace-graph' &&
          payload.graphImpactAvailable !== false &&
          payload.readContext?.mode !== 'committed' &&
          (name === 'inspect'
            ? payload.status === 'found'
            : Boolean(payload.risk && payload.risk !== 'UNKNOWN'));
      if (result.kind === 'refused')
        check(
          `${name}: refusal has committed remediation`,
          result.payload.retryable === false &&
            result.payload.remediation?.read_mode === 'committed',
        );
      else check(`${name}: default response complete`, result.kind === 'ok');
    }
    let explore, inspect, namedImpact;
    for (const [name, args] of navigation) {
      const result = await call(name, { ...args, read_mode: 'committed' });
      provenance(result, name);
      if (name === 'gn_explore') {
        explore = result.payload;
        check('explore returns symbols', explore.topSymbols?.length > 0);
      }
      if (name === 'search')
        check(
          'semantic limit is respected',
          result.payload.definitions?.length > 0 && result.payload.definitions.length <= 3,
        );
      if (name === 'inspect') inspect = result.payload;
      if (name === 'impact') namedImpact = result.payload;
    }
    const isStruct = (item) => item.kind === 'Struct' || item.uid?.startsWith('Struct:');
    const candidate = inspect?.candidates
      ?.filter((item) => item.name === options.symbol && item.filePath === options.file)
      .sort((a, b) => Number(isStruct(b)) - Number(isStruct(a)))[0];
    if (inspect?.status === 'ambiguous' && candidate?.uid) {
      const result = await call('inspect', {
        action: 'context',
        uid: candidate.uid,
        read_mode: 'committed',
        include_content: false,
      });
      provenance(result, 'UID inspect');
      check('UID context resolves', result.payload.status === 'found');
      const impact = await call('impact', {
        action: 'symbol',
        target: options.symbol,
        target_uid: candidate.uid,
        read_mode: 'committed',
        maxDepth: 1,
      });
      provenance(impact, 'UID impact');
      check('UID impact resolves', impact.payload.risk && impact.payload.risk !== 'UNKNOWN');
    } else {
      check('named context resolves', inspect?.status === 'found');
      check('named impact resolves', namedImpact?.risk && namedImpact.risk !== 'UNKNOWN');
    }
    const example =
      explore?.taskPack?.nextCalls?.find((item) => item.startsWith('inspect(')) ??
      explore?.topSymbols?.find((item) => item.retryExamples?.inspect)?.retryExamples.inspect;
    const fields = Object.fromEntries(
      [...(example ?? '').matchAll(/(action|repo|uid|read_mode): "([^"\n]*)"/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    const safe =
      fields.action === 'context' &&
      fields.repo === options.repoLabel &&
      fields.uid &&
      fields.read_mode === 'committed';
    check('generated inspect retains committed mode and target', safe);
    if (safe) {
      const result = await call('inspect', { ...fields, include_content: false });
      provenance(result, 'generated continuation');
      check('generated continuation resolves', result.payload.status === 'found');
    }
    // Caller-supplied deterministic symbols test expectation semantics, not diff discovery.
    for (const expectedSymbols of [undefined, [], ['smoke_expected'], ['different']]) {
      const result = await call('gn_verify_diff', {
        scope: 'all',
        changedFiles: [],
        expectedFiles: [],
        changedSymbols: ['smoke_expected'],
        ...(expectedSymbols === undefined ? {} : { expectedSymbols }),
      });
      const omitted = expectedSymbols === undefined,
        matches = omitted || expectedSymbols.includes('smoke_expected');
      check(
        `diff expectations ${JSON.stringify(expectedSymbols) ?? 'omitted'}`,
        result.kind === 'ok' &&
          result.payload.status === (matches ? 'PASS' : 'FAIL') &&
          JSON.stringify(result.payload.actual?.changedSymbols) === '["smoke_expected"]' &&
          JSON.stringify(result.payload.unexpectedChangedSymbols) ===
            JSON.stringify(matches ? [] : ['smoke_expected']) &&
          JSON.stringify(result.payload.skipReasons) ===
            JSON.stringify(
              omitted ? ['expectedSymbols not provided; symbol scope was not checked.'] : [],
            ),
      );
    }
  } catch (error) {
    checks.push({ name: 'smoke execution', pass: false, error: String(error) });
  }
  return {
    contractPassed: checks.every((item) => item.pass),
    workspaceNavigationAvailable:
      workspace.length === 4 &&
      workspace.every((item) => item.classification === 'ok') &&
      workspaceTargetResolved,
    workspace,
    checks,
    callCount: calls.length,
  };
}

// All requests are read-only, including the deliberately invalid refactor arguments.
export async function runFacadeSmoke(options, { client, head, repoPath, record = () => {} }) {
  const checks = [],
    calls = [];
  const invalidBudgetSurfaces = { gn_safe_refactor: null, refactor: null };
  let advertisement = null;
  let relatedAvailable = false;
  const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  const call = async (name, args) => {
    if (calls.length >= 12) throw new Error('12-call limit exceeded');
    const entry = {
      name,
      ...(args === undefined ? {} : { arguments: { repo: options.repoLabel, ...args } }),
      startedAt: new Date().toISOString(),
    };
    calls.push(entry);
    const start = performance.now();
    try {
      entry.response =
        name === 'tools/list'
          ? await client.listTools({}, { timeout: options.timeout })
          : await client.callTool({ name, arguments: entry.arguments }, undefined, {
              timeout: options.timeout,
            });
      // Argument validation runs before repository identity is attached, so the
      // server may return its exact diagnostic as plain text instead of JSON.
      const diagnostic = entry.response.content?.find((item) => item.type === 'text')?.text;
      if (
        args?.response_budget_bytes === -1 &&
        entry.response.isError &&
        diagnostic === 'Error: response_budget_bytes must be a positive safe integer.'
      ) {
        invalidBudgetSurfaces[name] = 'isError';
        return { kind: 'error', payload: { error: diagnostic } };
      }
      const result = name === 'tools/list' ? entry.response : classifyResult(entry.response);
      if (
        args?.response_budget_bytes === -1 &&
        entry.response.isError &&
        result.kind === 'error' &&
        /response_budget_bytes must be a positive safe integer\./.test(String(result.payload.error))
      )
        invalidBudgetSurfaces[name] = 'isError';
      return result;
    } catch (error) {
      entry.error = String(error);
      // Some MCP clients throw protocol argument errors instead of returning isError.
      if (
        args?.response_budget_bytes === -1 &&
        /response_budget_bytes must be a positive safe integer\./.test(entry.error)
      ) {
        invalidBudgetSurfaces[name] = 'throw';
        return { kind: 'error', payload: { error: entry.error } };
      }
      throw error;
    } finally {
      entry.elapsedMs = performance.now() - start;
      record(calls);
    }
  };
  try {
    const listed = await call('tools/list');
    advertisement = {
      startupProfile: options.startupProfile ?? process.env.ONTOINDEX_MCP_STARTUP_PROFILE ?? 'core',
      toolCount: listed.tools.length,
      legacyToolCount: listed.tools.filter((tool) => tool.name.startsWith('gn_')).length,
      toolsListBytes: Buffer.byteLength(JSON.stringify(listed.tools)),
      toolsListResultBytes: Buffer.byteLength(JSON.stringify(listed)),
      schemaBytes: listed.tools.reduce(
        (total, tool) => total + Buffer.byteLength(JSON.stringify(tool.inputSchema)),
        0,
      ),
      compatibilityToolBytes: listed.tools
        .filter((tool) => tool.name.startsWith('gn_'))
        .reduce((total, tool) => total + Buffer.byteLength(JSON.stringify(tool)), 0),
    };
    const schemas = [
      ['inspect', 'related', { symbol: 'string', maxItemsPerCategory: 'number' }],
      ['manage', 'ensure_fresh', { autoAnalyze: 'boolean' }],
      ['refactor', 'safe_refactor', { intent: 'string', params: 'object', dryRun: 'boolean' }],
    ];
    for (const [name, action, fields] of schemas) {
      const schema = listed.tools?.find((tool) => tool.name === name)?.inputSchema;
      check(
        `${name}: advertises ${action} schema`,
        schema?.type === 'object' &&
          schema.required?.includes('action') &&
          schema.properties?.action?.enum?.includes(action) &&
          Object.entries(fields).every(
            ([field, type]) => schema.properties?.[field]?.type === type,
          ) &&
          (name !== 'refactor' || schema.properties.intent.enum?.includes('rename')),
      );
    }
    check(
      'inspect: advertises committed read_mode',
      listed.tools
        .find((tool) => tool.name === 'inspect')
        ?.inputSchema?.properties?.read_mode?.enum?.includes('committed'),
    );
    check('tools/list is complete', !listed.nextCursor);
    if (checks.some((item) => !item.pass)) throw new Error('Facade schema mismatch; calls stopped');
    for (const [name, args] of [
      ['gn_ensure_fresh', { autoAnalyze: false }],
      ['manage', { action: 'ensure_fresh', autoAnalyze: false }],
    ]) {
      const result = await call(name, args);
      const valid =
        result.kind === 'ok' &&
        result.payload.isStale === false &&
        result.payload.indexedCommit === head &&
        result.payload.headCommit === head &&
        result.payload.repoLabel === options.repoLabel &&
        result.payload.repoPath === repoPath;
      check(`${name}: freshness matches repository and HEAD`, valid);
      if (!valid) throw new Error('Freshness or target mismatch; facade calls stopped');
    }
    const relatedArgs = {
      symbol: options.symbol,
      read_mode: 'committed',
      includeCoChanged: false,
      includeCrossRepo: false,
      maxItemsPerCategory: 3,
    };
    const legacy = await call('gn_find_related', relatedArgs);
    const facade = await call('inspect', { action: 'related', ...relatedArgs });
    const relatedError = [legacy, facade].find((result) => result.kind === 'error');
    if (relatedError)
      checks.push({
        name: 'related committed read accepted',
        pass: false,
        error: String(relatedError.payload.error).slice(0, 200),
      });
    const left = legacy.payload?.resolvedSymbol,
      right = facade.payload?.resolvedSymbol;
    relatedAvailable =
      legacy.kind === 'ok' &&
      facade.kind === 'ok' &&
      hasCommittedProvenance(legacy, head) &&
      hasCommittedProvenance(facade, head) &&
      typeof left?.nodeId === 'string' &&
      left.nodeId.length > 0 &&
      left.nodeId === right?.nodeId &&
      typeof left.name === 'string' &&
      left.name.length > 0 &&
      left.name === right?.name &&
      ['callers', 'callees'].every(
        (category) =>
          Array.isArray(legacy.payload[category]) &&
          Array.isArray(facade.payload[category]) &&
          JSON.stringify(
            legacy.payload[category].map(({ nodeId, relationshipKind }) => [
              nodeId,
              relationshipKind,
            ]),
          ) ===
            JSON.stringify(
              facade.payload[category].map(({ nodeId, relationshipKind }) => [
                nodeId,
                relationshipKind,
              ]),
            ),
      );
    check('related alias agrees on symbol, provenance and relationships', relatedAvailable);
    const budgeted = await call('inspect', {
      action: 'related',
      ...relatedArgs,
      response_budget_bytes: 4096,
    });
    check(
      'positive logical budget keeps identity and provenance',
      ['ok', 'partial'].includes(budgeted.kind) &&
        budgeted.payload?.readContext?.mode === 'committed' &&
        budgeted.payload?.readContext?.indexedCommit === head &&
        budgeted.payload?.readContext?.workingTreeIncluded === false &&
        typeof right?.nodeId === 'string' &&
        right.nodeId.length > 0 &&
        budgeted.payload?.resolvedSymbol?.nodeId === right.nodeId,
    );
    const invalid = {
      symbol: options.symbol,
      intent: 'rename',
      params: { newName: '__facade_smoke_never_applied' },
      dryRun: true,
      confirm: false,
      response_budget_bytes: -1,
    };
    for (const [name, args] of [
      ['gn_safe_refactor', invalid],
      ['refactor', { action: 'safe_refactor', ...invalid }],
    ]) {
      const result = await call(name, args);
      check(
        `${name}: invalid budget rejected before refactor`,
        result.kind === 'error' &&
          /response_budget_bytes must be a positive safe integer\./.test(
            String(result.payload.error),
          ),
      );
    }
  } catch (error) {
    checks.push({ name: 'facade smoke execution', pass: false, error: String(error) });
  }
  return {
    mode: 'facade',
    advertisement,
    invalidBudgetSurfaces,
    contractPassed: checks.every((item) => item.pass),
    relatedAvailable,
    checks,
    callCount: calls.length,
    capturedResponseBytes: calls
      .filter((entry) => entry.response !== undefined)
      .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.response)), 0),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoPath = realpathSync(options.repo),
    cli = realpathSync(options.cli);
  mkdirSync(options.outputDir); // Refuse existing evidence directories, including symlinks.
  const save = (name, value) =>
    writeFileSync(path.join(options.outputDir, name), JSON.stringify(value, null, 2) + '\n');
  let client, stderr;
  let summary = {
    contractPassed: false,
    workspaceNavigationAvailable: false,
    error: 'Startup failed',
  };
  try {
    const git = (...args) =>
      execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 10000 });
    const head = git('rev-parse', 'HEAD').trim();
    const status = git('status', '--porcelain=v1', '-z').split('\0').filter(Boolean);
    const manifest = {
      version: 1,
      options,
      repoPath,
      head,
      dirtyEntries: status.filter((item) => /^[ MADRCU?!]{2} /.test(item)).length,
      untrackedEntries: status.filter((item) => item.startsWith('?? ')).length,
      cli,
      cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
      ...readPackageIdentity(cli),
      cliVersion: execFileSync(process.execPath, [cli, '--version'], {
        encoding: 'utf8',
        timeout: 10000,
      }).trim(),
      nodeVersion: process.version,
    };
    save('manifest.json', manifest);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--project', repoPath],
      env: { ...process.env },
      stderr: 'pipe',
    });
    stderr = createWriteStream(path.join(options.outputDir, 'stderr.log'));
    transport.stderr?.pipe(stderr);
    client = new Client({ name: 'committed-navigation-smoke', version: '1' });
    await client.connect(transport, { timeout: options.timeout });
    const serverManifest = recordServerIdentity(manifest, client);
    save('manifest.json', serverManifest);
    if (!serverManifest.serverIdentityMatches)
      throw new Error('MCP server identity must be ontoindex with the resolved package version');
    const runner = options.mode === 'facade' ? runFacadeSmoke : runSmoke;
    summary = await runner(options, {
      client,
      head,
      repoPath,
      record: (calls) => save('responses.json', calls),
    });
  } catch (error) {
    summary.error = String(error);
  } finally {
    try {
      await client?.close();
    } catch (error) {
      summary.contractPassed = false;
      summary.closeError = String(error);
    }
    stderr?.end();
    save('summary.json', summary);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.contractPassed ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
