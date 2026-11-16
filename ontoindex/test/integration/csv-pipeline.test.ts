/**
 * P1 Integration Tests: CSV Pipeline
 *
 * Tests: streamAllCSVsToDisk with real graph data.
 * Covers hardening fixes: LRU cache (#24), BufferedCSVWriter flush
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import type { CsvRowWriterFactory } from '../../src/core/lbug/csv-row-writer.js';

let tmpHandle: TestDBHandle;
let csvDir: string;
let repoDir: string;

beforeAll(async () => {
  tmpHandle = await createTempDir('csv-pipeline-test-');
  csvDir = path.join(tmpHandle.dbPath, 'csv');
  repoDir = path.join(tmpHandle.dbPath, 'repo');

  // Create a fake repo directory with source files
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, 'src', 'index.ts'),
    'export function main() {\n  console.log("hello");\n  helper();\n}\n\nexport class App {\n  run() {}\n}\n',
  );
  await fs.writeFile(
    path.join(repoDir, 'src', 'utils.ts'),
    'export function helper() {\n  return 42;\n}\n',
  );
});

afterAll(async () => {
  try {
    await tmpHandle.cleanup();
  } catch {
    /* best-effort */
  }
});

describe('streamAllCSVsToDisk', () => {
  it.each([
    ['ascii', 'a'.repeat(10_000)],
    ['cjk', '漢'.repeat(10_000)],
    ['emoji-cut', 'a'.repeat(999) + '😀'.repeat(5_000)],
    ['emoji-overflow', 'a'.repeat(1000) + '😀'.repeat(5_000)],
    ['bom', '\ufeff' + 'a'.repeat(10_000)],
  ])('matches full-read truncation for a large %s file', async (name, content) => {
    const filePath = `src/prefix-${name}.ts`;
    await fs.writeFile(path.join(repoDir, filePath), content);
    const graph = buildTestGraph([{ id: 'file:prefix', label: 'File', name, filePath }]);
    vi.stubEnv('ONTOINDEX_MAX_FILE_CONTENT_CHARS', '1000');
    try {
      const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
      const lastCode = content.charCodeAt(999);
      const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? 999 : 1000;
      const expected = content.slice(0, end) + '\n... [File content truncated]';
      await expect(fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8')).resolves.toBe(
        `id,name,filePath,content\n"file:prefix","${name}","${filePath}","${expected}"\n`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('preserves emoji in File content', async () => {
    const content = 'before😀after';
    await fs.writeFile(path.join(repoDir, 'src', 'emoji.ts'), content);
    const graph = buildTestGraph([
      { id: 'file:emoji', label: 'File', name: 'emoji.ts', filePath: 'src/emoji.ts' },
    ]);
    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    await expect(fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8')).resolves.toBe(
      `id,name,filePath,content\n"file:emoji","emoji.ts","src/emoji.ts","${content}"\n`,
    );
  });

  it('writes files above the cache budget and snippets past the File content cap', async () => {
    const prefix = 'a'.repeat(4 * 1024 * 1024 + 1);
    const tail = 'export function lateSymbol() {}';
    const content = `${prefix}\n\n\n\n${tail}`;
    await fs.writeFile(path.join(repoDir, 'src', 'oversized.ts'), content);
    const graph = buildTestGraph([
      { id: 'file:large', label: 'File', name: 'oversized.ts', filePath: 'src/oversized.ts' },
      {
        id: 'func:late',
        label: 'Function',
        name: 'lateSymbol',
        filePath: 'src/oversized.ts',
        startLine: 5,
        endLine: 5,
      },
    ]);
    vi.stubEnv('ONTOINDEX_MAX_FILE_CONTENT_CHARS', '64');
    try {
      const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
      await expect(fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8')).resolves.toBe(
        `id,name,filePath,content\n"file:large","oversized.ts","src/oversized.ts","${prefix.slice(0, 64)}\n... [File content truncated]"\n`,
      );
      const functionCsv = await fs.readFile(result.nodeFiles.get('Function')!.csvPath, 'utf-8');
      expect(functionCsv).toContain(`"\n${tail}"`);
      vi.stubEnv('ONTOINDEX_MAX_FILE_CONTENT_CHARS', '0');
      const fullResult = await streamAllCSVsToDisk(graph, repoDir, csvDir);
      await expect(fs.readFile(fullResult.nodeFiles.get('File')!.csvPath, 'utf-8')).resolves.toBe(
        `id,name,filePath,content\n"file:large","oversized.ts","src/oversized.ts","${content}"\n`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['default settings', undefined, 1],
    ['a zero content limit', '0', 1],
    ['a large graph', undefined, 25_001],
  ] as const)('preserves full File content with %s', async (_name, fileLimit, nodeCount) => {
    const sourceContent = `export const longValue = '${'a'.repeat(12_000)}';\n`;
    await fs.writeFile(path.join(repoDir, 'src', 'long.ts'), sourceContent);
    const graph = buildTestGraph([
      { id: 'file:src/long.ts', label: 'File', name: 'long.ts', filePath: 'src/long.ts' },
    ]);
    vi.stubEnv('ONTOINDEX_MAX_FILE_CONTENT_CHARS', fileLimit);
    try {
      const result = await streamAllCSVsToDisk({ ...graph, nodeCount }, repoDir, csvDir);
      await expect(fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8')).resolves.toBe(
        `id,name,filePath,content\n"file:src/long.ts","long.ts","src/long.ts","${sourceContent}"\n`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('caps File content while preserving short, exact-cap, and binary files', async () => {
    const marker = '\n... [File content truncated]';
    const fixtures = [
      { name: 'large.ts', content: '"'.repeat(80), expected: '""'.repeat(64) + marker },
      { name: 'small.ts', content: 'short file', expected: 'short file' },
      { name: 'exact.ts', content: 'e'.repeat(64), expected: 'e'.repeat(64) },
      {
        name: 'surrogate.ts',
        content: 's'.repeat(63) + '😀tail',
        expected: 's'.repeat(63) + marker,
      },
      {
        name: 'binary.ts',
        content: '\0'.repeat(80),
        expected: '[Binary file - content not stored]',
      },
      {
        // Over the prefix-read threshold: binary bytes after the cap must still be detected.
        name: 'late-binary.ts',
        content: 'p'.repeat(70) + '\0'.repeat(900) + 'x'.repeat(4000),
        expected: '[Binary file - content not stored]',
      },
    ];
    const graph = buildTestGraph(
      fixtures.map(({ name }) => ({
        id: `file:src/${name}`,
        label: 'File',
        name,
        filePath: `src/${name}`,
      })),
    );
    for (const { name, content } of fixtures) {
      await fs.writeFile(path.join(repoDir, 'src', name), content);
    }
    vi.stubEnv('ONTOINDEX_MAX_FILE_CONTENT_CHARS', '64');
    try {
      const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
      const expectedRows = fixtures.map(
        ({ name, expected }) => `"file:src/${name}","${name}","src/${name}","${expected}"\n`,
      );
      await expect(fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8')).resolves.toBe(
        'id,name,filePath,content\n' + expectedRows.join(''),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('generates CSV files for all node types in the graph', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/index.ts', label: 'File', name: 'index.ts', filePath: 'src/index.ts' },
        { id: 'file:src/utils.ts', label: 'File', name: 'utils.ts', filePath: 'src/utils.ts' },
        {
          id: 'func:main',
          label: 'Function',
          name: 'main',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 4,
          isExported: true,
        },
        {
          id: 'func:helper',
          label: 'Function',
          name: 'helper',
          filePath: 'src/utils.ts',
          startLine: 1,
          endLine: 3,
          isExported: true,
        },
        {
          id: 'class:App',
          label: 'Class',
          name: 'App',
          filePath: 'src/index.ts',
          startLine: 6,
          endLine: 8,
          isExported: true,
        },
        { id: 'folder:src', label: 'Folder', name: 'src', filePath: 'src' },
      ],
      [
        { sourceId: 'func:main', targetId: 'func:helper', type: 'CALLS' },
        { sourceId: 'file:src/index.ts', targetId: 'func:main', type: 'CONTAINS' },
        { sourceId: 'file:src/utils.ts', targetId: 'func:helper', type: 'CONTAINS' },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);

    // Check that CSV files were created
    expect(result.nodeFiles.size).toBeGreaterThan(0);
    expect(result.relRows).toBe(3);

    // Verify File CSV
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(2);

    // Verify Function CSV
    const funcCsv = result.nodeFiles.get('Function');
    expect(funcCsv).toBeDefined();
    expect(funcCsv!.rows).toBe(2);

    // Verify Class CSV
    const classCsv = result.nodeFiles.get('Class');
    expect(classCsv).toBeDefined();
    expect(classCsv!.rows).toBe(1);

    // Verify Folder CSV
    const folderCsv = result.nodeFiles.get('Folder');
    expect(folderCsv).toBeDefined();
    expect(folderCsv!.rows).toBe(1);

    // Verify relations CSV exists
    const relContent = await fs.readFile(result.relCsvPath, 'utf-8');
    const relLines = relContent.trim().split('\n');
    expect(relLines.length).toBe(4); // header + 3 relationships
  });

  it('CSV content is properly escaped', async () => {
    const graph = buildTestGraph([
      {
        id: 'file:src/index.ts',
        label: 'File',
        name: 'index.ts',
        filePath: 'src/index.ts',
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();

    const content = await fs.readFile(fileCsv!.csvPath, 'utf-8');
    // Content should be properly quoted
    expect(content).toContain('"file:src/index.ts"');
    expect(content).toContain('"index.ts"');
  });

  it('handles community nodes with keywords', async () => {
    const graph = buildTestGraph([
      {
        id: 'comm:auth',
        label: 'Community' as any,
        name: 'Auth',
        filePath: '',
        extra: {
          heuristicLabel: 'Authentication',
          keywords: ['auth', 'login', 'pass,word'],
          description: 'Auth module',
          enrichedBy: 'heuristic',
          cohesion: 0.85,
          symbolCount: 5,
        },
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const commCsv = result.nodeFiles.get('Community');
    expect(commCsv).toBeDefined();
    expect(commCsv!.rows).toBe(1);

    const content = await fs.readFile(commCsv!.csvPath, 'utf-8');
    // Keywords with commas should be escaped with \,
    expect(content).toContain('pass\\,word');
  });

  it('handles process nodes', async () => {
    const graph = buildTestGraph([
      {
        id: 'proc:flow',
        label: 'Process' as any,
        name: 'LoginFlow',
        filePath: '',
        extra: {
          heuristicLabel: 'User Login',
          processType: 'intra_community',
          stepCount: 3,
          communities: ['auth'],
          entryPointId: 'func:login',
          terminalId: 'func:validate',
        },
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const procCsv = result.nodeFiles.get('Process');
    expect(procCsv).toBeDefined();
    expect(procCsv!.rows).toBe(1);
  });

  it('writes Concept nodes with docs provenance fields', async () => {
    const graph = buildTestGraph(
      [
        { id: 'File:docs/adr.md', label: 'File', name: 'adr.md', filePath: 'docs/adr.md' },
        {
          id: 'Function:src/index.ts:main:1',
          label: 'Function',
          name: 'main',
          filePath: 'src/index.ts',
        },
        {
          id: 'Concept:markdown-concept:native-concepts:abc123',
          label: 'Concept',
          name: 'Native Concepts',
          filePath: 'docs/adr.md',
          extra: {
            aliases: ['Concept nodes'],
            sourceDocuments: ['docs/adr.md'],
            sourceFactKeys: ['markdown-chunk:docs/adr.md:h1'],
            resolutionKeys: ['resolution:main'],
            authority: 'advisory',
            confidence: 'medium',
            evidenceClass: 'docs_evidence',
            freshness: 'fresh',
          },
        },
      ],
      [
        {
          sourceId: 'Concept:markdown-concept:native-concepts:abc123',
          targetId: 'File:docs/adr.md',
          type: 'EXPLAINED_BY',
          confidence: 1,
          reason: 'docs-concept-grounding',
        },
        {
          sourceId: 'Concept:markdown-concept:native-concepts:abc123',
          targetId: 'Function:src/index.ts:main:1',
          type: 'EXPLAINED_BY',
          confidence: 0.9,
          reason: 'docs-symbol-grounding',
        },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const conceptCsv = result.nodeFiles.get('Concept');
    expect(conceptCsv).toBeDefined();
    expect(conceptCsv!.rows).toBe(1);

    const content = await fs.readFile(conceptCsv!.csvPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines[0]).toBe(
      'id,name,filePath,aliases,sourceDocuments,sourceFactKeys,resolutionKeys,authority,confidence,evidenceClass,freshness',
    );
    expect(lines[1]).toContain('"Native Concepts"');
    expect(lines[1]).toContain("['Concept nodes']");
    expect(lines[1]).toContain("['docs/adr.md']");

    const relContent = await fs.readFile(result.relCsvPath, 'utf-8');
    expect(relContent).toContain('"EXPLAINED_BY",1,"docs-concept-grounding"');
    expect(relContent).toContain('"EXPLAINED_BY",0.9,"docs-symbol-grounding"');
  });

  it('writes Method declaration and definition navigation metadata', async () => {
    const graph = buildTestGraph([
      {
        id: 'Method:src/a.hxx:A.f#0',
        label: 'Method',
        name: 'f',
        filePath: 'src/a.cxx',
        startLine: 1,
        endLine: 1,
        isExported: true,
        extra: {
          parameterCount: 0,
          returnType: 'int',
          declarationFilePath: 'src/a.hxx',
          declarationStartLine: 0,
          declarationEndLine: 0,
          definitionFilePath: 'src/a.cxx',
          definitionStartLine: 1,
          definitionEndLine: 1,
        },
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const methodCsv = result.nodeFiles.get('Method');
    expect(methodCsv).toBeDefined();

    const content = await fs.readFile(methodCsv!.csvPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines[0]).toBe(
      'id,name,filePath,startLine,endLine,isExported,content,description,parameterCount,returnType,declarationFilePath,declarationStartLine,declarationEndLine,definitionFilePath,definitionStartLine,definitionEndLine',
    );
    expect(lines[1]).toContain('"src/a.hxx",0,0,"src/a.cxx",1,1');
  });

  it('deduplicates File nodes', async () => {
    const graph = buildTestGraph([
      { id: 'file:src/index.ts', label: 'File', name: 'index.ts', filePath: 'src/index.ts' },
      // Duplicate (same id) — should not appear twice
    ]);
    // Add the same node again manually
    graph.addNode({
      id: 'file:src/index.ts',
      label: 'File',
      properties: { name: 'index.ts', filePath: 'src/index.ts' },
    });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(1);
  });

  it('can route rows through an injected CSV writer factory', async () => {
    const graph = buildTestGraph([
      { id: 'file:src/index.ts', label: 'File', name: 'index.ts', filePath: 'src/index.ts' },
    ]);
    const writers: { csvPath: string; header: string; rows: string[]; finished: boolean }[] = [];
    const createWriter: CsvRowWriterFactory = (csvPath, header) => {
      const writer = { csvPath, header, rows: [] as string[], finished: false };
      writers.push(writer);
      return {
        csvPath,
        get rows() {
          return writer.rows.length;
        },
        addRow: async (row) => {
          writer.rows.push(row);
        },
        finish: async () => {
          writer.finished = true;
        },
      };
    };

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir, { createWriter });
    const fileWriter = writers.find((writer) => writer.csvPath.endsWith('/file.csv'));

    expect(fileWriter).toBeDefined();
    expect(fileWriter!.header).toBe('id,name,filePath,content');
    expect(fileWriter!.rows.length).toBe(1);
    expect(fileWriter!.finished).toBe(true);
    expect(result.nodeFiles.get('File')?.csvPath).toBe(fileWriter!.csvPath);
    expect(result.nodeFiles.get('File')?.rows).toBe(1);
  });

  it('writes stable golden CSV bytes for representative graph rows', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/utils.ts', label: 'File', name: 'utils.ts', filePath: 'src/utils.ts' },
        {
          id: 'func:helper',
          label: 'Function',
          name: 'helper',
          filePath: 'src/utils.ts',
          startLine: 1,
          endLine: 3,
          isExported: true,
        },
      ],
      [
        {
          sourceId: 'file:src/utils.ts',
          targetId: 'func:helper',
          type: 'CONTAINS',
          confidence: 0.95,
          reason: 'unit fixture',
          step: 2,
        },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const sourceContent = 'export function helper() {\n  return 42;\n}\n';

    await expect(fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8')).resolves.toBe(
      `id,name,filePath,content\n"file:src/utils.ts","utils.ts","src/utils.ts","${sourceContent}"\n`,
    );
    await expect(fs.readFile(result.nodeFiles.get('Function')!.csvPath, 'utf-8')).resolves.toBe(
      `id,name,filePath,startLine,endLine,isExported,content,description\n"func:helper","helper","src/utils.ts",1,3,true,"${sourceContent}",""\n`,
    );
    await expect(fs.readFile(result.relCsvPath, 'utf-8')).resolves.toBe(
      'from,to,type,confidence,reason,step\n"file:src/utils.ts","func:helper","CONTAINS",0.95,"unit fixture",2\n',
    );
  });

  it.skipIf(
    !fsSync.existsSync(
      path.resolve(__dirname, '../../../ontoindex-native/native/ontoindex_native.node'),
    ),
  )('writes byte-for-byte identical fixture graph CSVs through the Rust writer', async () => {
    const require = createRequire(import.meta.url);
    const nativeModule = require('../../../ontoindex-native/index.cjs') as {
      createCsvRowWriter: CsvRowWriterFactory;
    };
    const graph = buildTestGraph(
      [
        { id: 'file:src/utils.ts', label: 'File', name: 'utils.ts', filePath: 'src/utils.ts' },
        {
          id: 'func:helper',
          label: 'Function',
          name: 'helper',
          filePath: 'src/utils.ts',
          startLine: 1,
          endLine: 3,
          isExported: true,
        },
      ],
      [
        {
          sourceId: 'file:src/utils.ts',
          targetId: 'func:helper',
          type: 'CONTAINS',
          confidence: 0.95,
          reason: 'unit fixture',
          step: 2,
        },
      ],
    );
    const tsDir = path.join(tmpHandle.dbPath, 'csv-ts');
    const nativeDir = path.join(tmpHandle.dbPath, 'csv-native');

    const tsResult = await streamAllCSVsToDisk(graph, repoDir, tsDir);
    const nativeResult = await streamAllCSVsToDisk(graph, repoDir, nativeDir, {
      createWriter: nativeModule.createCsvRowWriter,
    });

    expect(nativeResult.relRows).toBe(tsResult.relRows);
    expect(nativeResult.nodeFiles.size).toBe(tsResult.nodeFiles.size);
    for (const [label, tsFile] of tsResult.nodeFiles) {
      const nativeFile = nativeResult.nodeFiles.get(label);
      expect(nativeFile?.rows).toBe(tsFile.rows);
      expect(await fs.readFile(nativeFile!.csvPath, 'utf-8')).toBe(
        await fs.readFile(tsFile.csvPath, 'utf-8'),
      );
    }
    expect(await fs.readFile(nativeResult.relCsvPath, 'utf-8')).toBe(
      await fs.readFile(tsResult.relCsvPath, 'utf-8'),
    );
  });

  // ─── Const node isExported ───────────────────────────────────────────

  it('Const node with isExported:true writes true in CSV isExported column', async () => {
    const graph = buildTestGraph([
      {
        id: 'const:FOO',
        label: 'Const',
        name: 'FOO',
        filePath: 'src/index.ts',
        startLine: 1,
        endLine: 1,
        isExported: true,
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const constCsv = result.nodeFiles.get('Const' as any);
    expect(constCsv).toBeDefined();
    expect(constCsv!.rows).toBe(1);

    const content = await fs.readFile(constCsv!.csvPath, 'utf-8');
    const lines = content.trim().split('\n');
    // header: id,name,filePath,startLine,endLine,isExported,content,description
    expect(lines[0]).toBe('id,name,filePath,startLine,endLine,isExported,content,description');
    // data row: isExported is the 6th field (index 5 after splitting on unquoted commas)
    // Easier: just check the raw text contains 'true' after endLine value
    expect(lines[1]).toContain('true');
    // And does NOT treat it as a multi-lang node (no isExported in multi-lang header)
    expect(lines[0]).toContain('isExported');
  });

  it('Const node with isExported:false writes false in CSV isExported column', async () => {
    const graph = buildTestGraph([
      {
        id: 'const:BAR',
        label: 'Const',
        name: 'BAR',
        filePath: 'src/index.ts',
        startLine: 2,
        endLine: 2,
        isExported: false,
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const constCsv = result.nodeFiles.get('Const' as any);
    expect(constCsv).toBeDefined();

    const content = await fs.readFile(constCsv!.csvPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines[1]).toContain('false');
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  it('handles empty graph (zero nodes)', async () => {
    const graph = buildTestGraph([], []);
    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    expect(result.nodeFiles.size).toBe(0);
    expect(result.relRows).toBe(0);
  });

  it('handles node with empty string properties', async () => {
    const graph = buildTestGraph([{ id: 'file:empty', label: 'File', name: '', filePath: '' }]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(1);
  });
});
