// Standalone reproduction for a LadybugDB (@ladybugdb/core 0.17.1) query defect:
// `r.type IN [...]` returns wrong rows when a relationship table was bulk-loaded
// with COPY, the other endpoint is unlabeled, and a non-matching edge precedes
// matching ones in the target's adjacency list. `r.type = ...` is correct.
//
//   node scripts/repro/ladybug-rel-type-in.mjs [dbDir]
//
// Exit code 1 means the defect reproduced.
import lbug from '@ladybugdb/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lbug-in-repro-'));
const dbDir = path.join(root, 'db');
fs.rmSync(dbDir, { recursive: true, force: true });
const db = new lbug.Database(dbDir);
const conn = new lbug.Connection(db);
const q = async (s) => (await conn.query(s)).getAll();
const csv = (name, rows) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, rows.join('\n') + '\n');
  return p;
};

await q('CREATE NODE TABLE File(id STRING, name STRING, PRIMARY KEY(id))');
await q('CREATE NODE TABLE Function(id STRING, name STRING, PRIMARY KEY(id))');
await q('CREATE REL TABLE Rel(FROM File TO Function, FROM Function TO Function, type STRING)');
const FILLER = Number(process.env.FILLER ?? 200);
const filler = Array.from({ length: FILLER }, (_, i) => i);
await q(
  `COPY Function FROM '${csv('fn.csv', ['target,target', 'caller,callerFn', ...filler.map((i) => `f${i},f${i}`)])}' (HEADER=false)`,
);
await q(
  `COPY File FROM '${csv('file.csv', ['x,x.ts', 'a,a.test.ts', 'b,b.test.ts', 'c,c.test.ts', ...filler.map((i) => `z${i},z${i}.ts`)])}' (HEADER=false)`,
);
// The non-matching DEFINES edge comes first; three CALLS edges follow.
await q(
  `COPY Rel FROM '${csv('fe.csv', ['x,target,DEFINES', 'a,target,CALLS', 'b,target,CALLS', 'c,target,CALLS', ...filler.map((i) => `z${i},f${i},DEFINES`)])}' (from='File', to='Function', HEADER=false)`,
);
await q(
  `COPY Rel FROM '${csv('ff.csv', ['caller,target,CALLS', ...filler.slice(1).map((i) => `f${i - 1},f${i},CALLS`)])}' (from='Function', to='Function', HEADER=false)`,
);

const names = async (pred, params, pattern = '(a)') => {
  const text = `MATCH ${pattern}-[r:Rel]->(b) WHERE b.id = 'target' AND ${pred} RETURN a.name AS n ORDER BY n`;
  const res = params
    ? await conn.execute(await conn.prepare(text), params)
    : await conn.query(text);
  return (await res.getAll()).map((r) => r.n);
};
const eq = await names(`r.type = 'CALLS'`);
const inList = await names(`r.type IN ['CALLS']`);
const cases = {
  "r.type = 'CALLS'": eq,
  "r.type IN ['CALLS']": inList,
  'r.type IN $types': await names('r.type IN $types', { types: ['CALLS'] }),
  "(r.type = 'CALLS' OR r.type = 'IMPORTS')": await names(
    `(r.type = 'CALLS' OR r.type = 'IMPORTS')`,
  ),
  "(a:File) r.type IN ['CALLS']": await names(`r.type IN ['CALLS']`, undefined, '(a:File)'),
  "(a:File) r.type = 'CALLS'": await names(`r.type = 'CALLS'`, undefined, '(a:File)'),
};
console.log(`version: ${lbug.VERSION ?? 'unknown'}, filler: ${FILLER}`);
for (const [k, v] of Object.entries(cases)) console.log(`${k.padEnd(44)} -> ${JSON.stringify(v)}`);
const labels = (
  await q(
    `MATCH (n:Function {id:'target'}) RETURN labels(n) AS l, labels(n)[0] AS l0, label(n) AS lab`,
  )
)[0];
console.log(
  `labels(n)=${JSON.stringify(labels.l)} labels(n)[0]=${JSON.stringify(labels.l0)} label(n)=${JSON.stringify(labels.lab)}`,
);
const reproduced = JSON.stringify(eq) !== JSON.stringify(inList);
console.log(reproduced ? 'REPRODUCED: IN result differs from = result' : 'not reproduced');
process.exit(reproduced ? 1 : 0);
