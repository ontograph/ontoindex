import lbug from '@ladybugdb/core';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Cypher node labels', () => {
  it('uses label(n) throughout source instead of indexing labels(n)', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const sourceRoots = ['ontoindex/src', 'ontoindex-web/src'].map((root) =>
      path.join(repoRoot, root),
    );
    const violations: string[] = [];

    async function scan(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await scan(entryPath);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
          const lines = (await readFile(entryPath, 'utf8')).split('\n');
          for (const [index, line] of lines.entries()) {
            if (/labels\(\w+\)\[0\]/.test(line)) {
              violations.push(`${path.relative(repoRoot, entryPath)}:${index + 1}`);
            }
          }
        }
      }
    }

    for (const root of sourceRoots) await scan(root);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('returns the table name with label(n) in LadybugDB', async () => {
    const db = new lbug.Database(':memory:', 64 * 1024 * 1024);
    const conn = new lbug.Connection(db);
    async function query(statement: string): Promise<Record<string, unknown>[]> {
      const result = await conn.query(statement);
      const results = Array.isArray(result) ? result : [result];
      try {
        return await results[0].getAll();
      } finally {
        for (const item of results) await item.close();
      }
    }

    try {
      await query('CREATE NODE TABLE Function(id STRING, PRIMARY KEY(id))');
      await query('CREATE NODE TABLE File(id STRING, PRIMARY KEY(id))');
      await query("CREATE (:Function {id: 'example'})");
      await query("CREATE (:File {id: 'source.ts'})");
      expect(
        await query('MATCH (n:Function) RETURN label(n) AS kind, labels(n)[0] AS indexedLabel'),
      ).toEqual([{ kind: 'Function', indexedLabel: '' }]);
      expect(
        await query(
          "MATCH (n) WHERE label(n) IN ['Function', 'Method', 'Class', 'Struct', 'Interface'] RETURN n.id AS id",
        ),
      ).toEqual([{ id: 'example' }]);
    } finally {
      try {
        await conn.close();
      } finally {
        await db.close();
      }
    }
  });
});
