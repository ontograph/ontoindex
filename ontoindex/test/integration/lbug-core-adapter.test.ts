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

      it('streams every cached vector and normalizes legacy null chunk metadata', async () => {
        const { countCachedEmbeddings, executeQuery: coreExecuteQuery, streamCachedEmbeddings } =
          await import('../../src/core/lbug/lbug-adapter.js');
        const { EMBEDDING_DIMS, EMBEDDING_TABLE_NAME } =
          await import('../../src/core/lbug/schema.js');
        const vector = `[${Array.from({ length: EMBEDDING_DIMS }, () => '0.25').join(',')}]`;
        await coreExecuteQuery(
          `CREATE (e:${EMBEDDING_TABLE_NAME} {id: 'stream:0', nodeId: 'Function:stream', chunkIndex: 0, startLine: 1, endLine: 2, embedding: ${vector}, contentHash: 'hash', chunkContentHash: 'chunk-hash'})`,
        );
        await coreExecuteQuery(
          `CREATE (e:${EMBEDDING_TABLE_NAME} {id: 'legacy-null:0', nodeId: 'Function:legacy-null', chunkIndex: null, startLine: null, endLine: null, embedding: ${vector}})`,
        );

        const streamed: Array<{
          nodeId: string;
          chunkIndex: number;
          startLine: number;
          endLine: number;
          contentHash?: string;
          chunkContentHash?: string;
        }> = [];
        const streamedCount = await streamCachedEmbeddings((embedding) => {
          streamed.push({
            nodeId: embedding.nodeId,
            chunkIndex: embedding.chunkIndex,
            startLine: embedding.startLine,
            endLine: embedding.endLine,
            ...(embedding.contentHash ? { contentHash: embedding.contentHash } : {}),
            ...(embedding.chunkContentHash
              ? { chunkContentHash: embedding.chunkContentHash }
              : {}),
          });
        });

        expect(await countCachedEmbeddings()).toBe(2);
        expect(streamedCount).toBe(2);
        expect(streamed).toContainEqual({
          nodeId: 'Function:legacy-null',
          chunkIndex: 0,
          startLine: 0,
          endLine: 0,
        });
        expect(streamed).toContainEqual({
          nodeId: 'Function:stream',
          chunkIndex: 0,
          startLine: 1,
          endLine: 2,
          contentHash: 'hash',
          chunkContentHash: 'chunk-hash',
        });
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
      aliases: '[]',
      sourceDocuments: '[]',
      sourceFactKeys: '[]',
      resolutionKeys: '[]',
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
    // Compare both CSV paths; typed list values are restored after COPY.
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

  it('round-trips every string-array column through typed COPY restoration', async () => {
    const { executePrepared, loadGraphToLbug } =
      await import('../../src/core/lbug/lbug-adapter.js');
    const values = ['withAuth', "O'Reilly", 'double"quote', 'comma,inside', 'close]bracket', 'back\\slash'];
    const routeResponseKeys = ['items', ...values.slice(1)];
    const previous = process.env.ONTOINDEX_NATIVE_GRAPH_WRITER;

    for (const mode of ['typescript', 'native'] as const) {
      const suffix = mode;
      const ids = {
        community: `comm_array-${suffix}`,
        process: `proc_array-${suffix}`,
        summary: `SummaryNode:array-${suffix}`,
        concept: `Concept:array-${suffix}`,
        route: `Route:array-${suffix}`,
        emptyRoute: `Route:empty-${suffix}`,
      };
      const graph = buildTestGraph([
        {
          id: ids.community,
          label: 'Community' as any,
          name: 'Array community',
          filePath: '',
          extra: { keywords: values },
        },
        {
          id: ids.process,
          label: 'Process' as any,
          name: 'Array process',
          filePath: '',
          extra: { communities: values },
        },
        {
          id: ids.summary,
          label: 'SummaryNode' as any,
          name: 'Array summary',
          filePath: '',
          extra: {
            summarizedCommunityIds: [...values, ''],
            summarizedConceptIds: [...values, ''],
            summarizedNodeIds: [...values, ''],
            sourceDocuments: [...values, ''],
            sourceFactKeys: [...values, ''],
            resolutionKeys: [...values, ''],
          },
        },
        {
          id: ids.concept,
          label: 'Concept' as any,
          name: 'Array concept',
          filePath: '',
          extra: {
            aliases: [...values, ''],
            sourceDocuments: [...values, ''],
            sourceFactKeys: [...values, ''],
            resolutionKeys: [...values, ''],
          },
        },
        {
          id: ids.route,
          label: 'Route' as any,
          name: '/array',
          filePath: 'src/route.ts',
          extra: {
            responseKeys: routeResponseKeys,
            errorKeys: [...values],
            middleware: [...values],
          },
        },
        {
          id: ids.emptyRoute,
          label: 'Route' as any,
          name: '/empty',
          filePath: 'src/route.ts',
        },
      ]);

      process.env.ONTOINDEX_NATIVE_GRAPH_WRITER = mode === 'native' ? '1' : '0';
      try {
        if (mode === 'native') {
          expect(getNativeGraphWriterStatus()).toMatchObject({ enabled: true, available: true });
        }
        await loadGraphToLbug(
          graph,
          handle.tmpHandle.dbPath,
          path.join(handle.tmpHandle.dbPath, `string-arrays-${mode}`),
        );
      } finally {
        if (previous === undefined) delete process.env.ONTOINDEX_NATIVE_GRAPH_WRITER;
        else process.env.ONTOINDEX_NATIVE_GRAPH_WRITER = previous;
      }

      const readArray = async (label: string, id: string, property: string): Promise<unknown> => {
        const rows = await executePrepared<{ value?: unknown }>(
          `MATCH (n:${label}) WHERE n.id = $id RETURN n.${property} AS value`,
          { id },
        );
        expect(rows).toHaveLength(1);
        return rows[0].value;
      };

      expect(await readArray('Community', ids.community, 'keywords')).toEqual(values);
      expect(await readArray('Process', ids.process, 'communities')).toEqual(values);
      for (const property of [
        'summarizedCommunityIds',
        'summarizedConceptIds',
        'summarizedNodeIds',
        'sourceDocuments',
        'sourceFactKeys',
        'resolutionKeys',
      ]) {
        expect(await readArray('SummaryNode', ids.summary, property)).toEqual(values);
      }
      for (const property of ['aliases', 'sourceDocuments', 'sourceFactKeys', 'resolutionKeys']) {
        expect(await readArray('Concept', ids.concept, property)).toEqual(values);
      }
      expect(await readArray('Route', ids.route, 'responseKeys')).toEqual(routeResponseKeys);
      expect(await readArray('Route', ids.route, 'errorKeys')).toEqual(values);
      expect(await readArray('Route', ids.route, 'middleware')).toEqual(values);
      for (const property of ['responseKeys', 'errorKeys', 'middleware']) {
        expect(await readArray('Route', ids.emptyRoute, property)).toEqual([]);
      }

      for (const probe of values) {
        const rows = await executePrepared<{ count?: unknown }>(
          'MATCH (r:Route) WHERE r.id = $id AND $probe IN r.middleware RETURN count(r) AS count',
          { id: ids.route, probe },
        );
        expect(Number(rows[0]?.count)).toBe(1);
      }
      const responseMembership = await executePrepared<{ count?: unknown }>(
        'MATCH (r:Route) WHERE r.id = $id AND $probe IN r.responseKeys RETURN count(r) AS count',
        { id: ids.route, probe: 'items' },
      );
      expect(Number(responseMembership[0]?.count)).toBe(1);
      const absentResponseMembership = await executePrepared<{ count?: unknown }>(
        'MATCH (r:Route) WHERE r.id = $id AND $probe IN r.responseKeys RETURN count(r) AS count',
        { id: ids.route, probe: 'withAuth' },
      );
      expect(Number(absentResponseMembership[0]?.count)).toBe(0);
    }
  });
});
