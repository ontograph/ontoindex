import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const tsx = path.resolve(__dirname, '../../node_modules/.bin/tsx');
const watchdog = path.resolve(__dirname, '../../src/core/parent-watchdog.ts');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('startParentWatchdog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('kills a child whose main thread is blocked once its parent is killed', async () => {
    const pidFile = path.join(dir, 'child.pid');
    const childScript = path.join(dir, 'child.mts');
    await fs.writeFile(
      childScript,
      `import fs from 'node:fs';
       import { startParentWatchdog } from ${JSON.stringify(watchdog)};
       startParentWatchdog(Number(process.argv[2]), 100);
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       for (;;) {}`,
    );
    const parentScript = path.join(dir, 'parent.mjs');
    await fs.writeFile(
      parentScript,
      `import { spawn } from 'node:child_process';
       spawn(${JSON.stringify(tsx)}, [${JSON.stringify(childScript)}, String(process.pid)],
         { detached: true, stdio: 'ignore' }).unref();
       setInterval(() => {}, 1000);`,
    );
    const parent = spawn(process.execPath, [parentScript], { stdio: 'ignore' });
    let childPid = 0;
    for (let i = 0; i < 100 && !childPid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      childPid = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0'));
    }
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(true);
    parent.kill('SIGKILL');
    for (let i = 0; i < 50 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
    const stillAlive = alive(childPid);
    if (stillAlive) process.kill(childPid, 'SIGKILL');
    expect(stillAlive).toBe(false);
  }, 30_000);
});
