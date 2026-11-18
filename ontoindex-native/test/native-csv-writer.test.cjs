'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCsvRowWriter } = require('../index.cjs');
const native = require('../native.cjs');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-native-csv-'));
  const csvPath = path.join(dir, 'nodes.csv');
  const abortedPath = path.join(dir, 'aborted.csv');
  const aborted = createCsvRowWriter(abortedPath, 'id');
  aborted.addRow('discard');
  await aborted.abort();
  await aborted.abort();
  assert.deepEqual(aborted._rows, []);
  assert.equal(aborted._chars, 0);
  assert.throws(() => aborted.addRow('later'), /CSV writer aborted/);
  await assert.rejects(aborted.finish(), /CSV writer aborted/);
  assert.equal(fs.existsSync(abortedPath), false);

  const afterFinishPath = path.join(dir, 'after-finish.csv');
  const afterFinish = createCsvRowWriter(afterFinishPath, 'id');
  afterFinish.addRow('written');
  await afterFinish.finish();
  afterFinish.addRow('second batch');
  await afterFinish.finish();
  afterFinish.addRow('discard');
  await afterFinish.abort();
  await assert.rejects(afterFinish.finish(), /CSV writer aborted/);
  assert.equal(fs.readFileSync(afterFinishPath, 'utf8'), 'id\nwritten\nsecond batch\n');
  const writer = createCsvRowWriter(csvPath, 'id,name,content');

  writer.addRow('"1","alpha","plain"');
  writer.addRow('"2","quote","say ""hello"""');
  writer.addRow('"3","multiline","line1\nline2"');
  assert.equal(writer.rows, 3);
  await writer.finish();

  assert.equal(
    fs.readFileSync(csvPath, 'utf8'),
    'id,name,content\n"1","alpha","plain"\n"2","quote","say ""hello"""\n"3","multiline","line1\nline2"\n',
  );

  const recordsPath = path.join(dir, 'records.csv');
  const batchesPath = path.join(dir, 'batches.csv');
  const batches = createCsvRowWriter(batchesPath, 'id,name');
  const batchRows = Array.from({ length: 1201 }, (_, i) => `${i},row-${i}`);
  for (const [i, row] of batchRows.entries()) {
    assert.equal(batches.addRow(row), undefined);
    assert.equal(batches._rows.length, (i + 2) % 500);
    assert.ok(batches._rows.length < 500);
    if (i === 498 || i === 998) {
      assert.equal(
        fs.readFileSync(batchesPath, 'utf8'),
        `id,name\n${batchRows.slice(0, i + 1).join('\n')}\n`,
      );
    }
  }
  await batches.finish();
  assert.equal(batches.rows, 1201);
  assert.equal(batches._chars, 0);
  assert.equal(fs.readFileSync(batchesPath, 'utf8'), `id,name\n${batchRows.join('\n')}\n`);

  const emptyPath = path.join(dir, 'empty.csv');
  const empty = createCsvRowWriter(emptyPath, 'id,name');
  await empty.finish();
  assert.equal(empty.rows, 0);
  assert.equal(fs.readFileSync(emptyPath, 'utf8'), 'id,name\n');

  const limitedPath = path.join(dir, 'limited.csv');
  const limited = createCsvRowWriter(limitedPath, 'value', 6);
  limited.addRow('ab');
  assert.equal(fs.readFileSync(limitedPath, 'utf8'), 'value\n');
  limited.addRow('cd');
  assert.equal(limited._chars, 6);
  limited.addRow('e');
  assert.equal(fs.readFileSync(limitedPath, 'utf8'), 'value\nab\ncd\n');
  assert.deepEqual(limited._rows, ['e']);
  limited.addRow('oversized');
  assert.equal(limited._chars, 0);
  assert.deepEqual(limited._rows, []);
  assert.equal(fs.readFileSync(limitedPath, 'utf8'), 'value\nab\ncd\ne\noversized\n');
  limited.addRow('z');
  await limited.finish();
  assert.equal(limited.rows, 5);
  assert.equal(fs.readFileSync(limitedPath, 'utf8'), 'value\nab\ncd\ne\noversized\nz\n');

  const failingPath = path.join(dir, 'failing.csv');
  const failing = createCsvRowWriter(failingPath, 'value');
  failing.addRow('written');
  await failing.finish();
  failing.addRow('pending');
  const failure = new Error('native append failed');
  const appendCsvBytes = native.appendCsvBytes;
  let attempts = 0;
  native.appendCsvBytes = (...args) => {
    attempts++;
    // Model a partial write before the error, so retrying would duplicate data.
    appendCsvBytes(...args);
    if (attempts === 1) throw failure;
  };
  try {
    await assert.rejects(failing.finish(), (error) => error === failure);
    assert.deepEqual(failing._rows, []);
    assert.equal(failing._chars, 0);
    await assert.rejects(failing.finish(), (error) => error === failure);
    assert.throws(
      () => failing.addRow('later'),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(failingPath, 'utf8'), 'value\nwritten\npending\n');
  } finally {
    native.appendCsvBytes = appendCsvBytes;
  }

  const headerOnlyPath = path.join(dir, 'header-only.csv');
  const headerOnly = createCsvRowWriter(headerOnlyPath, 'value');
  const headerFailure = new Error('native header write failed');
  let headerAttempts = 0;
  native.appendCsvBytes = () => {
    headerAttempts++;
    throw headerFailure;
  };
  try {
    await assert.rejects(headerOnly.finish(), (error) => error === headerFailure);
    await assert.rejects(headerOnly.finish(), (error) => error === headerFailure);
    assert.equal(headerAttempts, 1);
  } finally {
    native.appendCsvBytes = appendCsvBytes;
  }

  for (const budget of [1, 4, 7, 16]) {
    const fragmentPath = path.join(dir, `fragments-${budget}.csv`);
    fs.writeFileSync(fragmentPath, 'stale bytes to truncate');
    const header = '界🙂\ud800header';
    const rows = ['🙂界\udc00🙂abcdef', '', 'z'];
    const calls = [];
    native.appendCsvBytes = (target, bytes, truncate) => {
      assert.ok(Buffer.isBuffer(bytes));
      assert.ok(bytes.length <= Math.max(4, budget));
      calls.push({ bytes: Buffer.from(bytes), truncate });
      return appendCsvBytes(target, bytes, truncate);
    };
    try {
      const fragmented = createCsvRowWriter(fragmentPath, header, budget);
      for (const row of rows) fragmented.addRow(row);
      await fragmented.finish();
      const expected = Buffer.from([header, ...rows].join('\n') + '\n');
      assert.deepEqual(fs.readFileSync(fragmentPath), expected);
      assert.deepEqual(Buffer.concat(calls.map((call) => call.bytes)), expected);
      assert.equal(calls[0].truncate, true);
      assert.ok(calls.slice(1).every((call) => call.truncate === false));
      assert.equal(fragmented.rows, rows.length);
    } finally {
      native.appendCsvBytes = appendCsvBytes;
    }
  }

  const unicodePath = path.join(dir, 'unicode.csv');
  const unicode = createCsvRowWriter(unicodePath, '界', 9);
  unicode.addRow('🙂');
  assert.equal(unicode._chars, 9);
  assert.ok(!fs.existsSync(unicodePath));
  unicode.addRow('a');
  assert.deepEqual(fs.readFileSync(unicodePath), Buffer.from('界\n🙂\n'));
  await unicode.finish();
  assert.deepEqual(fs.readFileSync(unicodePath), Buffer.from('界\n🙂\na\n'));

  const written = native.writeCsvRecords(
    recordsPath,
    ['id', 'name', 'content'],
    [
      ['1', 'alpha', 'plain'],
      ['2', 'quote', 'say "hello"'],
      ['3', 'multiline', 'line1\nline2'],
    ],
  );
  assert.equal(written, 3);
  assert.equal(
    fs.readFileSync(recordsPath, 'utf8'),
    'id,name,content\n"1","alpha","plain"\n"2","quote","say ""hello"""\n"3","multiline","line1\nline2"\n',
  );

  assert.deepEqual(
    native.mergeRrfKeys(['a', 'b', 'c'], ['c', 'b', 'd'], 2).map((entry) => entry.key),
    ['c', 'b'],
  );
  assert.equal(
    native.expandQueryTokens('URLParser pool_adapter'),
    'URLParser URL Parser pool_adapter pool adapter',
  );
  assert.deepEqual(
    native
      .tarjanSccs([
        { node: 'a', children: ['b'] },
        { node: 'b', children: ['a', 'c'] },
        { node: 'c', children: [] },
      ])
      .map((entry) => ({ nodes: entry.nodes, isCycle: entry.isCycle })),
    [
      { nodes: ['c'], isCycle: false },
      { nodes: ['b', 'a'], isCycle: true },
    ],
  );
  assert.deepEqual(
    native
      .scanHttpContracts([
        {
          filePath: 'src/routes.ts',
          content:
            'router.get("/api/users/:id", handler); await fetch("/api/orders/123", { method: "POST" });',
        },
      ])
      .map((record) => ({
        contractId: record.contractId,
        role: record.role,
        kind: record.kind,
        path: record.path,
      })),
    [
      {
        contractId: 'http::GET::/api/users/{param}',
        role: 'provider',
        kind: 'http',
        path: '/api/users/{param}',
      },
      {
        contractId: 'http::POST::/api/orders/123',
        role: 'consumer',
        kind: 'http',
        path: '/api/orders/123',
      },
    ],
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
