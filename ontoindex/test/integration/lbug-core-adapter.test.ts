/**
 * P0 Integration Tests: Core LadybugDB Adapter
 *
 * Tests: loadGraphToLbug CSV round-trip, createFTSIndex, getLbugStats.
 *
 * IMPORTANT: All core adapter tests share ONE coreHandle and ONE coreInitLbug
 * call because the core adapter is a module-level singleton. Calling
 * coreInitLbug with a different path closes the previous native DB handle
 * and opens a new one — sharing a single handle avoids unnecessary churn.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'node:module';
import type { OntoIndexNativeModule } from '../../src/native/module.js';
import { getNativeGraphWriterStatus, writeGraphBatch } from '../../src/native/graph-writer.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

// ─── Core LadybugDB Adapter ─────────────────────────────────────────────

withTestLbugDB(
  'core-adapter',
  (handle) => {
    describe('core adapter', () => {
      it('loadGraphToLbug: loads a minimal graph and node counts match', async () => {
        const { executeQuery: coreExecuteQuery } =
          await import('../../src/core/lbug/lbug-adapter.js');

        // createMinimalTestGraph has 2 File, 2 Function, 1 Class, 1 Folder = 6 nodes
        const fileRows = await coreExecuteQuery('MATCH (n:File) RETURN n.id AS id');
        expect(fileRows).toHaveLength(2);

        const funcRows = await coreExecuteQuery('MATCH (n:Function) RETURN n.id AS id');
        expect(funcRows).toHaveLength(2);

        const classRows = await coreExecuteQuery('MATCH (n:Class) RETURN n.id AS id');
        expect(classRows).toHaveLength(1);

        const folderRows = await coreExecuteQuery('MATCH (n:Folder) RETURN n.id AS id');
        expect(folderRows).toHaveLength(1);
      });

      it('createFTSIndex: creates FTS index on Function table without error', async () => {
        const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

        await expect(
          createFTSIndex('Function', 'function_fts', ['name', 'content']),
        ).resolves.toBeUndefined();
      });

      it('getLbugStats: returns correct node and edge counts for seeded data', async () => {
        const { getLbugStats } = await import('../../src/core/lbug/lbug-adapter.js');

        const stats = await getLbugStats();

        // createMinimalTestGraph: 6 nodes (2 File, 2 Function, 1 Class, 1 Folder)
        expect(stats.nodes).toBe(6);

        // 4 relationships (2 CALLS, 2 CONTAINS)
        expect(stats.edges).toBe(4);
      });

      describe('unhappy path', () => {
        it('throws on malformed Cypher query', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // Deliberately broken syntax: MATCH without a pattern clause
          await expect(executeQuery('MATCH RETURN 1')).rejects.toThrow();
        });

        it('returns empty results for query matching no nodes', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // Valid Cypher, but the id will never exist in the seeded graph
          const rows = await executeQuery(
            "MATCH (n:Function) WHERE n.id = '__nonexistent_id__' RETURN n.id AS id",
          );
          expect(rows).toHaveLength(0);
        });

        it('handles query with non-existent table/node label', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // LadybugDB throws when the node table does not exist in the schema
          await expect(executeQuery('MATCH (n:GhostTable) RETURN n')).rejects.toThrow();
        });
      });

      describe('error handling', () => {
        it('createFTSIndex handles already-existing index gracefully', async () => {
          const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

          // First call creates the index (may already exist from earlier test)
          await createFTSIndex('Function', 'function_fts_dup', ['name', 'content']);

          // Second call with same params should NOT throw — createFTSIndex catches "already exists"
          await expect(
            createFTSIndex('Function', 'function_fts_dup', ['name', 'content']),
          ).resolves.toBeUndefined();
        });

        it('getLbugStats returns valid counts', async () => {
          const { getLbugStats } = await import('../../src/core/lbug/lbug-adapter.js');

          // getLbugStats NEVER throws — it has silent catch blocks per table
          const stats = await getLbugStats();
          expect(typeof stats.nodes).toBe('number');
          expect(typeof stats.edges).toBe('number');
          expect(stats.nodes).toBeGreaterThanOrEqual(0);
          expect(stats.edges).toBeGreaterThanOrEqual(0);
        });

        it('executeQuery with empty string rejects', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // LadybugDB throws on empty query string
          await expect(executeQuery('')).rejects.toThrow();
        });

        it('deleteNodesForFile with non-existent path returns zero deleted', async () => {
          const { deleteNodesForFile } = await import('../../src/core/lbug/lbug-adapter.js');

          // deleteNodesForFile has per-query try/catch, returns {deletedNodes: 0} for missing paths
          const result = await deleteNodesForFile('/absolutely/nonexistent/path/file.ts');
          expect(result).toEqual({ deletedNodes: 0 });
        });
      });
    });
  },
  {
    afterSetup: async (handle) => {
      // Load a minimal graph via CSV round-trip (core adapter is already initialized by wrapper)
      const { loadGraphToLbug } = await import('../../src/core/lbug/lbug-adapter.js');
      const { createMinimalTestGraph } = await import('../helpers/test-graph.js');

      const graph = createMinimalTestGraph();
      const storagePath = path.join(handle.tmpHandle.dbPath, 'storage');
      await fs.mkdir(storagePath, { recursive: true });

      await loadGraphToLbug(graph, '/test/repo', storagePath);
    },
  },
);

withTestLbugDB('native-schema-parity', (handle) => {
  it('round-trips real native Method and Concept schemas across batches', async () => {
    const native = createRequire(import.meta.url)(
      '../../../ontoindex-native/index.cjs',
    ) as OntoIndexNativeModule;
    expect(typeof native.writeGraphBatchNative).toBe('function');
    const method = {
      id: 'Method:provided',
      name: 'provided',
      filePath: 'missing.ts',
      startLine: 0,
      endLine: 8,
      isExported: true,
      parameterCount: 2,
      returnType: 'string',
      description: 'method description',
      declarationFilePath: 'api.d.ts',
      declarationStartLine: 0,
      declarationEndLine: 4,
      definitionFilePath: 'impl.ts',
      definitionStartLine: 5,
      definitionEndLine: 8,
    };
    const concept = {
      id: 'Concept:provided',
      name: 'provided',
      filePath: 'guide.md',
      aliases: ['kept', "owner's\\path"],
      sourceDocuments: ['guide.md'],
      sourceFactKeys: ['fact:1'],
      resolutionKeys: ['key:1'],
      authority: 'authoritative',
      confidence: 'high',
      evidenceClass: 'docs_evidence',
      freshness: 'current',
    };
    const graph = buildTestGraph([
      { ...method, label: 'Method', extra: method },
      {
        ...concept,
        label: 'Concept',
        extra: {
          ...concept,
          aliases: [...concept.aliases, '', 42, false, null, {}],
          sourceDocuments: ['guide.md', '', 0],
          sourceFactKeys: ['fact:1', undefined],
          resolutionKeys: ['key:1', {}],
        },
      },
      ...Array.from({ length: 1000 }, (_, i) => ({
        id: `Method:default-${i}`,
        label: 'Method' as const,
        name: '',
        filePath: '',
      })),
      {
        id: 'Concept:default',
        label: 'Concept',
        name: '',
        filePath: '',
        extra: {
          aliases: false,
          sourceDocuments: 'invalid',
          sourceFactKeys: null,
          authority: '',
          confidence: 0,
          evidenceClass: false,
          freshness: null,
        },
      },
    ]);
    const csvDir = path.join(handle.tmpHandle.dbPath, 'native-csv');
    await fs.mkdir(csvDir);
    const result = await writeGraphBatch(csvDir, graph.nodes, [], {
      env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
      nativeModule: native,
    });
    expect(Object.fromEntries(result.nodeCounts)).toEqual({ Method: 1001, Concept: 2 });
    const readRows = async (label: string) => {
      const [header, ...lines] = (
        await fs.readFile(path.join(csvDir, `nodes_${label}.csv`), 'utf8')
      )
        .trimEnd()
        .split('\n');
      const fields = header.split(',');
      return {
        header,
        rows: lines.map((line) =>
          Object.fromEntries(
            line
              .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
              .map((field, index) => [
                fields[index],
                field.replace(/^"|"$/g, '').replace(/""/g, '"'),
              ]),
          ),
        ),
      };
    };
    const methods = await readRows('Method');
    expect(methods.header).toBe(
      'id,name,filePath,startLine,endLine,isExported,content,description,parameterCount,returnType,declarationFilePath,declarationStartLine,declarationEndLine,definitionFilePath,definitionStartLine,definitionEndLine',
    );
    expect(methods.rows).toHaveLength(1001);
    expect(methods.rows[0]).toEqual({
      ...Object.fromEntries(Object.entries(method).map(([key, value]) => [key, String(value)])),
      content: '',
    });
    const defaultMethod = {
      id: 'Method:default-999',
      name: '',
      filePath: '',
      startLine: -1,
      endLine: -1,
      isExported: false,
      content: '',
      description: '',
      parameterCount: 0,
      returnType: '',
      declarationFilePath: '',
      declarationStartLine: -1,
      declarationEndLine: -1,
      definitionFilePath: '',
      definitionStartLine: -1,
      definitionEndLine: -1,
    };
    expect(methods.rows.at(-1)).toEqual(
      Object.fromEntries(Object.entries(defaultMethod).map(([key, value]) => [key, String(value)])),
    );
    const concepts = await readRows('Concept');
    expect(concepts.header).toBe(
      'id,name,filePath,aliases,sourceDocuments,sourceFactKeys,resolutionKeys,authority,confidence,evidenceClass,freshness',
    );
    expect(concepts.rows).toHaveLength(2);
    expect(concepts.rows[0]).toEqual({
      ...concept,
      aliases: "['kept','owner''s\\\\path']",
      sourceDocuments: "['guide.md']",
      sourceFactKeys: "['fact:1']",
      resolutionKeys: "['key:1']",
    });
    const defaultConcept = {
      id: 'Concept:default',
      name: '',
      filePath: '',
      aliases: [],
      sourceDocuments: [],
      sourceFactKeys: [],
      resolutionKeys: [],
      authority: 'advisory',
      confidence: 'low',
      evidenceClass: 'docs_evidence',
      freshness: 'unknown',
    };
    expect(concepts.rows[1]).toEqual({
      ...defaultConcept,
      aliases: '[]',
      sourceDocuments: '[]',
      sourceFactKeys: '[]',
      resolutionKeys: '[]',
    });

    const { loadGraphToLbug, executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');
    const previous = process.env.ONTOINDEX_NATIVE_GRAPH_WRITER;
    process.env.ONTOINDEX_NATIVE_GRAPH_WRITER = '1';
    try {
      expect(getNativeGraphWriterStatus()).toMatchObject({ enabled: true, available: true });
      await loadGraphToLbug(
        graph,
        handle.tmpHandle.dbPath,
        path.join(handle.tmpHandle.dbPath, 'storage'),
      );
    } finally {
      if (previous === undefined) delete process.env.ONTOINDEX_NATIVE_GRAPH_WRITER;
      else process.env.ONTOINDEX_NATIVE_GRAPH_WRITER = previous;
    }
    const query = async (label: string, expected: Record<string, unknown>) =>
      executeQuery(
        `MATCH (n:${label}) WHERE n.id = '${expected.id}' RETURN ${Object.keys(expected)
          .map((key) => `n.${key} AS ${key}`)
          .join(', ')}`,
      );
    const records: Array<[string, Record<string, unknown>]> = [
      ['Method', { ...method, content: '' }],
      ['Method', defaultMethod],
      ['Concept', concept],
      ['Concept', defaultConcept],
    ];
    const nativeRows = await Promise.all(
      records.map(([label, expected]) => query(label, expected)),
    );
    for (let index = 0; index < records.length; index++) {
      const [, expected] = records[index];
      // COPY represents empty CSV scalar fields as NULL.
      expect(nativeRows[index]).toHaveLength(1);
      for (const [key, value] of Object.entries(expected)) {
        if (Array.isArray(value)) expect(nativeRows[index][0][key]).toHaveLength(value.length);
        else expect(nativeRows[index][0][key]).toEqual(value === '' ? null : value);
      }
    }
    expect(await executeQuery('MATCH (n:Method) RETURN count(n) AS count')).toEqual([
      { count: 1001 },
    ]);
    // Compare COPY's list decoding with the canonical TypeScript writer as well
    // as the exact native CSV assertions above.
    await executeQuery('MATCH (n:Method) DETACH DELETE n');
    await executeQuery('MATCH (n:Concept) DETACH DELETE n');
    process.env.ONTOINDEX_NATIVE_GRAPH_WRITER = '0';
    try {
      await loadGraphToLbug(
        graph,
        handle.tmpHandle.dbPath,
        path.join(handle.tmpHandle.dbPath, 'storage-js'),
      );
    } finally {
      if (previous === undefined) delete process.env.ONTOINDEX_NATIVE_GRAPH_WRITER;
      else process.env.ONTOINDEX_NATIVE_GRAPH_WRITER = previous;
    }
    const canonicalRows = await Promise.all(
      records.map(([label, expected]) => query(label, expected)),
    );
    expect(nativeRows).toEqual(canonicalRows);
  });
});
