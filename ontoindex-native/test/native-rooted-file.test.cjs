'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Worker, isMainThread, workerData } = require('node:worker_threads');

// The worker repeatedly substitutes an equal-content outside target and restores
// the ancestor. This exercises concurrent lookup; it does not enumerate every
// kernel interleaving or prove that any particular lookup hit the rename window.
if (!isMainThread) {
  const { ancestor, parked, outside, shared } = workerData;
  const state = new Int32Array(shared);
  try {
    while (Atomics.load(state, 0) === 0) {
      fs.renameSync(ancestor, parked);
      try {
        fs.symlinkSync(outside, ancestor, 'dir');
        fs.unlinkSync(ancestor);
      } finally {
        if (fs.existsSync(ancestor)) fs.unlinkSync(ancestor);
        fs.renameSync(parked, ancestor);
      }
      Atomics.add(state, 1, 1);
      Atomics.notify(state, 1);
    }
  } finally {
    Atomics.store(state, 2, 1);
    Atomics.notify(state, 2);
  }
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main() {
  assert.equal(process.platform, 'linux', 'rooted-file acceptance requires Linux');
  const { openRootedDirectory } = require('../index.cjs');
  assert.equal(typeof openRootedDirectory, 'function');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-rooted-')));
  const rootPath = path.join(temporary, 'root');
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(rootPath);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(rootPath, 'ancestor'));
  fs.writeFileSync(path.join(rootPath, 'ancestor', 'file'), 'same bytes');
  fs.writeFileSync(path.join(outside, 'file'), 'same bytes');
  const outsideIdentity = fs.statSync(path.join(outside, 'file'));
  const roots = [];
  const openRoot = (root) => {
    const handle = openRootedDirectory(root);
    roots.push(handle);
    return handle;
  };
  const readInside = (root, relative) => {
    const fd = root.openRegularFile(relative);
    try {
      const identity = fs.fstatSync(fd);
      // Reject outside identity before reading: equal bytes must never hide an
      // escaped descriptor, even if the ancestor was already restored.
      assert.ok(
        identity.dev !== outsideIdentity.dev || identity.ino !== outsideIdentity.ino,
        'native open transferred an outside descriptor',
      );
      assert.equal(fs.readFileSync(fd, 'utf8'), 'same bytes');
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    const root = openRoot(rootPath);
    readInside(root, 'ancestor/file');
    const slash = openRoot('/');
    slash.close();
    slash.close();
    assert.throws(() => slash.openRegularFile('etc/passwd'), /closed/);

    for (const invalid of [
      '',
      '/etc/passwd',
      '../outside/file',
      'ancestor/../file',
      '.',
      'ancestor/./file',
      'ancestor//file',
      'ancestor/',
      'ancestor\0/file',
    ]) {
      assert.throws(() => root.openRegularFile(invalid), undefined, JSON.stringify(invalid));
    }
    for (const invalidRoot of [
      '',
      'relative',
      rootPath + '/',
      rootPath + '/../outside',
      rootPath + '\0',
    ]) {
      assert.throws(() => openRootedDirectory(invalidRoot));
    }
    assert.throws(() => openRootedDirectory(path.join(rootPath, 'ancestor', 'file')));
    fs.symlinkSync(outside, path.join(rootPath, 'link'), 'dir');
    fs.symlinkSync(path.join(outside, 'file'), path.join(rootPath, 'leaf-link'));
    fs.symlinkSync('ancestor/file', path.join(rootPath, 'internal-link'));
    for (const relative of ['link/file', 'leaf-link', 'internal-link', 'ancestor', 'missing']) {
      assert.throws(() => root.openRegularFile(relative));
    }
    fs.symlinkSync(rootPath, path.join(temporary, 'root-link'), 'dir');
    assert.throws(() => openRootedDirectory(path.join(temporary, 'root-link')));
    assert.throws(() => openRootedDirectory(path.join(temporary, 'root-link', 'ancestor')));
    execFileSync('mkfifo', [path.join(rootPath, 'fifo')]);
    // O_NONBLOCK makes this fail promptly instead of waiting for a FIFO writer.
    assert.throws(() => root.openRegularFile('fifo'));

    // Deterministic swap-and-restore: the outside target contains identical data.
    const ancestor = path.join(rootPath, 'ancestor');
    const parked = path.join(temporary, 'parked');
    fs.renameSync(ancestor, parked);
    fs.symlinkSync(outside, ancestor, 'dir');
    assert.throws(() => root.openRegularFile('ancestor/file'));
    fs.unlinkSync(ancestor);
    fs.renameSync(parked, ancestor);
    readInside(root, 'ancestor/file');

    const shared = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
    const state = new Int32Array(shared);
    const worker = new Worker(__filename, { workerData: { ancestor, parked, outside, shared } });
    const finished = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`swap worker exited ${code}`)),
      );
    });
    try {
      const deadline = Date.now() + 5000;
      while (Atomics.load(state, 1) === 0 && Date.now() < deadline) Atomics.wait(state, 1, 0, 100);
      assert.ok(Atomics.load(state, 1) > 0, 'swap worker must exercise mutation');
      for (let attempt = 0; attempt < 500; attempt++) {
        let fd;
        try {
          fd = root.openRegularFile('ancestor/file');
        } catch (error) {
          assert.match(String(error), /rooted regular file open failed/);
          continue;
        }
        try {
          const identity = fs.fstatSync(fd);
          assert.ok(
            identity.dev !== outsideIdentity.dev || identity.ino !== outsideIdentity.ino,
            'concurrent substitution transferred outside descriptor',
          );
          assert.equal(fs.readFileSync(fd, 'utf8'), 'same bytes');
        } finally {
          fs.closeSync(fd);
        }
      }
    } finally {
      Atomics.store(state, 0, 1);
      await finished;
    }
    readInside(root, 'ancestor/file');

    // Pinning is inode based: replacing the original root pathname cannot
    // redirect the existing root object. An already transferred fd also survives close.
    const movedRoot = path.join(temporary, 'moved-root');
    fs.renameSync(rootPath, movedRoot);
    fs.symlinkSync(outside, rootPath, 'dir');
    readInside(root, 'ancestor/file');
    assert.throws(() => openRootedDirectory(rootPath));
    const fd = root.openRegularFile('ancestor/file');
    root.close();
    root.close();
    try {
      assert.equal(fs.readFileSync(fd, 'utf8'), 'same bytes');
      assert.throws(() => root.openRegularFile('ancestor/file'), /closed/);
    } finally {
      fs.closeSync(fd);
    }
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    console.log('native rooted-file containment and ownership checks passed');
  } finally {
    for (const root of roots) root.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
