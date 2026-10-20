'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 8192;

function childMain(lockPath) {
  const { tryAcquireFileLock } = require('../index.cjs');
  let lock;
  process.on('message', (message) => {
    try {
      if (message.type === 'go') {
        lock = tryAcquireFileLock(lockPath);
        if (lock === null) {
          process.send({ type: 'conflict' }, () => process.exit(0));
        } else {
          process.send({ type: 'acquired' });
        }
      } else if (message.type === 'release') {
        assert.ok(lock, 'release requires ownership');
        lock.release();
        process.send({ type: 'released' }, () => process.exit(0));
      }
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
  process.send({ type: 'ready' });
}

function startChild(lockPath, ownedChildren) {
  const child = fork(__filename, ['--lock-child', lockPath], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const state = { child, stderr: '', messages: [], pending: null, ended: false };
  ownedChildren.push(state);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderr = (state.stderr + chunk).slice(0, STDERR_LIMIT);
  });
  child.on('message', (message) => {
    if (state.pending) {
      const pending = state.pending;
      state.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(message);
    } else {
      state.messages.push(message);
    }
  });
  state.closed = new Promise((resolve) => {
    child.on('error', (error) => { state.error = error; });
    child.on('close', (code, signal) => {
      state.ended = true;
      if (state.pending) {
        clearTimeout(state.pending.timer);
        state.pending.reject(new Error(`Child exited before IPC: ${code}/${signal}\n${state.stderr}`));
        state.pending = null;
      }
      resolve({ code, signal });
    });
  });
  return state;
}

function nextMessage(state) {
  if (state.messages.length) return Promise.resolve(state.messages.shift());
  if (state.ended) return Promise.reject(new Error(`Child already exited\n${state.stderr}`));
  assert.equal(state.pending, null, 'one IPC wait per child');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending = null;
      reject(new Error(`Timed out waiting for child IPC\n${state.stderr}`));
    }, TIMEOUT_MS);
    state.pending = { resolve, reject, timer };
  });
}

async function waitClosed(state) {
  let timer;
  try {
    return await Promise.race([
      state.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Child did not exit\n${state.stderr}`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  assert.equal(process.platform, 'linux', 'native file-lock tests require Linux');
  const { tryAcquireFileLock } = require('../index.cjs');
  assert.equal(typeof tryAcquireFileLock, 'function', 'index.cjs exports tryAcquireFileLock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-native-lock-'));
  const lockPath = path.join(dir, 'permanent.lock');
  const bytes = Buffer.from('existing lock metadata\n\0preserve me');
  const children = [];
  let lock;
  try {
    fs.writeFileSync(lockPath, bytes);
    const original = fs.statSync(lockPath, { bigint: true });
    const assertPreserved = () => {
      const current = fs.statSync(lockPath, { bigint: true });
      assert.equal(current.dev, original.dev);
      assert.equal(current.ino, original.ino);
      assert.deepEqual(fs.readFileSync(lockPath), bytes);
    };

    lock = tryAcquireFileLock(lockPath);
    assert.ok(lock, 'first open acquires lock');
    assert.equal(typeof lock.release, 'function');
    assert.equal(tryAcquireFileLock(lockPath), null, 'separate open in same process conflicts');
    assertPreserved();
    lock.release();
    lock.release();
    lock = tryAcquireFileLock(lockPath);
    assert.ok(lock, 'released lock can be reacquired');
    lock.release();
    lock = null;
    assert.throws(() => tryAcquireFileLock(path.join(dir, 'missing', 'lock')));
    assert.throws(() => tryAcquireFileLock(dir));
    assertPreserved();

    const holder = startChild(lockPath, children);
    assert.equal((await nextMessage(holder)).type, 'ready');
    holder.child.send({ type: 'go' });
    assert.equal((await nextMessage(holder)).type, 'acquired');
    assert.equal(tryAcquireFileLock(lockPath), null, 'independent process holds lock');
    assertPreserved();
    holder.child.kill('SIGKILL');
    assert.deepEqual(await waitClosed(holder), { code: null, signal: 'SIGKILL' });
    lock = tryAcquireFileLock(lockPath);
    assert.ok(lock, 'SIGKILL releases the kernel lock');
    lock.release();
    lock = null;

    const successors = [startChild(lockPath, children), startChild(lockPath, children)];
    const ready = await Promise.all(successors.map(nextMessage));
    assert.deepEqual(ready.map((message) => message.type), ['ready', 'ready']);
    for (const successor of successors) successor.child.send({ type: 'go' });
    const results = await Promise.all(successors.map(nextMessage));
    assert.deepEqual(results.map((message) => message.type).sort(), ['acquired', 'conflict']);
    const winner = successors[results.findIndex((message) => message.type === 'acquired')];
    const loser = successors[results.findIndex((message) => message.type === 'conflict')];
    assert.deepEqual(await waitClosed(loser), { code: 0, signal: null });
    assert.equal(tryAcquireFileLock(lockPath), null, 'winner retains ownership after loser exits');
    assertPreserved();
    winner.child.send({ type: 'release' });
    assert.equal((await nextMessage(winner)).type, 'released');
    assert.deepEqual(await waitClosed(winner), { code: 0, signal: null });
    lock = tryAcquireFileLock(lockPath);
    assert.ok(lock, 'explicit child release permits reacquisition');
    lock.release();
    lock = null;
    assertPreserved();
  } finally {
    if (lock) lock.release();
    for (const state of children) {
      if (!state.ended) state.child.kill('SIGKILL');
    }
    try {
      await Promise.all(children.map(waitClosed));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

if (process.argv[2] === '--lock-child') {
  childMain(process.argv[3]);
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
