import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import { executeQuery } from '../../src/core/lbug/lbug-adapter.js';
import { extractFunction } from '../../src/mcp/local/backend-extract-function.js';
import { moveSymbol } from '../../src/mcp/local/backend-move-symbol.js';
import { replaceSymbol, updateSymbolBody } from '../../src/mcp/local/backend-symbol-mutations.js';
import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const cases = [
  { label: 'row zero', prefix: '', declaration: 'export function target() {\n  return 1;\n}' },
  {
    label: 'prefixed declaration',
    prefix: '// prefix\nconst untouched = 7;\n',
    declaration: 'export function target() {\n  return 1;\n}',
  },
  {
    label: 'multiline export wrapper',
    prefix: '// prefix\n',
    declaration: 'export default\nfunction target() {\n  return 1;\n}',
  },
  {
    label: 'same-line neighbor',
    prefix: '',
    declaration: 'function target() { return 1; } const other = 2;',
  },
  {
    label: 'multiline named export',
    prefix: '',
    declaration: 'export\nfunction target() {\n  return 1;\n}',
  },
];

withTestLbugDB(
  'mutation-indexed-ranges',
  (db) => {
    async function fixture(index: number) {
      const { prefix, declaration } = cases[index];
      const filePath = `range-${index}.ts`;
      const suffix = '\n// suffix\n';
      const source = prefix + declaration + suffix;
      const repo = { id: db.repoId, repoPath: db.tmpHandle.dbPath };
      await fs.writeFile(path.join(repo.repoPath, filePath), source);
      const graph = createKnowledgeGraph();
      const cache = createASTCache();
      try {
        await processParsing(
          graph,
          [{ path: filePath, content: source }],
          createSemanticModel().symbols,
          cache,
        );
      } finally {
        cache.clear();
      }
      const parsed = graph.nodes.find(
        (node) => node.label === 'Function' && node.properties.name === 'target',
      );
      expect(parsed).toBeDefined();
      if (!parsed) throw new Error('Parser did not produce target');
      const { startLine, endLine } = parsed.properties;
      const declarationStart = prefix.split('\n').length - 1;
      expect(startLine).toBeGreaterThanOrEqual(declarationStart);
      expect(startLine).toBeLessThanOrEqual(declarationStart + ([2, 4].includes(index) ? 1 : 0));
      expect(endLine).toBe(declarationStart + declaration.split('\n').length - 1);
      // Persist the actual parser output, never a separately authored range.
      const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
      await executeQuery(`MATCH (n:Function) WHERE n.id = ${quoted(parsed.id)} DETACH DELETE n`);
      await executeQuery(
        `CREATE (n:Function {id: ${quoted(parsed.id)}, name: 'target', filePath: ${quoted(filePath)}, startLine: ${startLine}, endLine: ${endLine}})`,
      );
      const resolved = await resolveSymbolCandidates(repo, { uid: parsed.id }, {});
      expect(resolved).toMatchObject({
        kind: 'ok',
        symbol: { id: parsed.id, startLine, endLine },
      });
      return { repo, uid: parsed.id, filePath, prefix, declaration, suffix, source };
    }

    it.each(cases.slice(0, 3).map(({ label }, index) => ({ label, index })))(
      'uses parsed and stored ranges for replacement and extraction: $label',
      async ({ index }) => {
        const { repo, uid, filePath, source, prefix, suffix } = await fixture(index);
        for (const new_body of ['return 2;', '']) {
          expect(await replaceSymbol(repo, { uid, new_body, dry_run: true }, false)).toEqual({
            success: true,
            dry_run: true,
            uid,
          });
        }
        const extracted = await extractFunction(repo, { uid, new_name: 'helper' });
        expect(extracted).toMatchObject({ success: true, dry_run: true });
        expect(extracted.preview).toContain('function helper()');
        expect(extracted.preview?.startsWith(prefix)).toBe(true);
        expect(extracted.preview?.endsWith(suffix)).toBe(true);
        expect(await fs.readFile(path.join(repo.repoPath, filePath), 'utf8')).toBe(source);
      },
    );

    it.each(
      [2, 3, 4].flatMap((index) =>
        (['update', 'move'] as const).map((operation) => ({
          index,
          operation,
          label: cases[index].label,
        })),
      ),
    )(
      'refuses partial line-based $operation for $label before writes',
      async ({ index, operation }) => {
        const { repo, uid, filePath, source } = await fixture(index);
        const target_file = `unchanged-${index}.ts`;
        const target = path.join(repo.repoPath, target_file);
        await fs.writeFile(target, '// preserve destination\n');
        const mutation =
          operation === 'move'
            ? moveSymbol(repo, { uid, target_file, dry_run: false, confirm: true })
            : updateSymbolBody(
                repo,
                { uid, new_body: '', dry_run: false, confirm: true },
                true,
                async () => {},
              );
        await expect(mutation).rejects.toThrow('one complete top-level declaration');
        expect(await fs.readFile(path.join(repo.repoPath, filePath), 'utf8')).toBe(source);
        expect(await fs.readFile(target, 'utf8')).toBe('// preserve destination\n');
      },
    );

    it.each(['update', 'move'] as const)(
      'uses stored inclusive endpoints for %s and retains returned line conventions',
      async (operation) => {
        const { repo, uid, filePath, prefix, declaration, suffix } = await fixture(1);
        if (operation === 'update') {
          expect(
            await updateSymbolBody(
              repo,
              { uid, new_body: 'replacement', dry_run: false, confirm: true },
              true,
              async () => {},
            ),
          ).toEqual({ success: true, uid, filePath, startLine: 3, endLine: 5 });
          expect(await fs.readFile(path.join(repo.repoPath, filePath), 'utf8')).toBe(
            prefix + 'replacement' + suffix,
          );
        } else {
          const target_file = 'moved.ts';
          await fs.writeFile(path.join(repo.repoPath, target_file), '// destination\n');
          expect(
            await moveSymbol(repo, { uid, target_file, dry_run: false, confirm: true }),
          ).toEqual({ success: true, uid, from: filePath, to: target_file, movedLines: 3 });
          expect(await fs.readFile(path.join(repo.repoPath, filePath), 'utf8')).toBe(
            prefix + suffix.slice(1),
          );
          expect(await fs.readFile(path.join(repo.repoPath, target_file), 'utf8')).toBe(
            '// destination\n\n' + declaration + '\n',
          );
        }
      },
    );

    it('refuses a shifted source with stale stored ranges before replacement writes', async () => {
      const { repo, uid, filePath, source } = await fixture(0);
      const shifted = '// inserted after indexing\n' + source;
      await fs.writeFile(path.join(repo.repoPath, filePath), shifted);
      for (const dry_run of [true, false]) {
        await expect(
          replaceSymbol(repo, { uid, new_body: 'return 2;', dry_run, confirm: true }, true),
        ).rejects.toThrow('Stale range');
      }
      expect(await fs.readFile(path.join(repo.repoPath, filePath), 'utf8')).toBe(shifted);
    });
  },
  { poolAdapter: true },
);
