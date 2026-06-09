import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  walkRepositoryPaths,
  readFileContents,
} from '../../src/core/ingestion/filesystem-walker.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSymbolTable } from '../../src/core/ingestion/model/symbol-table.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

// ============================================================================
// E2E: .gitignore + .ontoindexignore + unsupported language skip
// ============================================================================

describe('ignore + language-skip E2E', () => {
  let tmpDir: string;
  let originalScanMaxFileKb: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-e2e-ignore-skip-'));

    // Create directory structure
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'vendor'), { recursive: true });

    // .gitignore — excludes data/ and *.log
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'data/\n*.log\n');

    // .ontoindexignore — excludes vendor/
    await fs.writeFile(path.join(tmpDir, '.ontoindexignore'), 'vendor/\n');

    // Source files (should be indexed)
    await fs.writeFile(
      path.join(tmpDir, 'src', 'index.ts'),
      "import { greet } from './greet';\n\nexport function main(): string {\n  return greet();\n}\n",
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'greet.ts'),
      "export function greet(): string {\n  return 'hello';\n}\n",
    );

    // Swift file — triggers language skip when grammar unavailable
    await fs.writeFile(
      path.join(tmpDir, 'src', 'App.swift'),
      'class App {\n    func run() {\n        print("running")\n    }\n}\n',
    );

    // Files that should be excluded
    await fs.writeFile(path.join(tmpDir, 'data', 'seed.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'vendor', 'lib.js'), 'var x = 1;\n');
    await fs.writeFile(path.join(tmpDir, 'debug.log'), 'debug log entry\n');
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  beforeEach(() => {
    originalScanMaxFileKb = process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
  });

  afterEach(() => {
    if (originalScanMaxFileKb === undefined) delete process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
    else process.env.ONTOINDEX_SCAN_MAX_FILE_KB = originalScanMaxFileKb;
  });

  // ── File Discovery ──────────────────────────────────────────────────

  describe('file discovery (walkRepositoryPaths)', () => {
    it('includes source files from src/', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('src/greet.ts');
    });

    it('includes .swift files (discovery does not filter by language)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      // Swift file should be discovered — language skip happens at parse time
      expect(paths).toContain('src/App.swift');
    });

    it('excludes gitignored directories (data/)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths.every((p) => !p.includes('data/'))).toBe(true);
    });

    it('excludes gitignored file patterns (*.log)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths.every((p) => !p.endsWith('.log'))).toBe(true);
    });

    it('excludes ontoindexignored directories (vendor/)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths.every((p) => !p.includes('vendor/'))).toBe(true);
    });

    it('reports files skipped by the large-file discovery cap', async () => {
      process.env.ONTOINDEX_SCAN_MAX_FILE_KB = '512';
      await fs.writeFile(path.join(tmpDir, 'src', 'huge.js'), 'x'.repeat(513 * 1024));
      const skipped: { path: string; size: number }[] = [];

      const files = await walkRepositoryPaths(tmpDir, undefined, {
        onSkippedLargeFile: (file) => skipped.push(file),
      });
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths).not.toContain('src/huge.js');
      expect(skipped).toEqual([
        {
          path: 'src/huge.js',
          size: 513 * 1024,
        },
      ]);
    });

    it('can disable the large-file discovery cap for full-fidelity runs', async () => {
      process.env.ONTOINDEX_SCAN_MAX_FILE_KB = '0';
      await fs.writeFile(path.join(tmpDir, 'src', 'huge.js'), 'x'.repeat(513 * 1024));
      const skipped: { path: string; size: number }[] = [];

      const files = await walkRepositoryPaths(tmpDir, undefined, {
        onSkippedLargeFile: (file) => skipped.push(file),
      });
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths).toContain('src/huge.js');
      expect(skipped).toEqual([]);
    });
  });

  // ── Parsing ─────────────────────────────────────────────────────────

  describe('parsing (processParsing)', () => {
    it('parses TypeScript files into graph nodes and skips Swift gracefully', async () => {
      // Phase 1: discover files
      const scannedFiles = await walkRepositoryPaths(tmpDir);
      const relativePaths = scannedFiles.map((f) => f.path);

      // Phase 2: read contents
      const contentMap = await readFileContents(tmpDir, relativePaths);
      const files = Array.from(contentMap.entries()).map(([p, content]) => ({
        path: p,
        content,
      }));

      // Phase 3: parse (sequential — no worker pool)
      const graph = createKnowledgeGraph();
      const symbolTable = createSymbolTable();
      const astCache = createASTCache();

      // Should NOT throw even if Swift grammar is unavailable
      await processParsing(graph, files, symbolTable, astCache);

      // TypeScript files should produce Function nodes
      const nodes = graph.nodes;
      const functionNodes = nodes.filter((n) => n.label === 'Function');
      const functionNames = functionNodes.map((n) => n.properties.name);

      expect(functionNames).toContain('main');
      expect(functionNames).toContain('greet');

      // Function nodes should reference the correct source files
      const fnFilePaths = functionNodes.map((n) =>
        (n.properties.filePath as string).replace(/\\/g, '/'),
      );
      expect(fnFilePaths.some((p) => p.includes('index.ts'))).toBe(true);
      expect(fnFilePaths.some((p) => p.includes('greet.ts'))).toBe(true);

      // Swift behavior depends on grammar availability
      if (!isLanguageAvailable(SupportedLanguages.Swift)) {
        // No Swift-sourced nodes should appear in the graph
        const swiftNodes = nodes.filter((n) =>
          (n.properties.filePath as string | undefined)?.endsWith('.swift'),
        );
        expect(swiftNodes).toHaveLength(0);
      }
      // If Swift IS available, Swift nodes may appear — that's fine
    });
  });
});
