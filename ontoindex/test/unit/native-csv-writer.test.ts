import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { isNativeCsvEnabled, selectCsvRowWriterFactory } from '../../src/native/csv-writer.js';
import {
  BufferedCsvRowWriter,
  type CsvRowWriterFactory,
} from '../../src/core/lbug/csv-row-writer.js';

const fallbackFactory: CsvRowWriterFactory = () => ({
  csvPath: 'fallback.csv',
  rows: 0,
  addRow: () => undefined,
  finish: async () => undefined,
});

const nativeFactory: CsvRowWriterFactory = () => ({
  csvPath: 'native.csv',
  rows: 0,
  addRow: () => undefined,
  finish: async () => undefined,
});

describe('native CSV writer selection', () => {
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
      { label: 'character-limited and oversized rows', count: 25, maxBufferedCharacters: 64 },
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
          '"4","unicode","é🙂"',
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
