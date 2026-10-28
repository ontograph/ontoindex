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

it('replays current workspace mutations through persistent stdio MCP and foreground CLI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-adw-replay-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const storage = path.join(repo, '.ontoindex');
  const repoName = 'automatic-dirty-workspace-replay';
  const evidence: unknown[] = [];
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
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    evidence.push({ args, stdout, stderr: childStderr, exit });
    expect(exit, childStderr + stdout).toBe(0);
    expect(childStderr).not.toMatch(nativeError);
    return parse(stdout);
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
    async function check(target: string, filePath: string, cliFirst = false) {
      const beforeSource = await Promise.all(
        (await fs.readdir(path.join(repo, 'src')))
          .sort()
          .map(async (name) => [name, await fs.readFile(path.join(repo, 'src', name), 'utf8')]),
      );
      const status = git('status', '--porcelain');
      // Most mutations must be prepared by the persistent MCP process itself.
      // The preserved-timestamp case starts with the watcher-free foreground read.
      const first = cliFirst ? await foreground(target) : await context(target);
      const before = await identity();
      const second = cliFirst ? await context(target) : await foreground(target);
      const [cliResult, mcpResult] = cliFirst ? [first, second] : [second, first];
      expect(mcpResult).toMatchObject({
        status: 'found',
        source: 'workspace-graph',
        symbol: { name: target, filePath },
      });
      expect(normalize(cliResult)).toEqual(normalize(mcpResult));
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
      const deniedRequest = {
        name: 'cypher',
        arguments: { repo: repoName, query: 'CREATE (n:Function {name: "deniedMutation"})' },
      };
      const deniedResponse = await client.callTool(deniedRequest);
      evidence.push({ request: deniedRequest, response: deniedResponse });
      expect(JSON.stringify(deniedResponse)).toContain('Write operations');
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
    const file = path.join(repo, 'src/callee.ts');
    const stat = await fs.stat(file);
    const bytes = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, bytes.replace('atomicSaved', 'missedEvent'));
    await fs.utimes(file, stat.atime, stat.mtime);
    expect((await fs.stat(file)).size).toBe(stat.size);
    await check('missedEvent', 'src/callee.ts', true);
    expect(await context('atomicSaved')).toMatchObject({
      error: expect.stringContaining('not found'),
    });
  } finally {
    const pid = transport?.pid;
    const closeStart = performance.now();
    try {
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
      if (scope) {
        await vi.waitFor(
          async () => {
            expect(await fs.readFile(path.join(scope!.path, 'cgroup.events'), 'utf8')).toMatch(
              /^populated 0$/m,
            );
          },
          { timeout: 5_000 },
        );
        scope.close();
      }
      if (transport) expect((await fs.readFile(exitFile, 'utf8')).trim()).toBe('0');
      const cleanupMs = performance.now() - closeStart;
      evidence.push({
        cleanupMs,
        cleanupScope: scope ? 'all-owned-descendants' : 'root-process',
        exit: transport ? await fs.readFile(exitFile, 'utf8') : null,
      });
      expect(cleanupMs).toBeLessThanOrEqual(5_000);
      if (
        await fs.stat(storage).then(
          () => true,
          () => false,
        )
      ) {
        await expect(
          fs.access(path.join(storage, 'workspace-build.owner.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(path.join(storage, 'watch.lease'))).rejects.toMatchObject({
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
      expect(stderr).not.toMatch(nativeError);
    } finally {
      if (scope) {
        try {
          scope.kill();
        } finally {
          scope.close();
        }
      }
      evidence.push({ stderr });
      const output = process.env.ONTOINDEX_ADW_REPLAY_EVIDENCE;
      if (output) {
        await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
        await fs.writeFile(output, JSON.stringify(evidence, null, 2));
      }
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
