import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug } from '../../src/core/lbug/lbug-adapter.js';
import { captureWorkspaceInputs } from '../../src/core/analyze-delta.js';
// @ts-expect-error plain .mjs script without declarations
import { createCpuScope } from '../../scripts/overlay-benchmark-automatic.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, '../..');
const require = createRequire(import.meta.url);
const tsxImportUrl = pathToFileURL(
  path.join(path.dirname(require.resolve('tsx/package.json')), 'dist/loader.mjs'),
).href;
const nativeError =
  /FATAL|uncaught|unhandled|segmentation|native.*error|Buffer manager exception|Unable to allocate|buffer pool is full|SIGSEGV|buffer.?pool.*(?:error|exception|fail)|(?:error|exception).*buffer.?pool/i;

interface Context {
  status: string;
  source?: string;
  symbol?: { uid: string; name: string; filePath: string };
  incoming?: { calls?: Array<{ uid: string; name: string; filePath: string }> };
  outgoing?: { calls?: Array<{ uid: string; name: string; filePath: string }> };
}

async function readFailureMarker(file: string) {
  try {
    const handle = await fs.open(file, 'r');
    let raw: string;
    try {
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) return { state: 'oversized' };
      raw = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'invalid' };
    const marker = parsed as Record<string, unknown>;
    const result: Record<string, string | number> = { state: 'present' };
    for (const key of ['pid', 'parentPid', 'childPid']) {
      const value = marker[key];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647)
        result[key] = value;
    }
    for (const key of ['startedAt', 'processStartIdentity']) {
      if (typeof marker[key] === 'string') result[key] = marker[key].slice(0, 128);
    }
    if (typeof marker.heartbeat === 'number' && Number.isFinite(marker.heartbeat))
      result.heartbeat = marker.heartbeat;
    if (marker.state === 'quarantined') result.state = marker.state;
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) return { state: 'invalid' };
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return { state: code === 'ENOENT' ? 'absent' : 'unreadable', code };
  }
}

it('bounds lock diagnostics and excludes tokens and artifact snapshots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-adw-diagnostics-'));
  const marker = path.join(root, 'marker');
  try {
    expect(await readFailureMarker(marker)).toMatchObject({ state: 'absent' });
    await fs.writeFile(
      marker,
      JSON.stringify({ pid: 42, token: 'secret', before: ['private'], heartbeat: 7 }),
    );
    expect(await readFailureMarker(marker)).toEqual({ state: 'present', pid: 42, heartbeat: 7 });
    await fs.writeFile(
      marker,
      JSON.stringify({
        pid: -1,
        childPid: 0,
        parentPid: 1.5,
        startedAt: 'x'.repeat(200),
        processStartIdentity: 'y'.repeat(200),
      }),
    );
    expect(await readFailureMarker(marker)).toEqual({
      state: 'present',
      startedAt: 'x'.repeat(128),
      processStartIdentity: 'y'.repeat(128),
    });
    await fs.writeFile(marker, '{');
    expect(await readFailureMarker(marker)).toEqual({ state: 'invalid' });
    await fs.writeFile(marker, ' '.repeat(4097));
    expect(await readFailureMarker(marker)).toEqual({ state: 'oversized' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('replays current workspace mutations through persistent stdio MCP and foreground CLI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-adw-replay-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const storage = path.join(repo, '.ontoindex');
  const repoName = 'automatic-dirty-workspace-replay';
  const evidence: unknown[] = [];
  async function writeEvidence() {
    const output = process.env.ONTOINDEX_ADW_REPLAY_EVIDENCE;
    if (output) {
      await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
      await fs.writeFile(output, JSON.stringify(evidence, null, 2));
    }
  }
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', repo, ...args],
      { encoding: 'utf8' },
    );
  const cli = process.env.ONTOINDEX_ADW_REPLAY_CLI
    ? [path.resolve(process.env.ONTOINDEX_ADW_REPLAY_CLI)]
    : [
        '--max-old-space-size=8192',
        '--import',
        tsxImportUrl,
        path.join(packageRoot, 'src/cli/index.ts'),
      ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ONTOINDEX_HOME: home,
    ONTOINDEX_VECTOR_BACKEND: 'lbug',
    ONTOINDEX_MCP_AUTO_ANALYZE: '0',
  };
  if (process.env.ONTOINDEX_ADW_REPLAY_DEFAULT === '1') delete env.ONTOINDEX_AUTO_WORKSPACE;
  else env.ONTOINDEX_AUTO_WORKSPACE = '1';
  const client = new Client({ name: repoName, version: '1' });
  let transport: StdioClientTransport | undefined;
  let scope: ReturnType<typeof createCpuScope> | undefined;
  const exitFile = path.join(root, 'mcp-exit.txt');
  let stderr = '';
  const write = (file: string, bytes: string) => fs.writeFile(path.join(repo, file), bytes);
  const parse = (text: string): Context => {
    const result = text.split('\n\n---\n')[0];
    const start = result.search(/^\{/m);
    if (start < 0) throw new Error(`Missing JSON result: ${result}`);
    return JSON.parse(result.slice(start));
  };
  async function context(target: string) {
    const request = {
      name: 'inspect',
      arguments: { action: 'context', repo: repoName, target, include_content: true },
    };
    const response = await client.callTool(request, undefined, { timeout: 240_000 });
    evidence.push({ request, response });
    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');
    expect(response.isError, text).not.toBe(true);
    return parse(text);
  }
  async function foreground(target: string) {
    const args = [...cli, 'context', target, '--repo', repoName, '--content'];
    const launch = scope?.wrap(process.execPath, args) ?? { command: process.execPath, args };
    const child = spawn(launch.command, launch.args, {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
    });
    let stdout = '';
    let childStderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      childStderr += String(chunk);
    });
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      evidence.push({ args, stdout, stderr: childStderr, exit });
      expect(exit, childStderr + stdout).toBe(0);
      expect(childStderr).not.toMatch(nativeError);
      return parse(stdout);
    } catch (error) {
      // Capture before shutdown removes the synthetic fixture's ownership markers.
      try {
        const [analyzeLock, recoveryLock, workspaceBuild, watchLease] = await Promise.all([
          readFailureMarker(path.join(storage, 'analyze.lock')),
          readFailureMarker(path.join(storage, 'analyze.lock.recovery')),
          readFailureMarker(path.join(storage, 'workspace-build.owner.json')),
          readFailureMarker(path.join(storage, 'watch.lease')),
        ]);
        evidence.push({
          event: 'foreground-failure',
          target,
          capturedAt: new Date().toISOString(),
          testPid: process.pid,
          foregroundPid: child.pid,
          mcpPid: transport?.pid,
          analyzeLock,
          recoveryLock,
          workspaceBuild,
          watchLease,
        });
        await writeEvidence();
      } catch (diagnosticError) {
        evidence.push({
          event: 'foreground-diagnostic-failed',
          code: (diagnosticError as NodeJS.ErrnoException).code ?? 'unknown',
        });
      }
      throw error;
    }
  }
  async function identity() {
    const generation = (await fs.readFile(path.join(storage, 'overlay/CURRENT'), 'utf8')).trim();
    const base = JSON.parse(
      await fs.readFile(path.join(storage, 'overlay', generation, 'base.json'), 'utf8'),
    );
    return { generation, head: base.head, manifestDigest: base.manifestDigest };
  }
  const normalize = (value: Context) => ({
    status: value.status,
    symbol: value.symbol,
    incoming: (value.incoming?.calls ?? []).map(({ uid }) => uid).sort(),
    outgoing: (value.outgoing?.calls ?? []).map(({ uid }) => uid).sort(),
  });
  async function assertReleased() {
    if (
      await fs.stat(storage).then(
        () => true,
        () => false,
      )
    ) {
      for (const marker of [
        'analyze.lock',
        'analyze.lock.recovery',
        'workspace-build.owner.json',
        'watch.lease',
      ])
        await expect(fs.access(path.join(storage, marker))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect(
        await fs
          .readdir(path.join(storage, 'workspace-inputs'))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          }),
      ).toEqual([]);
    }
  }
  let mcpShutdown: Promise<void> | undefined;
  function stopMcp() {
    return (mcpShutdown ??= (async () => {
      const pid = transport?.pid;
      const closeStart = performance.now();
      try {
        await client.close();
      } finally {
        await transport?.close();
      }
      if (pid)
        await vi.waitFor(
          () => {
            expect(() => process.kill(pid, 0)).toThrow();
          },
          { timeout: 10_000 },
        );
      if (scope)
        await vi.waitFor(
          async () => {
            expect(await fs.readFile(path.join(scope!.path, 'cgroup.events'), 'utf8')).toMatch(
              /^populated 0$/m,
            );
          },
          { timeout: 5_000 },
        );
      if (transport) expect((await fs.readFile(exitFile, 'utf8')).trim()).toBe('0');
      const cleanupMs = performance.now() - closeStart;
      evidence.push({
        cleanupMs,
        cleanupScope: scope ? 'all-owned-descendants' : 'root-process',
        exit: transport ? await fs.readFile(exitFile, 'utf8') : null,
      });
      expect(cleanupMs).toBeLessThanOrEqual(5_000);
      await assertReleased();
      expect(stderr).not.toMatch(nativeError);
    })());
  }
  try {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    await write('.gitignore', '.ontoindex/\n');
    await write('src/callee.ts', 'export function callee() { return 1; }\n');
    await write(
      'src/caller.ts',
      "import { callee } from './callee';\nexport function caller() { return callee(); }\n",
    );
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    await runFullAnalysis(
      repo,
      {
        skipNativeClose: true,
        skipAgentsMd: true,
        noStats: true,
        registryName: repoName,
        embeddings: false,
      },
      { onProgress() {} },
    );
    await closeLbug();
    const registry = await fs.readFile(path.join(home, 'registry.json'));
    const meta = await fs.readFile(path.join(storage, 'meta.json'));
    const baseBytes = createHash('sha256')
      .update(await fs.readFile(path.join(storage, 'lbug')))
      .digest('hex');
    const head = git('rev-parse', 'HEAD').trim();
    if (process.env.ONTOINDEX_TEST_CGROUP_ROOT)
      scope = createCpuScope(process.env.ONTOINDEX_TEST_CGROUP_ROOT);
    const timed = {
      command: '/usr/bin/time',
      args: ['-f', '%x', '-o', exitFile, process.execPath, ...cli, 'mcp'],
    };
    const launch = scope?.wrap(timed.command, timed.args) ?? timed;
    transport = new StdioClientTransport({
      ...launch,
      cwd: repo,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await client.connect(transport);
    expect(await context('callee')).toMatchObject({
      status: 'found',
      incoming: { calls: expect.arrayContaining([expect.objectContaining({ name: 'caller' })]) },
    });
    await expect(fs.access(path.join(storage, 'overlay/CURRENT'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    let previous: string | undefined;
    async function check(target: string, filePath: string, foregroundOnly = false) {
      const beforeSource = await Promise.all(
        (await fs.readdir(path.join(repo, 'src')))
          .sort()
          .map(async (name) => [name, await fs.readFile(path.join(repo, 'src', name), 'utf8')]),
      );
      const status = git('status', '--porcelain');
      const first = foregroundOnly ? await foreground(target) : await context(target);
      const before = await identity();
      expect(first).toMatchObject({
        status: 'found',
        source: 'workspace-graph',
        symbol: { name: target, filePath },
      });
      if (!foregroundOnly) expect(normalize(await foreground(target))).toEqual(normalize(first));
      expect(await identity()).toEqual(before);
      expect(before.generation).not.toBe(previous);
      previous = before.generation;
      expect(before.head).toBe(head);
      expect(before.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(await fs.readFile(path.join(home, 'registry.json'))).toEqual(registry);
      expect(await fs.readFile(path.join(storage, 'meta.json'))).toEqual(meta);
      expect(
        createHash('sha256')
          .update(await fs.readFile(path.join(storage, 'lbug')))
          .digest('hex'),
      ).toBe(baseBytes);
      expect(git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(git('status', '--porcelain')).toBe(status);
      expect(
        await Promise.all(
          (await fs.readdir(path.join(repo, 'src')))
            .sort()
            .map(async (name) => [name, await fs.readFile(path.join(repo, 'src', name), 'utf8')]),
        ),
      ).toEqual(beforeSource);
      if (!foregroundOnly) {
        const deniedRequest = {
          name: 'cypher',
          arguments: { repo: repoName, query: 'CREATE (n:Function {name: "deniedMutation"})' },
        };
        const deniedResponse = await client.callTool(deniedRequest);
        evidence.push({ request: deniedRequest, response: deniedResponse });
        expect(JSON.stringify(deniedResponse)).toContain(
          'Read-only Cypher rejected: forbidden keyword CREATE',
        );
      }
      expect(await identity()).toEqual(before);
      expect(await fs.readFile(path.join(home, 'registry.json'))).toEqual(registry);
      expect(await fs.readFile(path.join(storage, 'meta.json'))).toEqual(meta);
      expect(
        createHash('sha256')
          .update(await fs.readFile(path.join(storage, 'lbug')))
          .digest('hex'),
      ).toBe(baseBytes);
      expect(git('status', '--porcelain')).toBe(status);
      expect(
        await Promise.all(
          (await fs.readdir(path.join(repo, 'src')))
            .sort()
            .map(async (name) => [name, await fs.readFile(path.join(repo, 'src', name), 'utf8')]),
        ),
      ).toEqual(beforeSource);
      evidence.push({ target, identity: before });
    }
    await fs.appendFile(
      path.join(repo, 'src/callee.ts'),
      'export function appended() { return 2; }\n',
    );
    await check('appended', 'src/callee.ts');
    await write(
      'src/added.ts',
      "import { callee } from './callee';\nexport function addedCaller() { return callee(); }\n",
    );
    await check('addedCaller', 'src/added.ts');
    await fs.rename(path.join(repo, 'src/added.ts'), path.join(repo, 'src/renamed.ts'));
    await check('addedCaller', 'src/renamed.ts');
    await fs.unlink(path.join(repo, 'src/renamed.ts'));
    await check('callee', 'src/callee.ts');
    expect(await context('addedCaller')).toMatchObject({
      error: expect.stringContaining('not found'),
    });
    await write('src/save.tmp', 'export function atomicSaved() { return 3; }\n');
    await fs.rename(path.join(repo, 'src/save.tmp'), path.join(repo, 'src/callee.ts'));
    await check('atomicSaved', 'src/callee.ts');
    // Stop the persistent watcher before the mutation so only the foreground can prepare it.
    await stopMcp();
    const file = path.join(repo, 'src/callee.ts');
    const stat = await fs.stat(file);
    const bytes = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, bytes.replace('atomicSaved', 'missedEvent'));
    await fs.utimes(file, stat.atime, stat.mtime);
    expect((await fs.stat(file)).size).toBe(stat.size);
    expect((await fs.stat(file)).mtime.getTime()).toBe(stat.mtime.getTime());
    await check('missedEvent', 'src/callee.ts', true);
    const missedIdentity = await identity();
    expect(await foreground('atomicSaved')).toMatchObject({
      error: expect.stringContaining('not found'),
    });
    expect(await identity()).toEqual(missedIdentity);
  } finally {
    try {
      await stopMcp();
      await assertReleased();
    } finally {
      if (scope) {
        try {
          scope.kill();
        } finally {
          scope.close();
        }
      }
      evidence.push({ stderr });
      await writeEvidence();
      await closeLbug();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 1_200_000);

it('captures 0/1/50/51 changes and bounds two writers racing source, configuration and HEAD', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-adw-barrier-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-C',
        root,
        ...args,
      ],
      { encoding: 'utf8' },
    );
  const source = (n: number, version: number) => `export const value${n} = ${version};\n`;
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
    for (let i = 0; i < 51; i++) await fs.writeFile(path.join(root, `src/f${i}.ts`), source(i, 0));
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    let previousDigest: string | undefined;
    for (const count of [0, 1, 50, 51]) {
      for (let i = 0; i < count; i++)
        await fs.writeFile(path.join(root, `src/f${i}.ts`), source(i, 1));
      expect(git('status', '--porcelain').trim().split('\n').filter(Boolean)).toHaveLength(count);
      const captured = await captureWorkspaceInputs(root, { parserIdentity: 'barrier-fixture-v1' });
      try {
        expect(
          captured.manifest.workspaceCapture?.entries.filter((entry) => entry.path.endsWith('.ts')),
        ).toHaveLength(51);
        expect(captured.manifestDigest).not.toBe(previousDigest);
        previousDigest = captured.manifestDigest;
        for (let i = 0; i < 51; i++) {
          expect(await fs.readFile(path.join(captured.captureRoot, `src/f${i}.ts`), 'utf8')).toBe(
            source(i, i < count ? 1 : 0),
          );
        }
      } finally {
        await captured.dispose();
      }
    }
    let reached!: () => void;
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let attempts = 0;
    const pending = captureWorkspaceInputs(root, {
      parserIdentity: 'barrier-fixture-v1',
      hooks: {
        afterCopy: async ({ attempt }) => {
          attempts++;
          if (attempt === 1) {
            reached();
            await release;
          }
        },
      },
    });
    try {
      await barrier;
      await Promise.all([
        fs.writeFile(path.join(root, 'src/f0.ts'), source(0, 2)),
        fs.writeFile(path.join(root, 'src/f50.ts'), source(50, 2)),
      ]);
      await fs.writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
      git('add', '.');
      git('commit', '-qm', 'concurrent writers');
    } finally {
      resume();
    }
    const captured = await pending;
    try {
      expect(attempts).toBe(2);
      expect(captured.head).toBe(git('rev-parse', 'HEAD').trim());
      expect(await fs.readFile(path.join(captured.captureRoot, 'src/f0.ts'), 'utf8')).toBe(
        source(0, 2),
      );
      expect(await fs.readFile(path.join(captured.captureRoot, 'src/f50.ts'), 'utf8')).toBe(
        source(50, 2),
      );
      expect(await fs.readFile(path.join(captured.captureRoot, 'tsconfig.json'), 'utf8')).toContain(
        'strict',
      );
    } finally {
      await captured.dispose();
    }
    attempts = 0;
    await expect(
      captureWorkspaceInputs(root, {
        parserIdentity: 'barrier-fixture-v1',
        hooks: {
          afterCopy: async ({ attempt }) => {
            attempts++;
            await Promise.all([
              fs.writeFile(path.join(root, 'src/f0.ts'), source(0, attempt + 2)),
              fs.writeFile(path.join(root, 'src/f50.ts'), source(50, attempt + 2)),
            ]);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'changed-input' });
    expect(attempts).toBe(2);
    expect(await fs.readdir(path.join(root, '.ontoindex/workspace-inputs'))).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
