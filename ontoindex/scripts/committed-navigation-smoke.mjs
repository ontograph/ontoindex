#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const options = {
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
  return options;
}

export function payloadOf(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('Missing MCP JSON payload');
  return JSON.parse(text.split(/\n(?:\n)?---(?:\n|$)/)[0]);
}

export function classifyResult(result) {
  const payload = payloadOf(result);
  if (
    payload.truncated === true ||
    payload.detailTruncated === true ||
    payload.response_cursor ||
    payload.nextCursor
  )
    return { kind: 'partial', payload };
  if (result.isError || payload.error)
    return { kind: payload.retryable === false ? 'refused' : 'error', payload };
  return { kind: 'ok', payload };
}

// One attempt per request; explicit committed reads are a separate requested mode.
export async function runSmoke(options, { client, head, repoPath, record = () => {} }) {
  const checks = [],
    calls = [],
    workspace = [];
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
    const context = result.payload.readContext;
    check(
      `${name}: committed provenance`,
      result.kind === 'ok' &&
        context?.mode === 'committed' &&
        context.indexedCommit === head &&
        context.workingTreeIncluded === false,
    );
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
      workspace.push({ name, classification: result.kind, code: result.payload.code });
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
      workspace.length === 4 && workspace.every((item) => item.classification === 'ok'),
    workspace,
    checks,
    callCount: calls.length,
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
    save('manifest.json', {
      version: 1,
      options,
      repoPath,
      head,
      dirtyEntries: status.filter((item) => /^[ MADRCU?!]{2} /.test(item)).length,
      untrackedEntries: status.filter((item) => item.startsWith('?? ')).length,
      cli,
      cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
      cliVersion: execFileSync(process.execPath, [cli, '--version'], {
        encoding: 'utf8',
        timeout: 10000,
      }).trim(),
      nodeVersion: process.version,
    });
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
    summary = await runSmoke(options, {
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
