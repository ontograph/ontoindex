import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contextFingerprint,
  createCpuScope,
  diffFingerprints,
  isRetryableBusyResponse,
  parseAutomaticArgs,
  runSample,
  selfCheck,
  // @ts-expect-error plain .mjs script without declarations
} from '../../scripts/overlay-benchmark-automatic.mjs';
// @ts-expect-error plain .mjs script without declarations
import { evaluateBudgets, summarize } from '../../scripts/overlay-benchmark-stats.mjs';

describe('automatic overlay benchmark', () => {
  it('joins the CPU scope before main and preserves literal arguments and environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'ontoindex-preload-'));
    const procs = join(root, 'cgroup.procs');
    writeFileSync(procs, '');
    const preload = new URL('../../scripts/overlay-cpu-scope-preload.mjs', import.meta.url);
    preload.searchParams.set('cgroup', root);
    const literal = 'space ; $(never-run) "quoted"';
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          preload.href,
          '-e',
          'const fs=require("node:fs");console.log(JSON.stringify({pid:String(process.pid),joined:fs.readFileSync(process.argv[1],"utf8"),arg:process.argv[2],env:process.env.ONTOINDEX_PRELOAD_FIXTURE}))',
          procs,
          literal,
        ],
        { encoding: 'utf8', env: { ...process.env, ONTOINDEX_PRELOAD_FIXTURE: 'retained' } },
      );
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result).toEqual({
        pid: result.pid,
        joined: result.pid,
        arg: literal,
        env: 'retained',
      });
      preload.searchParams.set('cgroup', join(root, 'missing'));
      const failed = spawnSync(
        process.execPath,
        ['--import', preload.href, '-e', 'console.log("main ran")'],
        { encoding: 'utf8' },
      );
      expect(failed.status).not.toBe(0);
      expect(failed.stdout).toBe('');
      expect(failed.stderr).toContain('ENOENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([false, true])('retries structured workspace contention with isError=%s', (isError) => {
    expect(
      isRetryableBusyResponse({
        isError,
        content: [
          {
            text: JSON.stringify({
              error: 'workspace_preparation_failed: workspace_busy',
              code: 'workspace_busy',
              retryable: true,
            }),
          },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    '{"code":"workspace_busy","retryable":false}',
    '{"code":"other","retryable":true,"error":"already running"}',
    '{"code":"workspace_busy","retryable":"true"}',
    '{"code":"workspace_busy"}',
    '{"code":"workspace_busy","retryable":true',
    '{"error":"already running",',
    'null',
  ])('does not retry terminal or malformed structured responses: %s', (text) => {
    expect(isRetryableBusyResponse({ isError: true, content: [{ text }] })).toBe(false);
  });

  it.each([false, true])('preserves legacy contention handling with isError=%s', (isError) => {
    expect(
      isRetryableBusyResponse({
        isError,
        content: [{ text: 'An analyze is already running' }],
      }),
    ).toBe(isError);
  });

  it('rejects every missing or failed measurement kind in its self-check', () => {
    const result = selfCheck();
    expect(result.pass).toBe(true);
    expect(Object.keys(result.rejected).sort()).toEqual([
      'missingMetric',
      'nativeError',
      'nonZeroExit',
      'truncatedStderr',
      'unreapedChild',
    ]);
  });

  it('defaults to the ADR matrix and requires an output path', () => {
    expect(() => parseAutomaticArgs(['--automatic'])).toThrow('--output is required');
    const opts = parseAutomaticArgs(['--automatic', '--output', '/tmp/x.json']);
    expect(opts.sizes).toEqual([0, 1, 50, 51]);
    expect(opts.repetitions).toBe(20);
    expect(opts.pilot).toBe(false);
    expect(opts.cpuCgroupRoot).toBeNull();
  });

  it.each(['1', '20', '9007199254740991'])('accepts safe decimal repetitions %s', (value) => {
    const opts = parseAutomaticArgs([
      '--automatic',
      '--output',
      '/tmp/x.json',
      '--repetitions',
      value,
    ]);
    expect(opts.repetitions).toBe(Number(value));
  });

  it.each(['0', '-1', '1.5', '1e2', '01', 'Infinity', '9007199254740992', '9'.repeat(400)])(
    'rejects malformed or unsafe repetitions %s',
    (value) => {
      expect(() =>
        parseAutomaticArgs(['--automatic', '--output', '/tmp/x.json', '--repetitions', value]),
      ).toThrow();
    },
  );

  it('accepts an explicit CPU cgroup root and rejects a missing value', () => {
    const base = ['--automatic', '--output', '/tmp/x.json'];
    expect(
      parseAutomaticArgs([...base, '--cpu-cgroup-root', '/sys/fs/cgroup/delegated']).cpuCgroupRoot,
    ).toBe('/sys/fs/cgroup/delegated');
    expect(() => parseAutomaticArgs([...base, '--cpu-cgroup-root'])).toThrow();
  });

  it('rejects roots outside the cgroup v2 filesystem', () => {
    expect(() => createCpuScope('/tmp')).toThrow();
    expect(() => createCpuScope('/sys/fs/cgroup/ontoindex-does-not-exist')).toThrow();
  });

  it.each([
    [false, '1'],
    [true, '0'],
  ] as const)(
    'launches the benchmark with explicit activation when flagOff=%s',
    async (flagOff, expected) => {
      const temp = mkdtempSync(join(tmpdir(), 'ontoindex-activation-sample-'));
      const stopped = new Error('fixture stops before launching a child');
      let launchOptions: any;
      class Transport {
        constructor(options: any) {
          launchOptions = options;
          throw stopped;
        }
      }
      try {
        await expect(
          runSample(
            {
              sdk: { Client: class {}, StdioClientTransport: Transport },
              temp,
              clone: temp,
              cli: join(temp, 'server.mjs'),
              env: { ONTOINDEX_AUTO_WORKSPACE: '1' },
              maxFiles: 1,
              repoName: 'fixture',
            },
            {
              size: 0,
              phase: 'cold',
              symbol: 'fixture',
              rawDir: temp,
              label: 'activation',
              flagOff,
            },
          ),
        ).rejects.toBe(stopped);
        expect(launchOptions.env.ONTOINDEX_AUTO_WORKSPACE).toBe(expected);
      } finally {
        rmSync(temp, { recursive: true });
      }
    },
  );

  it.skipIf(!process.env.ONTOINDEX_TEST_CGROUP_ROOT)(
    'bounds runSample CPU to the warm request and cleans up after a primary failure',
    async () => {
      const temp = mkdtempSync(join(tmpdir(), 'ontoindex-cgroup-sample-'));
      const cli = join(temp, 'server.cjs');
      writeFileSync(
        cli,
        `
        const readline = require('node:readline');
        const burn = usec => {
          const start = process.cpuUsage();
          for (;;) {
            const cpu = process.cpuUsage(start);
            if (cpu.user + cpu.system >= usec) break;
          }
        };
        burn(320000);
        const input = readline.createInterface({ input: process.stdin });
        input.on('line', line => {
          if (line === 'quit') { burn(160000); process.exit(0); }
          burn(line === 'warm' ? 320000 : 160000);
          console.log('done');
        });
        console.log('ready');
      `,
      );
      const primary = new Error('measured request failed');
      const closeFailure = new Error('transport close failed');
      let fail = false;
      let rejectClose = false;
      let hangClose = false;
      let transport: any;
      class Transport {
        options: any;
        child: any;
        lines: any;
        pid: number | undefined;
        onclose = () => {};
        completion: Promise<void> | undefined;
        stderrText = '';
        inputError: Error | undefined;
        constructor(options: any) {
          this.options = options;
        }
        async start() {
          this.child = spawn(this.options.command, this.options.args, {
            cwd: this.options.cwd,
            env: this.options.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          this.pid = this.child.pid;
          this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            this.stderrText += chunk;
          });
          this.child.stdin.on('error', (error: Error) => {
            this.inputError = error;
          });
          this.completion = new Promise((resolve, reject) => {
            this.child.once('error', reject);
            this.child.once('close', () => {
              this.onclose();
              resolve();
            });
          });
          this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
          const ready = await this.lines.next();
          if (ready.done) {
            await this.completion;
            throw new Error(`Fixture startup exited ${this.child.exitCode}: ${this.stderrText}`);
          }
          expect(ready.value, this.stderrText).toBe('ready');
        }
        async request(command: string) {
          await new Promise<void>((resolve, reject) => {
            this.child.stdin.write(`${command}\n`, (error?: Error | null) =>
              error ? reject(error) : resolve(),
            );
          });
          expect((await this.lines.next()).value, this.stderrText).toBe('done');
        }
        async close() {
          if (hangClose) await new Promise<void>(() => {});
          if (rejectClose) throw closeFailure;
          if (
            this.child.exitCode === null &&
            this.child.signalCode === null &&
            !this.child.stdin.destroyed
          ) {
            this.child.stdin.end('quit\n');
          }
          await this.completion;
          if (this.inputError) throw this.inputError;
          expect(this.child.exitCode, this.stderrText).toBe(0);
        }
      }
      class Client {
        calls = 0;
        async connect(value: any) {
          transport = value;
          await value.start();
        }
        async callTool() {
          await transport.request(this.calls++ === 0 ? 'warm' : 'measure');
          if (fail && this.calls === 2) throw primary;
          return { content: [{ text: '{"status":"found"}' }] };
        }
        async close() {
          await transport.close();
        }
      }
      const root = process.env.ONTOINDEX_TEST_CGROUP_ROOT!;
      const ownedBefore = readdirSync(root)
        .filter((name) => name.startsWith('ontoindex-cpu-'))
        .sort();
      const ctx = {
        sdk: { Client, StdioClientTransport: Transport },
        temp,
        clone: temp,
        cli,
        env: process.env,
        maxFiles: 1,
        repoName: 'fixture',
        cpuCgroupRoot: root,
      };
      const options = { size: 0, phase: 'warm', symbol: 'fixture', rawDir: temp, label: 'warm' };
      try {
        const result = await runSample(ctx, options);
        expect(result.meta.cpuSource).toBe('terminal-interval');
        const interval = JSON.parse(readFileSync(join(temp, 'warm.cpu-interval.json'), 'utf8'));
        const total = (cpu: any) => cpu.userUsec + cpu.systemUsec;
        expect(total(interval.before)).toBeGreaterThanOrEqual(640000);
        expect(total(interval.after) - total(interval.before)).toBeGreaterThanOrEqual(144000);
        expect(total(interval.after) - total(interval.before)).toBeLessThan(320000);
        expect(total(interval.final) - total(interval.after)).toBeGreaterThanOrEqual(144000);
        expect(result.sample.cpuSeconds).toBeCloseTo(
          (total(interval.final) - total(interval.before)) / 1e6,
          6,
        );
        expect(result.sample.cpuSeconds).toBeLessThan(total(interval.before) / 1e6);
        fail = true;
        await expect(runSample(ctx, { ...options, label: 'failure' })).rejects.toBe(primary);
        rejectClose = true;
        await expect(runSample(ctx, { ...options, label: 'close-failure' })).rejects.toBe(primary);
        expect((primary as any).cleanupError).toBe(closeFailure);
        await transport.completion;
        expect(transport.child.exitCode !== null || transport.child.signalCode !== null).toBe(true);
        expect(
          readdirSync(root)
            .filter((name) => name.startsWith('ontoindex-cpu-'))
            .sort(),
        ).toEqual(ownedBefore);
        rejectClose = false;
        hangClose = true;
        const started = performance.now();
        await expect(runSample(ctx, { ...options, label: 'close-timeout' })).rejects.toBe(primary);
        expect(performance.now() - started).toBeLessThan(12_000);
        expect((primary as any).cleanupError).toBeInstanceOf(Error);
        expect((primary as any).cleanupError.message).toBe('Benchmark client close timed out');
        await transport.completion;
        expect(transport.child.exitCode !== null || transport.child.signalCode !== null).toBe(true);
        expect(
          readdirSync(root)
            .filter((name) => name.startsWith('ontoindex-cpu-'))
            .sort(),
        ).toEqual(ownedBefore);
      } finally {
        rmSync(temp, { recursive: true });
      }
    },
    30000,
  );

  it.skipIf(!process.env.ONTOINDEX_TEST_CGROUP_ROOT)(
    'measures the actual SDK warm request separately from startup, preparation and EOF teardown',
    async () => {
      const require = createRequire(import.meta.url);
      const moduleUrl = (name: string) =>
        pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${name}.js`)).href;
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
      ]);
      const temp = mkdtempSync(join(tmpdir(), 'ontoindex-sdk-cgroup-'));
      const cli = join(temp, 'server.mjs');
      const root = process.env.ONTOINDEX_TEST_CGROUP_ROOT!;
      const ownedBefore = readdirSync(root)
        .filter((name) => name.startsWith('ontoindex-cpu-'))
        .sort();
      writeFileSync(
        cli,
        `
        import { Server } from ${JSON.stringify(moduleUrl('server/index'))};
        import { StdioServerTransport } from ${JSON.stringify(moduleUrl('server/stdio'))};
        import { CallToolRequestSchema } from ${JSON.stringify(moduleUrl('types'))};
        const burn = usec => {
          const start = process.cpuUsage();
          for (;;) {
            const cpu = process.cpuUsage(start);
            if (cpu.user + cpu.system >= usec) break;
          }
        };
        burn(320000);
        let calls = 0;
        const server = new Server({ name: 'cpu-fixture', version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler(CallToolRequestSchema, async () => {
          burn(calls++ === 0 ? 320000 : 160000);
          return { content: [{ type: 'text', text: '{"status":"found"}' }] };
        });
        process.stdin.once('end', () => { burn(160000); process.exit(0); });
        await server.connect(new StdioServerTransport());
      `,
      );
      try {
        const result = await runSample(
          {
            sdk: { Client, StdioClientTransport },
            temp,
            clone: temp,
            cli,
            env: process.env,
            maxFiles: 1,
            repoName: 'fixture',
            cpuCgroupRoot: root,
          },
          { size: 0, phase: 'warm', symbol: 'fixture', rawDir: temp, label: 'sdk-warm' },
        );
        const interval = JSON.parse(readFileSync(join(temp, 'sdk-warm.cpu-interval.json'), 'utf8'));
        const total = (cpu: any) => cpu.userUsec + cpu.systemUsec;
        const measured = total(interval.after) - total(interval.before);
        const teardown = total(interval.final) - total(interval.after);
        expect(total(interval.before)).toBeGreaterThanOrEqual(640000);
        expect(measured).toBeGreaterThanOrEqual(144000);
        expect(measured).toBeLessThan(320000);
        expect(teardown).toBeGreaterThanOrEqual(144000);
        expect(result.sample.cpuSeconds).toBeCloseTo(
          (total(interval.final) - total(interval.before)) / 1e6,
          6,
        );
        expect(result.sample.cpuSeconds).toBeLessThan(total(interval.before) / 1e6);
        expect(interval.teardown.cpuSeconds).toBeCloseTo(teardown / 1e6, 6);
        expect(result.sample.exit).toEqual({ code: 0, signal: null });
        expect(result.sample.childrenReaped).toBe(true);
        expect(result.meta.evidenceOk).toBe(true);
        expect(result.meta.cpuSource).toBe('terminal-interval');
        const budgets = evaluateBudgets({
          phase: 'warm',
          workload: 'clean',
          summary: summarize([result.sample]),
          artifactBytes: 0,
          cpuSources: [result.meta.cpuSource],
          cpuEvidence: [{ ...result.meta.cpuInterval, cpuSeconds: result.sample.cpuSeconds }],
        });
        expect(budgets.failures.map((failure: { budget: string }) => failure.budget)).not.toContain(
          'warmCpuAccounting',
        );
        expect(
          readdirSync(root)
            .filter((name) => name.startsWith('ontoindex-cpu-'))
            .sort(),
        ).toEqual(ownedBefore);
      } finally {
        rmSync(temp, { recursive: true });
      }
    },
    20000,
  );

  it.skipIf(!process.env.ONTOINDEX_TEST_CGROUP_ROOT)(
    'kills detached descendants only in its owned leaf before removing the empty scope',
    async () => {
      const scope = createCpuScope(process.env.ONTOINDEX_TEST_CGROUP_ROOT!);
      const script = `
        const { spawn } = require('node:child_process');
        const { readFileSync } = require('node:fs');
        const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true, stdio: 'ignore'
        });
        descendant.once('spawn', () => {
          console.log(JSON.stringify({ pid: descendant.pid,
            cgroup: readFileSync('/proc/' + descendant.pid + '/cgroup', 'utf8') }));
        });
        setInterval(() => {}, 1000);
      `;
      const wrapped = scope.wrap(process.execPath, ['-e', script]);
      const child = spawn(wrapped.command, wrapped.args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const outside = spawn(
        process.execPath,
        ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const completion = (process: typeof child) =>
        new Promise<number | null>((resolve, reject) => {
          process.once('error', reject);
          process.once('close', resolve);
        });
      const exited = completion(child);
      const outsideExited = completion(outside);
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      const outsideLines = createInterface({ input: outside.stdout! })[Symbol.asyncIterator]();
      try {
        expect((await outsideLines.next()).value).toBe('ready');
        const ready = await lines.next();
        expect(ready.done).toBe(false);
        const descendant = JSON.parse(ready.value!);
        const membership = `/${relative('/sys/fs/cgroup', realpathSync(scope.path))}`;
        expect(descendant.cgroup.trim().split('\n')).toContain(`0::${membership}`);
        expect(readFileSync(join(scope.path, 'cgroup.procs'), 'utf8').trim().split('\n')).toContain(
          String(descendant.pid),
        );
        expect(() => scope.close()).toThrow();
        scope.kill();
        await exited;
        const deadline = Date.now() + 5000;
        while (!/^populated 0$/m.test(readFileSync(join(scope.path, 'cgroup.events'), 'utf8'))) {
          if (Date.now() >= deadline)
            throw new Error('Owned descendants did not exit after cgroup.kill');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(outside.exitCode).toBeNull();
        expect(outside.signalCode).toBeNull();
        process.kill(outside.pid!, 0);
        scope.close();
        expect(existsSync(scope.path)).toBe(false);
      } finally {
        if (existsSync(scope.path)) scope.kill();
        await exited;
        outside.kill();
        await outsideExited;
        await lines.return?.();
        await outsideLines.return?.();
        if (existsSync(scope.path)) {
          const deadline = Date.now() + 5000;
          while (!/^populated 0$/m.test(readFileSync(join(scope.path, 'cgroup.events'), 'utf8'))) {
            if (Date.now() >= deadline)
              throw new Error('Owned leaf remained populated during test cleanup');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          scope.close();
        }
      }
    },
    20000,
  );

  it.skipIf(!process.env.ONTOINDEX_TEST_CGROUP_ROOT)(
    'accounts for a reaped descendant while excluding work outside its owned cgroup',
    async () => {
      const scope = createCpuScope(process.env.ONTOINDEX_TEST_CGROUP_ROOT!);
      const burn = `
        const start = process.cpuUsage();
        while (true) {
          const used = process.cpuUsage(start);
          if (used.user + used.system >= 160000) {
            process.stdout.write(JSON.stringify(used));
            break;
          }
        }
      `;
      const script = `
        const { readFileSync } = require('node:fs');
        const { spawnSync } = require('node:child_process');
        const readline = require('node:readline');
        const input = readline.createInterface({ input: process.stdin });
        input.on('line', command => {
          if (command === 'run') {
            const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(burn)}], { encoding: 'utf8' });
            if (result.error || result.status !== 0) {
              console.error(result.error || result.stderr);
              process.exit(1);
            }
            console.log(result.stdout);
          } else if (command === 'quit') {
            process.exit(0);
          }
        });
        console.log(JSON.stringify({ cgroup: readFileSync('/proc/self/cgroup', 'utf8') }));
      `;
      const wrapped = scope.wrap(process.execPath, ['-e', script]);
      const child = spawn(wrapped.command, wrapped.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const next = async () => {
        const line = await lines.next();
        expect(line.done, stderr).toBe(false);
        return JSON.parse(line.value!);
      };
      const total = (cpu: { userUsec: number; systemUsec: number }) =>
        cpu.userUsec + cpu.systemUsec;
      try {
        const ready = await next();
        const membership = `/${relative('/sys/fs/cgroup', realpathSync(scope.path))}`;
        expect(ready.cgroup.trim().split('\n')).toContain(`0::${membership}`);
        expect(() => scope.close()).toThrow();
        const beforeOutside = scope.read();
        const outside = spawnSync(process.execPath, ['-e', burn], { encoding: 'utf8' });
        expect(outside.error).toBeUndefined();
        expect(outside.status, outside.stderr).toBe(0);
        const outsideCpu = JSON.parse(outside.stdout);
        const before = scope.read();
        expect(total(before) - total(beforeOutside)).toBeLessThan(
          (outsideCpu.user + outsideCpu.system) / 4,
        );
        child.stdin.write('run\n');
        const descendant = await next();
        const after = scope.read();
        expect(descendant.user + descendant.system).toBeGreaterThanOrEqual(160000);
        expect(total(after) - total(before)).toBeGreaterThanOrEqual(
          (descendant.user + descendant.system) * 0.9,
        );
        child.stdin.end('quit\n');
        expect(await exited, stderr).toBe(0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        await lines.return?.();
        scope.close();
      }
      expect(existsSync(scope.path)).toBe(false);
    },
    20000,
  );

  describe('same-input parity comparison', () => {
    const answer = (incoming: string[], status = 'found') =>
      JSON.stringify({
        status,
        symbol: { uid: 'Function:a.ts:f' },
        incoming: { calls: incoming.map((uid) => ({ uid })) },
        outgoing: { calls: [] },
      }) + '\n\n---\n**Next:** hint';

    it('ignores the hint and caller order', () => {
      const a = contextFingerprint(answer(['b', 'a']));
      const b = contextFingerprint(answer(['a', 'b']));
      expect(diffFingerprints(a, b)).toEqual([]);
      expect(a.incoming).toEqual(['a', 'b']);
    });

    it('reports a missing caller, an extra caller and a status change', () => {
      const reference = contextFingerprint(answer(['a', 'probe']));
      expect(diffFingerprints(contextFingerprint(answer(['a'])), reference)).toEqual([
        'incoming missing probe',
      ]);
      expect(diffFingerprints(contextFingerprint(answer(['a', 'probe', 'z'])), reference)).toEqual([
        'incoming extra z',
      ]);
      expect(
        diffFingerprints(contextFingerprint(answer(['a', 'probe'], 'ambiguous')), reference),
      ).toEqual(['status ambiguous != found']);
    });
  });

  it('includes the parity workload by default and rejects unknown extras', () => {
    const base = ['--automatic', '--output', '/tmp/x.json'];
    expect(parseAutomaticArgs(base).extras).toContain('parity');
    expect(() => parseAutomaticArgs([...base, '--extras', 'nope'])).toThrow('--extras');
  });

  it('turns --pilot into one cold size-1 read', () => {
    const opts = parseAutomaticArgs(['--automatic', '--pilot', '--output', '/tmp/x.json']);
    expect(opts.sizes).toEqual([1]);
    expect(opts.repetitions).toBe(1);
    expect(opts.pilot).toBe(true);
  });

  it('includes the config and contention workloads by default and lets each be dropped', () => {
    const base = ['--automatic', '--output', '/tmp/x.json'];
    expect(parseAutomaticArgs(base).extras).toEqual(['config', 'contention', 'parity']);
    expect(parseAutomaticArgs([...base, '--extras', 'none']).extras).toEqual([]);
    expect(parseAutomaticArgs([...base, '--extras', 'contention']).extras).toEqual(['contention']);
    expect(parseAutomaticArgs([...base, '--sizes', 'none']).sizes).toEqual([]);
    expect(
      parseAutomaticArgs(['--automatic', '--pilot', '--output', '/tmp/x.json']).extras,
    ).toEqual([]);
  });

  it.each([
    [['--sizes', '0,52'], '--sizes'],
    [['--sizes', '1,1'], '--sizes'],
    [['--extras', 'config,config'], '--extras'],
    [['--extras', 'throughput'], '--extras'],
    [['--repetitions', '0'], '--repetitions'],
    [['--bogus', 'x'], 'Unknown argument'],
  ])('rejects invalid arguments %j', (extra, message) => {
    expect(() => parseAutomaticArgs(['--automatic', '--output', '/tmp/x.json', ...extra])).toThrow(
      message,
    );
  });
});
