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
