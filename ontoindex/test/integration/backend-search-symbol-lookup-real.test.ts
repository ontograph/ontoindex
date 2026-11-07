import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/mcp/local/backend-query.js', () => ({
  bm25Search: vi.fn(),
  semanticSearch: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-overlay.js', () => ({
  isAutomaticWorkspaceEnabled: () => false,
  getOverlaySnapshot: vi.fn(),
  getCommittedRead: vi.fn(),
}));
vi.mock('../../src/mcp/local/query-log.js', () => ({
  queryLogEnabled: () => false,
  MAX_RESULT_IDS: 10,
  MAX_QUERY_CHARS: 256,
}));

import { bm25Search, semanticSearch } from '../../src/mcp/local/backend-query.js';
import { query } from '../../src/mcp/local/backend-search.js';
import { gnSafeRefactor } from '../../src/mcp/super/safe-refactor.js';
import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';
import type { EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';

const names = ['singleton', 'noEdge', 'mixed', 'multiple', 'fanIn', 'importsFirst'];
const symbols: Array<
  Required<Pick<EnrichedSymbolRow, 'name' | 'type' | 'filePath'>> & EnrichedSymbolRow
> = names.map((name) => ({
  nodeId: `Function:${name}`,
  name,
  type: 'Function',
  filePath: `src/${name}.ts`,
  startLine: 1,
  endLine: 2,
}));
const seed = [
  ...names.map(
    (name) =>
      `CREATE (:Function {id: 'Function:${name}', name: '${name}', filePath: 'src/${name}.ts', content: '${name} body'})`,
  ),
  "CREATE (:File {id: 'File:firstImporter', name: 'firstImporter', filePath: 'src/import.ts'})",
  "CREATE (:Method {id: 'Method:laterCaller', name: 'laterCaller', filePath: 'src/method.ts'})",
  "MATCH (m:File {id: 'File:firstImporter'}), (n:Function {id: 'Function:importsFirst'}) CREATE (m)-[:CodeRelation {type: 'IMPORTS'}]->(n)",
  "MATCH (m:Method {id: 'Method:laterCaller'}), (n:Function {id: 'Function:importsFirst'}) CREATE (m)-[:CodeRelation {type: 'CALLS'}]->(n)",
  "CREATE (:Community {id: 'Community:one', heuristicLabel: 'One', cohesion: 0.2})",
  "CREATE (:Community {id: 'Community:two', heuristicLabel: 'Two', cohesion: 0.8})",
  "CREATE (:Function {id: 'Function:caller', name: 'caller', filePath: 'src/caller.ts'})",
  "CREATE (:Function {id: 'Function:importer', name: 'importer', filePath: 'src/importer.ts'})",
  "MATCH (m:Function {id: 'Function:caller'}), (n:Function {id: 'Function:singleton'}) CREATE (m)-[:CodeRelation {type: 'CALLS'}]->(n)",
  "MATCH (n:Function {id: 'Function:singleton'}), (c:Community {id: 'Community:one'}) CREATE (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c)",
  "MATCH (m:Function {id: 'Function:caller'}), (n:Function {id: 'Function:mixed'}) CREATE (m)-[:CodeRelation {type: 'REFERENCES'}]->(n)",
  "MATCH (m:Function {id: 'Function:importer'}), (n:Function {id: 'Function:mixed'}) CREATE (m)-[:CodeRelation {type: 'IMPORTS'}]->(n)",
  "MATCH (m:Function {id: 'Function:caller'}), (n:Function {id: 'Function:multiple'}) CREATE (m)-[:CodeRelation {type: 'CALLS'}]->(n)",
  "MATCH (m:Function {id: 'Function:importer'}), (n:Function {id: 'Function:multiple'}) CREATE (m)-[:CodeRelation {type: 'IMPORTS'}]->(n)",
  "MATCH (n:Function {id: 'Function:multiple'}), (c:Community) CREATE (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c)",
  "UNWIND range(1, 1000) AS i CREATE (:Function {id: 'Function:fanCaller' + cast(i AS STRING), name: 'fanCaller' + cast(i AS STRING), filePath: 'src/fan.ts'})",
  "MATCH (m:Function), (n:Function {id: 'Function:fanIn'}) WHERE m.filePath = 'src/fan.ts' CREATE (m)-[:CodeRelation {type: 'CALLS'}]->(n)",
  "UNWIND range(1, 1000) AS i CREATE (:Community {id: 'Community:fan' + cast(i AS STRING), heuristicLabel: 'Fan ' + cast(i AS STRING), cohesion: 0.3})",
  "MATCH (n:Function {id: 'Function:fanIn'}), (c:Community) WHERE c.cohesion = 0.3 CREATE (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c)",
  "CREATE (:Function {id: 'Function:sameName', name: 'singleton', filePath: 'src/other.ts'})",
  "MATCH (m:Function {id: 'Function:importer'}), (n:Function {id: 'Function:sameName'}) CREATE (m)-[:CodeRelation {type: 'IMPORTS'}]->(n)",
  "MATCH (m:Function {id: 'Function:caller'}), (n:Function {id: 'Function:multiple'}) CREATE (m)-[:CodeRelation {type: 'CALLS'}]->(n)",
  "MATCH (m:Function {id: 'Function:caller'}), (n:Function {id: 'Function:multiple'}) CREATE (m)-[:CodeRelation {type: 'IMPORTS'}]->(n)",
  "CREATE (:Function {id: 'Function:nullCaller'})",
  "CREATE (:Function {id: 'Function:nullTarget', name: 'nullTarget', filePath: 'src/null.ts'})",
  "MATCH (m:Function {id: 'Function:nullCaller'}), (n:Function {id: 'Function:nullTarget'}) CREATE (m)-[:CodeRelation {type: 'CALLS'}]->(n)",
];

withTestLbugDB(
  'search-symbol-lookup-real',
  (db) => {
    beforeEach(() => {
      vi.mocked(bm25Search).mockResolvedValue({ results: [], ftsUsed: true });
      vi.mocked(semanticSearch).mockResolvedValue(symbols);
    });

    async function search() {
      return query({ id: db.repoId, repoPath: db.tmpHandle.dbPath, lastCommit: 'test' } as any, {
        query: 'symbol lookup',
        include_content: true,
        include_skeleton: false,
        include_citations: false,
        intent_ensemble: false,
      }) as Promise<Extract<Awaited<ReturnType<typeof query>>, { query_intent: unknown }>>;
    }

    it('rejects ambiguous refactor names before writes and previews each exact UID', async () => {
      const backend = { repoPath: db.tmpHandle.dbPath, callTool: vi.fn() };
      const params = {
        intent: 'modify-body' as const,
        params: { newBody: 'return 42;' },
        preChecks: false,
      };

      await expect(
        gnSafeRefactor(
          db.repoId,
          { ...params, symbol: 'singleton', dryRun: false, confirm: true },
          backend,
        ),
      ).rejects.toThrow('Ambiguous symbol "singleton"; provide a canonical symbol UID.');
      expect(backend.callTool).not.toHaveBeenCalled();

      for (const [nodeId, filePath] of [
        ['Function:singleton', 'src/singleton.ts'],
        ['Function:sameName', 'src/other.ts'],
      ]) {
        const report = await gnSafeRefactor(db.repoId, { ...params, symbol: nodeId }, backend);
        expect(report).toMatchObject({
          symbol: { nodeId, name: 'singleton', filePath, kind: 'Function' },
          preview: { affectedFiles: [filePath] },
          applied: false,
        });
      }
      expect(backend.callTool).not.toHaveBeenCalled();
    });

    it('previews a canonical UID rename through the real lookup without changing source bytes', async () => {
      const repoPath = db.tmpHandle.dbPath;
      const sourcePath = path.join(repoPath, 'src/singleton.ts');
      const source = Buffer.from('export function singleton() { return 1; }\n');
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, source);
      const backend = { repoPath, callTool: vi.fn() };

      const report = await gnSafeRefactor(
        db.repoId,
        {
          intent: 'rename',
          symbol: 'Function:singleton',
          params: { newName: 'renamedSingleton' },
          dryRun: true,
          preChecks: false,
        },
        backend,
      );

      expect(report).toMatchObject({
        intent: 'rename',
        symbol: {
          nodeId: 'Function:singleton',
          name: 'singleton',
          filePath: 'src/singleton.ts',
          kind: 'Function',
        },
        preview: {
          affectedFiles: ['src/singleton.ts'],
          diffSummary: 'rename singleton → renamedSingleton (1 edits across 1 files)',
          estimatedLinesChanged: 1,
        },
        applied: false,
      });
      expect(await fs.readFile(sourcePath)).toEqual(source);
      expect(backend.callTool).not.toHaveBeenCalled();
    });

    it('enriches a singleton edge through the production search and real adapter', async () => {
      vi.mocked(semanticSearch).mockResolvedValue([symbols[0]]);
      const result = await search();
      expect(result.definitions).toEqual([
        expect.objectContaining({
          id: 'Function:singleton',
          module: 'One',
          content: 'singleton body',
          citation_path: 'src/caller.ts:caller -> CALLS -> singleton',
        }),
      ]);
    });

    it('keeps multiple targets isolated with absent, mixed, multiple and high fan-in edges', async () => {
      const result = await search();
      const byId = new Map(
        result.definitions.map((entry) => {
          expect(entry).toHaveProperty('id');
          const symbol = entry as { id: string; module?: string; citation_path?: string };
          return [symbol.id, symbol] as const;
        }),
      );
      expect(byId.size).toBe(names.length);
      expect(byId.get('Function:singleton')).toMatchObject({
        module: 'One',
        citation_path: 'src/caller.ts:caller -> CALLS -> singleton',
      });
      expect(byId.get('Function:noEdge')).not.toHaveProperty('module');
      expect(byId.get('Function:noEdge')).not.toHaveProperty('citation_path');
      expect(byId.get('Function:mixed')).toHaveProperty(
        'citation_path',
        'src/importer.ts:importer -> IMPORTS -> mixed',
      );
      const multiple = byId.get('Function:multiple')!;
      expect(multiple.module).toBe('One');
      expect(multiple.citation_path).toBe('src/caller.ts:caller -> CALLS -> multiple');
      expect(byId.get('Function:fanIn')!.citation_path).toBe(
        'src/fan.ts:fanCaller1 -> CALLS -> fanIn',
      );
      expect(byId.get('Function:fanIn')!.module).toBe('Fan 1');
      expect(byId.get('Function:importsFirst')!.citation_path).toBe(
        'src/import.ts:firstImporter -> IMPORTS -> importsFirst',
      );
      for (const name of names)
        expect(byId.get(`Function:${name}`)).toHaveProperty('content', `${name} body`);
    });
    it('selects the same neighbors after a non-timeout batch failure', async () => {
      const expected = await search();
      const execute = poolAdapter.executeParameterized;
      const spy = vi
        .spyOn(poolAdapter, 'executeParameterized')
        .mockImplementation(async (repoId, cypher, params) => {
          if (
            'nodeIds' in params &&
            (cypher.includes('MEMBER_OF') || cypher.includes('callerPath'))
          ) {
            throw new Error('batch unavailable');
          }
          return execute(repoId, cypher, params);
        });
      try {
        expect((await search()).definitions).toEqual(expected.definitions);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps equal names separate and omits a citation with missing caller properties', async () => {
      vi.mocked(semanticSearch).mockResolvedValue([
        symbols[0],
        { ...symbols[0], nodeId: 'Function:sameName', filePath: 'src/other.ts' },
        {
          ...symbols[0],
          nodeId: 'Function:nullTarget',
          name: 'nullTarget',
          filePath: 'src/null.ts',
        },
      ]);
      const result = await search();
      expect(result.definitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'Function:singleton',
            citation_path: 'src/caller.ts:caller -> CALLS -> singleton',
          }),
          expect.objectContaining({
            id: 'Function:sameName',
            citation_path: 'src/importer.ts:importer -> IMPORTS -> singleton',
          }),
        ]),
      );
      expect(
        result.definitions.find((entry) => 'id' in entry && entry.id === 'Function:nullTarget'),
      ).not.toHaveProperty('citation_path');
    });
    it('executes one successful query per enrichment with at most one selected neighbor per target', async () => {
      const execute = vi.spyOn(poolAdapter, 'executeParameterized');
      try {
        await search();
        expect(execute).toHaveBeenCalledTimes(4);
        for (const [, , params] of execute.mock.calls) expect(params).toHaveProperty('nodeIds');
        let checkedLookups = 0;
        for (const [index, [, cypher]] of execute.mock.calls.entries()) {
          if (!cypher.includes('MEMBER_OF') && !cypher.includes('callerPath')) continue;
          checkedLookups++;
          const rows = await execute.mock.results[index].value;
          const ids = rows.map((row: Record<string, unknown>) => row.nodeId);
          expect(ids).toContain('Function:fanIn');
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBeLessThanOrEqual(names.length);
        }
        expect(checkedLookups).toBe(2);
      } finally {
        execute.mockRestore();
      }
    });
  },
  { seed, poolAdapter: true },
);
