import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BufferedCsvRowWriter } from '../../src/core/lbug/csv-row-writer.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

function fakeStream() {
  const stream = Object.assign(new EventEmitter(), {
    write: vi.fn(() => true),
    end: vi.fn((callback: () => void) => callback()),
  });
  vi.mocked(createWriteStream).mockReturnValueOnce(stream as unknown as WriteStream);
  return stream;
}

describe('BufferedCsvRowWriter', () => {
  it('flushes before a row would exceed the character threshold, including newlines', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', 'id', 8);

    expect(writer.addRow('1234')).toBeUndefined();
    expect(stream.write).not.toHaveBeenCalled();
    await writer.addRow('5');
    expect(stream.write.mock.calls).toEqual([['id\n1234\n']]);
    await writer.finish();
    expect(stream.write.mock.calls).toEqual([['id\n1234\n'], ['5\n']]);
    expect(writer.rows).toBe(2);
  });

  it('writes an oversized row alone between pending and subsequent rows', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', 'id', 8);
    const oversized = '0123456789';

    await writer.addRow('1');
    await writer.addRow(oversized);
    expect(stream.write.mock.calls).toEqual([['id\n1\n'], [oversized + '\n']]);
    await writer.addRow('2');
    await writer.finish();
    expect(stream.write.mock.calls).toEqual([['id\n1\n'], [oversized + '\n'], ['2\n']]);
    expect(writer.rows).toBe(3);
  });

  it('retains the 500-row batch trigger', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', 'id');
    for (let i = 0; i < 498; i++) await writer.addRow('1');
    expect(stream.write).not.toHaveBeenCalled();
    await writer.addRow('2');
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.write.mock.calls[0]).toEqual(['id\n' + '1\n'.repeat(498) + '2\n']);
    await writer.finish();
  });

  it('waits for drain before adding the row that triggers a size flush', async () => {
    const stream = fakeStream();
    stream.write.mockReturnValueOnce(false);
    const writer = new BufferedCsvRowWriter('unused.csv', 'id', 8);
    await writer.addRow('1234');

    let settled = false;
    const pending = Promise.resolve(writer.addRow('5')).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(writer.rows).toBe(1);
    expect(stream.listenerCount('drain')).toBe(1);
    stream.emit('drain');
    await pending;
    expect(settled).toBe(true);
    expect(writer.rows).toBe(2);
    await writer.finish();
  });

  it('preserves file bytes for mixed small and oversized rows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-csv-row-writer-'));
    try {
      const csvPath = path.join(dir, 'mixed.csv');
      const header = 'id,name';
      const rows = ['1,Ada', '2,' + 'large'.repeat(10), '3,Lin', '4,Bo'];
      const writer = new BufferedCsvRowWriter(csvPath, header, 16);
      for (const row of rows) await writer.addRow(row);
      await writer.finish();
      await expect(fs.readFile(csvPath, 'utf8')).resolves.toBe([header, ...rows].join('\n') + '\n');
      expect(writer.rows).toBe(rows.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the header, rows, and final newline on finish', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-csv-row-writer-'));
    try {
      const csvPath = path.join(dir, 'rows.csv');
      const writer = new BufferedCsvRowWriter(csvPath, 'id,name');

      expect(writer.rows).toBe(0);
      const maybeFlush = writer.addRow('1,Ada');
      expect(maybeFlush).toBeUndefined();
      expect(writer.rows).toBe(1);

      await writer.finish();

      await expect(fs.readFile(csvPath, 'utf8')).resolves.toBe('id,name\n1,Ada\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
