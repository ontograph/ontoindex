/**
 * P0 Integration Tests: Local Backend — callTool dispatch
 *
 * Tests the full LocalBackend.callTool() dispatch with a real LadybugDB
 * instance, verifying cypher, context, impact, and query tools work
 * end-to-end against seeded graph data with FTS indexes.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  LOCAL_BACKEND_SEED_DATA,
  LOCAL_BACKEND_FTS_INDEXES,
} from '../fixtures/local-backend-seed.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// ─── Block 2: callTool dispatch tests ────────────────────────────────

withTestLbugDB(
  'local-backend-calltool',
  (handle) => {
    describe('callTool dispatch with real DB', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        // backend is created in afterSetup and attached to the handle
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('cypher tool returns function names', async () => {
        const result = await backend.callTool('cypher', {
          query: 'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name LIMIT 100',
        });
        // cypher tool wraps results as markdown
        expect(result).toHaveProperty('markdown');
        expect(result).toHaveProperty('row_count');
        expect(result.row_count).toBeGreaterThanOrEqual(3);
        expect(result.markdown).toContain('login');
        expect(result.markdown).toContain('validate');
        expect(result.markdown).toContain('hash');
      });

      it('cypher tool blocks write queries', async () => {
        const result = await backend.callTool('cypher', {
          query:
            "CREATE (n:Function {id: 'x', name: 'x', filePath: '', startLine: 0, endLine: 0, isExported: false, content: '', description: ''})",
        });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/write operations/i);
      });

      it('context tool returns symbol info with callers and callees', async () => {
        const result = await backend.callTool('context', { name: 'login' });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('found');
        // Should have the symbol identity
        expect(result.symbol).toBeDefined();
        expect(result.symbol.name).toBe('login');
        expect(result.symbol.filePath).toBe('src/auth.ts');
        // login calls validate and hash — should appear in outgoing.calls
        expect(result.outgoing).toBeDefined();
        expect(result.outgoing.calls).toBeDefined();
        expect(result.outgoing.calls.length).toBeGreaterThanOrEqual(2);
        const calleeNames = result.outgoing.calls.map((c: any) => c.name);
        expect(calleeNames).toContain('validate');
        expect(calleeNames).toContain('hash');
      });

      it('impact tool returns upstream dependents', async () => {
        const result = await backend.callTool('impact', {
          target: 'validate',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        // validate is called by login, so login should appear at depth 1
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        expect(result.byDepth).toBeDefined();
        const directDeps = result.byDepth[1] || result.byDepth['1'] || [];
        expect(directDeps.length).toBeGreaterThanOrEqual(1);
        const depNames = directDeps.map((d: any) => d.name);
        expect(depNames).toContain('login');
      });

      it('query tool returns results for keyword search', async () => {
        const result = await backend.callTool('query', { query: 'login' });
        expect(result).not.toHaveProperty('error');
        // Should have some combination of processes, process_symbols, or definitions
        expect(result).toHaveProperty('processes');
        expect(result).toHaveProperty('definitions');
        // The search should find something (FTS or graph-based)
        const totalResults =
          (result.processes?.length || 0) +
          (result.process_symbols?.length || 0) +
          (result.definitions?.length || 0);
        expect(totalResults).toBeGreaterThanOrEqual(1);

        // #553: query response carries per-phase timing metadata.
        expect(result.timing).toBeDefined();
        expect(typeof result.timing.wall).toBe('number');
        expect(result.timing.wall).toBeGreaterThanOrEqual(0);
        // At least one of the search phases must have fired for any
        // non-error response — bm25 and/or vector always runs.
        expect(result.timing.bm25 ?? result.timing.vector).toBeGreaterThanOrEqual(0);
      });

      it('tech_debt tool initializes the DB-backed path and returns symbols', async () => {
        const result = await backend.callTool('tech_debt', { since: '10 years', limit: 5 });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('success');
        expect(result.symbol_count).toBeGreaterThanOrEqual(1);
        expect(result.symbols.length).toBeGreaterThanOrEqual(1);
      });

      it('ipc_trace tool initializes the DB-backed path before tracing', async () => {
        const result = await backend.callTool('ipc_trace', { symbol_name: 'login' });
        expect(result.error ?? '').not.toMatch(/LadybugDB not initialized/i);
        expect(result.status).toBe('success');
        expect(result.flow_count).toBeGreaterThanOrEqual(0);
      });

      it('impact_batch tool initializes the DB-backed path before aggregating impact', async () => {
        const result = await backend.callTool('impact_batch', {
          targets: ['validate', 'hash'],
          direction: 'upstream',
          maxDepth: 3,
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toMatch(/LadybugDB not initialized/i);
        expect(result.status).toBe('success');
        expect(result.perSymbol).toHaveLength(2);
        expect(result.union.totalAffectedNodes).toBeGreaterThanOrEqual(1);
      });

      it('cycle_detect tool initializes the DB-backed path and reports cycles', async () => {
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.executeQuery(
          `CREATE (a:File {id: 'file:src/cycle-a.ts', name: 'cycle-a.ts', filePath: 'src/cycle-a.ts', content: ''})`,
        );
        await adapter.executeQuery(
          `CREATE (b:File {id: 'file:src/cycle-b.ts', name: 'cycle-b.ts', filePath: 'src/cycle-b.ts', content: ''})`,
        );
        await adapter.executeQuery(`
          MATCH (a:File), (b:File)
          WHERE a.id = 'file:src/cycle-a.ts' AND b.id = 'file:src/cycle-b.ts'
          CREATE (a)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'import', step: 0}]->(b)
        `);
        await adapter.executeQuery(`
          MATCH (a:File), (b:File)
          WHERE a.id = 'file:src/cycle-b.ts' AND b.id = 'file:src/cycle-a.ts'
          CREATE (a)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'import', step: 0}]->(b)
        `);

        const result = await backend.callTool('cycle_detect', {
          edge_types: ['IMPORTS'],
          file_filter: 'src/cycle-*.ts',
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toMatch(/LadybugDB not initialized/i);
        expect(result.status).toBe('success');
        expect(result.summary.total_cycles).toBe(1);
        expect(result.cycles[0].members).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ filePath: 'src/cycle-a.ts', kind: 'File' }),
            expect.objectContaining({ filePath: 'src/cycle-b.ts', kind: 'File' }),
          ]),
        );
      });

      it('coupling_matrix tool initializes the DB-backed path and reports module metrics', async () => {
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.executeQuery(
          `CREATE (comm:Community {id: 'comm:utils', heuristicLabel: 'Utilities', symbolCount: 6})`,
        );
        await adapter.executeQuery(`
          MATCH (n:Function), (c:Community)
          WHERE n.id = 'func:hash' AND c.id = 'comm:utils'
          CREATE (n)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)
        `);

        const result = await backend.callTool('coupling_matrix', {
          min_symbols: 1,
          include_cross_edges: true,
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toMatch(/LadybugDB not initialized/i);
        expect(result.status).toBe('success');
        expect(result.summary.module_count).toBeGreaterThanOrEqual(2);
        expect(result.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ community: 'Authentication' }),
            expect.objectContaining({ community: 'Utilities' }),
          ]),
        );
      });

      it('migration_progress tool reports remaining old-pattern files', async () => {
        await fs.mkdir(path.join(handle.tmpHandle.dbPath, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(handle.tmpHandle.dbPath, 'src', 'migration.ts'),
          [
            'setTimeout(() => work(), 100);',
            'timerRegistry.setTimeout(() => work(), 100);',
            'setTimeout(() => workMore(), 100);',
          ].join('\n'),
          'utf8',
        );

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.executeQuery(
          `CREATE (fn:Function {id: 'func:migrateTimers', name: 'migrateTimers', filePath: 'src/migration.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
        );
        await adapter.executeQuery(`
          MATCH (n:Function), (c:Community)
          WHERE n.id = 'func:migrateTimers' AND c.id = 'comm:auth'
          CREATE (n)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: '', step: 0}]->(c)
        `);

        const result = await backend.callTool('migration_progress', {
          old_pattern: '\\bsetTimeout\\s*\\(',
          new_pattern: 'timerRegistry\\.setTimeout\\s*\\(',
          file_glob: 'src/migration.ts',
        });
        expect(result.status).toBe('success');
        expect(result.summary.total_old_sites).toBe(2);
        expect(result.summary.total_new_sites).toBe(1);
        expect(result.remaining_files[0].file).toBe('src/migration.ts');
      });

      it('boundary_violations tool reports forbidden import edges', async () => {
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.executeQuery(
          `CREATE (a:File {id: 'file:browser/index.ts', name: 'index.ts', filePath: 'browser/index.ts', content: ''})`,
        );
        await adapter.executeQuery(
          `CREATE (b:File {id: 'file:wsd/client.ts', name: 'client.ts', filePath: 'wsd/client.ts', content: ''})`,
        );
        await adapter.executeQuery(`
          MATCH (a:File), (b:File)
          WHERE a.id = 'file:browser/index.ts' AND b.id = 'file:wsd/client.ts'
          CREATE (a)-[:CodeRelation {type: 'IMPORTS', confidence: 1.0, reason: 'import', step: 0}]->(b)
        `);

        const result = await backend.callTool('boundary_violations', {
          rules: [{ from: 'browser/**', to: 'wsd/**', label: 'browser -> wsd' }],
        });
        expect(result.status).toBe('success');
        expect(result.summary.total_violations).toBe(1);
        expect(result.violations[0]).toMatchObject({
          rule_label: 'browser -> wsd',
          source_file: 'browser/index.ts',
          target_file: 'wsd/client.ts',
        });
      });

      it('type_coverage tool ranks unsafe syntax by enclosing caller count', async () => {
        await fs.mkdir(path.join(handle.tmpHandle.dbPath, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(handle.tmpHandle.dbPath, 'src', 'types.ts'),
          [
            'export function risky(input: any) {',
            '  // @ts-ignore',
            '  const narrowed = input as User;',
            '  return input!.name + narrowed.name;',
            '}',
          ].join('\n'),
          'utf8',
        );
        await fs.writeFile(
          path.join(handle.tmpHandle.dbPath, 'src', 'caller.ts'),
          'export function caller() { return risky({}); }\n',
          'utf8',
        );

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.executeQuery(
          `CREATE (fn:Function {id: 'func:risky', name: 'risky', filePath: 'src/types.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
        );
        await adapter.executeQuery(
          `CREATE (fn:Function {id: 'func:caller', name: 'caller', filePath: 'src/caller.ts', startLine: 1, endLine: 1, isExported: true, content: '', description: ''})`,
        );
        await adapter.executeQuery(`
          MATCH (a:Function), (b:Function)
          WHERE a.id = 'func:caller' AND b.id = 'func:risky'
          CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)
        `);

        const result = await backend.callTool('type_coverage', {
          file_glob: 'src/types.ts',
          patterns: ['explicit_any', 'type_suppression', 'unsafe_cast', 'non_null_assertion'],
          limit: 10,
        });
        expect(result.status).toBe('success');
        expect(result.result_count).toBeGreaterThanOrEqual(4);
        expect(result.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ pattern_type: 'explicit_any', enclosing_symbol: 'risky' }),
            expect.objectContaining({
              pattern_type: 'type_suppression',
              enclosing_symbol: 'risky',
            }),
            expect.objectContaining({ pattern_type: 'unsafe_cast', enclosing_symbol: 'risky' }),
            expect.objectContaining({
              pattern_type: 'non_null_assertion',
              enclosing_symbol: 'risky',
            }),
          ]),
        );
      });

      it('analysis_catalog tool discovers local pack manifests', async () => {
        const repoRoot = handle.tmpHandle.dbPath;
        await fs.mkdir(path.join(repoRoot, 'ontoindex-packs/core/demo-pack'), { recursive: true });
        await fs.mkdir(path.join(repoRoot, 'ontoindex-packs/suites/demo-suite'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(repoRoot, 'ontoindex-packs/core/demo-pack/pack.yml'),
          [
            'schema: 1',
            'id: demo.pack',
            'name: Demo Pack',
            'version: 0.1.0',
            'kind: query',
            'tier: stable',
            'summary: Demo pack.',
          ].join('\n'),
          'utf8',
        );
        await fs.writeFile(
          path.join(repoRoot, 'ontoindex-packs/suites/demo-suite/suite.yml'),
          [
            'schema: 1',
            'id: suite.demo',
            'name: Demo Suite',
            'tier: stable',
            'summary: Demo suite.',
            'packs:',
            '  - demo.pack',
          ].join('\n'),
          'utf8',
        );

        const result = await backend.callTool('analysis_catalog', { tier: 'stable' });
        expect(result.status).toBe('success');
        expect(result.packs.some((pack: any) => pack.id === 'demo.pack')).toBe(true);
        expect(result.suites.some((suite: any) => suite.id === 'suite.demo')).toBe(true);
      });

      it('graph_diff tool initializes the DB-backed path when a snapshot exists', async () => {
        const snapshotPath = path.join(handle.tmpHandle.dbPath, 'snapshot.json');
        await fs.writeFile(
          snapshotPath,
          JSON.stringify({
            lastCommit: 'abc123',
            savedAt: '2026-04-23T00:00:00Z',
            calleesMap: {
              'func:login': ['func:validate'],
            },
            fileToSymbols: {
              'src/auth.ts': ['func:login', 'func:validate'],
            },
          }),
          'utf8',
        );

        const result = await backend.callTool('graph_diff', { limit: 5 });
        expect(result.error ?? '').not.toMatch(/LadybugDB not initialized/i);
        expect(result.status).toBe('success');
        expect(result.snapshot_present).toBe(true);
      });

      it('unknown tool throws', async () => {
        await expect(backend.callTool('nonexistent_tool', {})).rejects.toThrow(/unknown tool/i);
      });
    });

    describe('impact tool relationTypes filtering', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('filters by HAS_METHOD only', async () => {
        const result = await backend.callTool('impact', {
          target: 'AuthService',
          direction: 'downstream',
          relationTypes: ['HAS_METHOD'],
        });
        expect(result).not.toHaveProperty('error');
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);
        expect(names).toContain('authenticate');
        // Should NOT include CALLS-reachable symbols like validate/hash
        expect(names).not.toContain('validate');
        expect(names).not.toContain('hash');
      });

      it('filters by OVERRIDES only', async () => {
        // The seed has two Method nodes named 'authenticate' (AuthService's
        // override and BaseService's base). Per #470, `impact` now returns
        // a ranked-ambiguous response when the target name hits multiple
        // symbols, so we must disambiguate with file_path to get the
        // AuthService override (the one with the outgoing METHOD_OVERRIDES
        // edge we want to follow downstream).
        const result = await backend.callTool('impact', {
          target: 'authenticate',
          file_path: 'src/auth.ts',
          direction: 'downstream',
          relationTypes: ['METHOD_OVERRIDES'],
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).not.toBe('ambiguous');
        // AuthService.authenticate overrides BaseService.authenticate
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);
        expect(names).toContain('authenticate');
      });

      it('expands legacy OVERRIDES to include METHOD_OVERRIDES (dual-read)', async () => {
        // Pass the LEGACY alias 'OVERRIDES' — impactByUid should flatMap-expand
        // it to ['OVERRIDES', 'METHOD_OVERRIDES'] so the METHOD_OVERRIDES edge
        // between BaseService.authenticate and AuthService.authenticate is found.
        // file_path hint disambiguates the two 'authenticate' methods per #470.
        const result = await backend.callTool('impact', {
          target: 'authenticate',
          file_path: 'src/auth.ts',
          direction: 'downstream',
          relationTypes: ['OVERRIDES'],
        });
        expect(result).not.toHaveProperty('error');
        expect(result.status).not.toBe('ambiguous');
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        const d1 = result.byDepth[1] || result.byDepth['1'] || [];
        const names = d1.map((d: any) => d.name);
        expect(names).toContain('authenticate');
      });

      it('does not return HAS_METHOD results when filtering by CALLS only', async () => {
        const result = await backend.callTool('impact', {
          target: 'AuthService',
          direction: 'downstream',
          relationTypes: ['CALLS'],
        });
        expect(result).not.toHaveProperty('error');
        // AuthService has no outgoing CALLS edges, only HAS_METHOD
        expect(result.impactedCount).toBe(0);
      });
    });

    describe('tool parameter edge cases', () => {
      let backend: LocalBackend;

      beforeAll(async () => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) {
          throw new Error(
            'LocalBackend not initialized — afterSetup did not attach _backend to handle',
          );
        }
        backend = ext._backend;
      });

      it('context tool returns error for nonexistent symbol', async () => {
        const result = await backend.callTool('context', { name: 'nonexistent_xyz_symbol_999' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/not found/i);
      });

      it('query tool returns error for empty query', async () => {
        const result = await backend.callTool('query', { query: '' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/required/i);
      });

      it('query tool returns error for missing query param', async () => {
        const result = await backend.callTool('query', {});
        expect(result).toHaveProperty('error');
      });

      it('cypher tool returns error for invalid Cypher syntax', async () => {
        const result = await backend.callTool('cypher', {
          query: 'THIS IS NOT VALID CYPHER AT ALL LIMIT 1',
        });
        expect(result).toHaveProperty('error');
      });

      it('context tool returns error when no name or uid provided', async () => {
        const result = await backend.callTool('context', {});
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/required/i);
      });

      // ─── impact error handling tests (#321) ───────────────────────────
      // Verify that impact() returns structured JSON instead of crashing

      it('impact tool returns structured error for unknown symbol', async () => {
        const result = await backend.callTool('impact', {
          target: 'nonexistent_symbol_xyz_999',
          direction: 'upstream',
        });
        // Must return structured JSON, not throw
        expect(result).toBeDefined();
        // Should have either an error field (not found) or impactedCount 0
        // Either outcome is valid — the key is it doesn't crash
        if (result.error) {
          expect(typeof result.error).toBe('string');
        } else {
          expect(result.impactedCount).toBe(0);
        }
      });

      it('impact error response has consistent target shape', async () => {
        const result = await backend.callTool('impact', {
          target: 'nonexistent_symbol_xyz_999',
          direction: 'downstream',
        });
        // When an error is returned, target must be an object (not raw string)
        // so downstream API consumers can safely access result.target.name
        if (result.error && result.target !== undefined) {
          expect(typeof result.target).toBe('object');
          expect(result.target).not.toBeNull();
        }
      });

      it('impact partial results: traversalComplete flag when depth fails', async () => {
        // Even if traversal fails at some depth, partial results should be returned
        // and partial:true should only be set when some results were collected
        const result = await backend.callTool('impact', {
          target: 'validate',
          direction: 'upstream',
          maxDepth: 10, // Large depth to trigger multi-level traversal
        });
        // Should succeed (validate exists in seed data)
        expect(result).not.toHaveProperty('error');
        if (result.partial) {
          // If partial, must still have some results
          expect(result.impactedCount).toBeGreaterThan(0);
        }
      });
    });
  },
  {
    seed: LOCAL_BACKEND_SEED_DATA,
    ftsIndexes: LOCAL_BACKEND_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      // Configure listRegisteredRepos mock with handle values
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: handle.tmpHandle.dbPath,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
        },
      ]);

      const backend = new LocalBackend();
      await backend.init();
      // Stash backend on handle so tests can access it
      (handle as any)._backend = backend;
    },
  },
);
