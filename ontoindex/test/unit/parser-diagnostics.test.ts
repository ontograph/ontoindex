import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ParserDiagnosticsWriter,
  readParserDiagnosticsPage,
} from '../../src/core/ingestion/parser-diagnostics.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const tempDirs: string[] = [];

async function createGeneration(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-parser-diagnostics-'));
  tempDirs.push(root);
  const generation = path.join(root, 'generation-1');
  await fs.mkdir(generation);
  return generation;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('parser diagnostics generation evidence', () => {
  it('reads and continues pages through the backend for a pinned overlay', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-diagnostics-backend-'));
    tempDirs.push(storagePath);
    const generationPath = path.join(storagePath, 'overlay', 'generation-1');
    await fs.mkdir(generationPath, { recursive: true });
    await fs.writeFile(path.join(storagePath, 'overlay', 'CURRENT'), 'generation-1');
    const writer = new ParserDiagnosticsWriter(generationPath);
    for (let i = 0; i < 3; i++)
      writer.append({
        kind: 'parse-error',
        filePath: `src/${i}.ts`,
        reason: 'syntax error',
        phase: 'parse',
      });
    await fs.writeFile(
      path.join(generationPath, 'base.json'),
      JSON.stringify({ parserDiagnostics: await writer.finish() }),
    );
    const backend = new LocalBackend() as unknown as {
      parserDiagnostics(repo: unknown, params: unknown): Promise<Record<string, any>>;
    };
    const repo = { storagePath };
    const first = await backend.parserDiagnostics(repo, { source: 'workspace-overlay', limit: 2 });
    expect(first).toMatchObject({ available: true, complete: true, total: 3, returned: 2 });
    const next = await backend.parserDiagnostics(repo, { cursor: first.nextCursor });
    expect(next).toMatchObject({
      available: true,
      total: 3,
      offset: 2,
      returned: 1,
      truncated: false,
    });
    await expect(
      backend.parserDiagnostics(repo, { source: 'workspace-overlay', offset: 2 }),
    ).rejects.toThrow(/Invalid parser diagnostics page request/);
  });

  it('stores bounded chunks and pages exact totals across categories', async () => {
    const generationPath = await createGeneration();
    const writer = new ParserDiagnosticsWriter(generationPath);
    for (let i = 0; i < 260; i++) {
      writer.append({
        kind: 'parse-error',
        filePath: `src/parse-${i}.ts`,
        reason: 'tree-sitter parse error',
        phase: 'parse',
      });
    }
    for (let i = 0; i < 257; i++) {
      writer.append({
        kind: 'degraded',
        filePath: `src/degraded-${i}.ts`,
        reason: 'worker recovery skipped file',
        phase: 'parse',
      });
    }
    const summary = await writer.finish();
    expect(summary).toEqual({
      version: 1,
      complete: true,
      chunkSize: 256,
      parseErrorCount: 260,
      degradedEntryCount: 257,
      parseErrorChunkCount: 2,
      degradedChunkCount: 2,
    });

    const crossingPage = await readParserDiagnosticsPage(generationPath, 'generation-1', summary, {
      offset: 250,
      limit: 20,
    });
    expect(crossingPage).toMatchObject({
      total: 517,
      offset: 250,
      returned: 20,
      truncated: true,
      nextOffset: 270,
      totals: { parseErrorCount: 260, degradedEntryCount: 257 },
    });
    expect(crossingPage.nextCursor).toBeTypeOf('string');
    expect(crossingPage.items.slice(0, 10).map((entry) => entry.filePath)).toEqual(
      Array.from({ length: 10 }, (_, i) => `src/parse-${i + 250}.ts`),
    );
    expect(crossingPage.items.slice(10).map((entry) => entry.filePath)).toEqual(
      Array.from({ length: 10 }, (_, i) => `src/degraded-${i}.ts`),
    );
    const continuation = await readParserDiagnosticsPage(generationPath, 'generation-1', summary, {
      source: 'committed',
      kind: 'all',
      limit: 20,
      cursor: crossingPage.nextCursor,
    });
    expect(continuation).toMatchObject({ offset: 270, total: 517, returned: 20, truncated: true });
    await expect(
      readParserDiagnosticsPage(generationPath, 'generation-1', summary, {
        source: 'workspace-overlay',
        kind: 'all',
        limit: 20,
        cursor: crossingPage.nextCursor,
      }),
    ).rejects.toThrow(/does not match/);
    const alteredCursor = `${crossingPage.nextCursor!.slice(0, -1)}0`;
    await expect(
      readParserDiagnosticsPage(generationPath, 'generation-1', summary, {
        source: 'committed',
        kind: 'all',
        limit: 20,
        cursor: alteredCursor,
      }),
    ).rejects.toThrow(/cursor/);

    const finalPage = await readParserDiagnosticsPage(generationPath, 'generation-1', summary, {
      kind: 'degraded',
      offset: 256,
      limit: 10,
    });
    expect(finalPage).toMatchObject({ total: 257, returned: 1, truncated: false });
    expect(finalPage.items[0]?.filePath).toBe('src/degraded-256.ts');
  });

  it('rejects unsafe paths, invalid bounds, and incomplete chunks', async () => {
    const generationPath = await createGeneration();
    const writer = new ParserDiagnosticsWriter(generationPath);
    expect(() =>
      writer.append({
        kind: 'parse-error',
        filePath: '../outside.ts',
        reason: 'bad path',
        phase: 'parse',
      }),
    ).toThrow(/repository-relative/);
    writer.append({
      kind: 'parse-error',
      filePath: 'src/bad.ts',
      reason: 'x'.repeat(513),
      phase: 'parse',
    });
    const summary = await writer.finish();
    const page = await readParserDiagnosticsPage(generationPath, 'generation-1', summary);
    expect(page.items[0]).toMatchObject({ reason: 'x'.repeat(512), reasonTruncated: true });
    await expect(
      readParserDiagnosticsPage(generationPath, '../generation', summary),
    ).rejects.toThrow(/generation id/);
    await expect(
      readParserDiagnosticsPage(generationPath, 'generation-1', summary, { limit: 101 }),
    ).rejects.toThrow(/page bounds/);

    await fs.rm(path.join(generationPath, 'parser-diagnostics', 'parse-error-00000000.json'));
    await expect(
      readParserDiagnosticsPage(generationPath, 'generation-1', summary),
    ).rejects.toThrow(/missing or unsafe/);
  });
});
