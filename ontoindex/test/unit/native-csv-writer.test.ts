import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { isNativeCsvEnabled, selectCsvRowWriterFactory } from '../../src/native/csv-writer.js';
import { writeGraphBatch, NATIVE_GRAPH_BATCH_BYTES } from '../../src/native/graph-writer.js';
import type { GraphNode } from 'ontoindex-shared';
import {
  BufferedCsvRowWriter,
  type CsvRowWriterFactory,
} from '../../src/core/lbug/csv-row-writer.js';

const fallbackFactory: CsvRowWriterFactory = () => ({
  csvPath: 'fallback.csv',
  rows: 0,
  addRow: () => undefined,
  finish: async () => undefined,
  abort: async () => undefined,
});

const nativeFactory: CsvRowWriterFactory = () => ({
  csvPath: 'native.csv',
  rows: 0,
  addRow: () => undefined,
  finish: async () => undefined,
  abort: async () => undefined,
});

describe('native CSV writer selection', () => {
  it.skipIf(
    !fsSync.existsSync(
      path.resolve(__dirname, '../../../ontoindex-native/native/ontoindex_native.node'),
    ),
  )('discards pending native rows without appending after abort', async () => {
    const require = createRequire(import.meta.url);
    const nativeModule = require('../../../ontoindex-native/index.cjs') as {
      createCsvRowWriter: CsvRowWriterFactory;
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-native-abort-'));
    try {
      const csvPath = path.join(dir, 'aborted.csv');
      const writer = nativeModule.createCsvRowWriter(csvPath, 'id');
      await writer.addRow('pending');
      await writer.abort();
      await writer.abort();
      expect(() => writer.addRow('later')).toThrow('CSV writer aborted');
      await expect(writer.finish()).rejects.toThrow('CSV writer aborted');
      expect(fsSync.existsSync(csvPath)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('treats the native CSV feature flag as opt-in', () => {
    expect(isNativeCsvEnabled({})).toBe(false);
    expect(isNativeCsvEnabled({ ONTOINDEX_NATIVE_CSV: '0' })).toBe(false);
    expect(isNativeCsvEnabled({ ONTOINDEX_NATIVE_CSV: '1' })).toBe(true);
    expect(isNativeCsvEnabled({ ONTOINDEX_NATIVE_CSV: 'true' })).toBe(true);
  });

  it('uses the TypeScript fallback when the feature flag is disabled', async () => {
    const loadNativeModule = vi.fn(async () => ({ createCsvRowWriter: nativeFactory }));

    await expect(
      selectCsvRowWriterFactory({
        env: {},
        fallbackFactory,
        loadNativeModule,
      }),
    ).resolves.toBe(fallbackFactory);
    expect(loadNativeModule).not.toHaveBeenCalled();
  });

  it('uses the native factory when enabled and available', async () => {
    await expect(
      selectCsvRowWriterFactory({
        env: { ONTOINDEX_NATIVE_CSV: '1' },
        fallbackFactory,
        loadNativeModule: async () => ({ createCsvRowWriter: nativeFactory }),
      }),
    ).resolves.toBe(nativeFactory);
  });

  it('falls back with a warning when enabled but native loading fails', async () => {
    const warnings: string[] = [];

    await expect(
      selectCsvRowWriterFactory({
        env: { ONTOINDEX_NATIVE_CSV: '1' },
        fallbackFactory,
        loadNativeModule: async () => {
          throw new Error('module not found');
        },
        onWarning: (message) => warnings.push(message),
      }),
    ).resolves.toBe(fallbackFactory);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('using TypeScript writer');
  });

  it
    .skipIf(
      !fsSync.existsSync(
        path.resolve(__dirname, '../../../ontoindex-native/native/ontoindex_native.node'),
      ),
    )
    .each([
      { label: 'multiple row batches', count: 1201, maxBufferedCharacters: undefined },
      { label: 'empty table', count: 0, maxBufferedCharacters: undefined },
      { label: 'byte-limited and oversized rows', count: 25, maxBufferedCharacters: 64 },
      { label: 'tiny byte budget and Unicode', count: 25, maxBufferedCharacters: 4 },
    ])(
    'writes byte-for-byte identical CSV for $label',
    async ({ count, maxBufferedCharacters }) => {
      const require = createRequire(import.meta.url);
      const nativeModule = require('../../../ontoindex-native/index.cjs') as {
        createCsvRowWriter: (
          csvPath: string,
          header: string,
          maxBufferedCharacters?: number,
        ) => ReturnType<CsvRowWriterFactory> & { _rows: string[]; _chars: number };
      };
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-native-csv-compare-'));
      try {
        const header = 'id,name,content';
        const samples = [
          '"1","alpha","plain"',
          '"2","quote","say ""hello"""',
          '"3","multiline","line1\nline2"',
          '"4","unicode","é🙂界\ud800"',
          `"5","oversized","${'x'.repeat(128)}"`,
        ];
        const rows = Array.from({ length: count }, (_, i) => samples[i % samples.length]);
        const tsWriter = new BufferedCsvRowWriter(
          path.join(dir, 'ts.csv'),
          header,
          maxBufferedCharacters,
        );
        const nativeWriter = nativeModule.createCsvRowWriter(
          path.join(dir, 'native.csv'),
          header,
          maxBufferedCharacters,
        );

        for (const row of rows) {
          await tsWriter.addRow(row);
          expect(nativeWriter.addRow(row)).toBeUndefined();
          expect(nativeWriter._rows.length).toBeLessThan(500);
          expect(nativeWriter._chars).toBeLessThanOrEqual(
            maxBufferedCharacters ?? 64 * 1024 * 1024,
          );
        }
        await tsWriter.finish();
        await nativeWriter.finish();

        expect(await fs.readFile(path.join(dir, 'native.csv'), 'utf8')).toBe(
          await fs.readFile(path.join(dir, 'ts.csv'), 'utf8'),
        );
        expect(nativeWriter.rows).toBe(tsWriter.rows);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('native graph CSV batch admission', () => {
  const node = (id: number, properties: Record<string, unknown> = {}): GraphNode =>
    ({
      id: `File:${id}`,
      label: 'File',
      properties: { name: 'x', filePath: 'x', ...properties },
    }) as GraphNode;

  it('splits 1001 records and preserves escaped and array properties', async () => {
    const writeGraphBatchNative = vi.fn();
    const nodes = Array.from({ length: 1001 }, (_, i) => node(i));
    nodes[0] = node(0, { name: 'quote"\\界🙂', tags: ["a'b", 'c\\d', '界🙂', null] });
    const result = await writeGraphBatch('unused', nodes, [], {
      env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
      nativeModule: { writeGraphBatchNative },
    });
    expect(writeGraphBatchNative.mock.calls.map((call) => call[1].length)).toEqual([1000, 1]);
    expect(writeGraphBatchNative.mock.calls[0][1][0].properties).toEqual({
      name: 'quote"\\界🙂',
      filePath: 'x',
      tags: "['a''b','c\\\\d','界🙂']",
    });
    expect(result.nodeCounts.get('File')).toBe(1001);
  });

  it('flushes for the byte limit and isolates an oversized singleton', async () => {
    const writeGraphBatchNative = vi.fn();
    const large = '界"\\'.repeat(Math.ceil(NATIVE_GRAPH_BATCH_BYTES / 36));
    const huge = '🙂'.repeat(Math.ceil(NATIVE_GRAPH_BATCH_BYTES / 8));
    await writeGraphBatch(
      'unused',
      [
        node(1, { content: large }),
        node(2, { content: large }),
        node(3, { content: huge }),
        node(4),
      ],
      [],
      {
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: { writeGraphBatchNative },
      },
    );
    expect(
      writeGraphBatchNative.mock.calls.map((call) =>
        call[1].map((record: { id: string }) => record.id),
      ),
    ).toEqual([['File:1'], ['File:2'], ['File:3'], ['File:4']]);
  });

  it('propagates native failures without retrying a partial batch', async () => {
    const failure = new Error('native graph write failed');
    const writeGraphBatchNative = vi.fn(() => {
      throw failure;
    });
    await expect(
      writeGraphBatch('unused', [node(1)], [], {
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: { writeGraphBatchNative },
      }),
    ).rejects.toBe(failure);
    expect(writeGraphBatchNative).toHaveBeenCalledOnce();
  });
});
