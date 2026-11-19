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
    write: vi.fn((_chunk: string) => true),
    end: vi.fn((callback: () => void) => callback()),
    destroyed: false,
    closed: false,
    destroy: vi.fn(function (this: { destroyed: boolean }) {
      this.destroyed = true;
    }),
  });
  vi.mocked(createWriteStream).mockReturnValueOnce(stream as unknown as WriteStream);
  return stream;
}

describe('BufferedCsvRowWriter', () => {
  it('discards buffered rows and waits for actual close when aborted before open', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', 'id');
    writer.addRow('pending');
    let settled = false;
    const aborted = writer.abort();
    void aborted.then(() => {
      settled = true;
    });
    expect(writer.abort()).toBe(aborted);
    expect(stream.destroy).toHaveBeenCalledOnce();
    expect(stream.destroyed).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    stream.emit('open', 123);
    await Promise.resolve();
    expect(settled).toBe(false);
    stream.closed = true;
    stream.emit('close');
    await aborted;
    expect(settled).toBe(true);
    expect(() => writer.addRow('later')).toThrow('CSV writer aborted');
    await expect(writer.finish()).rejects.toThrow('CSV writer aborted');
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.end).not.toHaveBeenCalled();
  });

  it('settles blocked drain and concurrent finish without resuming discarded rows', async () => {
    const stream = fakeStream();
    stream.write.mockReturnValueOnce(false);
    const writer = new BufferedCsvRowWriter('unused.csv', 'id', 4);
    const pending = writer.addRow('oversized');
    const draining = expect(pending).rejects.toThrow('CSV writer aborted');
    const finishing = expect(writer.finish()).rejects.toThrow('CSV writer aborted');
    const aborted = writer.abort();
    stream.closed = true;
    stream.emit('close');
    await Promise.all([draining, finishing, aborted]);
    stream.emit('drain');
    expect(stream.write.mock.calls).toEqual([['id\n']]);
    expect(stream.end).not.toHaveBeenCalled();
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
    expect(stream.listenerCount('error')).toBe(1);
  });

  it('settles a pending end on abort and removes temporary listeners', async () => {
    const stream = fakeStream();
    stream.end.mockImplementation(() => undefined);
    const writer = new BufferedCsvRowWriter('unused.csv', 'id');
    const pending = writer.finish();
    const finishing = expect(pending).rejects.toThrow('CSV writer aborted');
    await Promise.resolve();
    await Promise.resolve();
    expect(stream.end).toHaveBeenCalledOnce();
    const aborted = writer.abort();
    stream.closed = true;
    stream.emit('close');
    await Promise.all([finishing, aborted]);
    expect(stream.listenerCount('close')).toBe(0);
    expect(stream.listenerCount('error')).toBe(1);
  });

  it('rejects a blocked write when the stream closes without drain or error', async () => {
    const stream = fakeStream();
    stream.write.mockReturnValueOnce(false);
    const writer = new BufferedCsvRowWriter('unused.csv', 'id');
    const pending = writer.flush();
    const rejected = expect(pending).rejects.toThrow('CSV stream closed before drain');
    stream.closed = true;
    stream.emit('close');
    await rejected;
    await writer.abort();
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
  });

  it('preserves the first stream failure through abort and later open errors', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', 'id');
    const failure = new Error('open failed');
    stream.emit('error', failure);
    const aborted = writer.abort();
    stream.emit('error', new Error('close failed'));
    stream.closed = true;
    stream.emit('close');
    await aborted;
    expect(() => writer.addRow('later')).toThrow(failure);
    await expect(writer.finish()).rejects.toBe(failure);
    expect(stream.write).not.toHaveBeenCalled();
  });

  it('closes real pending opens before abort resolves', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-csv-abort-'));
    try {
      for (let i = 0; i < 8; i++) {
        const csvPath = path.join(dir, `${i}.csv`);
        const writer = new BufferedCsvRowWriter(csvPath, 'id');
        writer.addRow('discard');
        await writer.abort();
        const stream = vi.mocked(createWriteStream).mock.results.at(-1)!.value as WriteStream;
        expect(stream.closed).toBe(true);
        expect(await fs.readFile(csvPath, 'utf8')).toBe('');
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('flushes before a row would exceed the byte threshold, including header and newlines', async () => {
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
    expect(stream.write.mock.calls).toEqual([['id\n1\n'], ['01234567'], ['89'], ['\n']]);
    await writer.addRow('2');
    await writer.finish();
    expect(stream.write.mock.calls).toEqual([['id\n1\n'], ['01234567'], ['89'], ['\n'], ['2\n']]);
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

  it('counts CJK and emoji bytes before admitting a row', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', '界', 9);
    await writer.addRow('🙂');
    expect(stream.write).not.toHaveBeenCalled();
    await writer.addRow('a');
    expect(stream.write.mock.calls).toEqual([['界\n🙂\n']]);
    await writer.finish();
    expect(stream.write.mock.calls.at(-1)).toEqual(['a\n']);
  });

  it.each([1, 4, 7])(
    'fragments oversized headers and rows at UTF-8 boundaries with budget %i',
    async (budget) => {
      const stream = fakeStream();
      const header = '🙂界\ud800abc';
      const row = 'abc🙂界\udc00🙂';
      const writer = new BufferedCsvRowWriter('unused.csv', header, budget);
      await writer.addRow(row);
      await writer.finish();
      const chunks = stream.write.mock.calls.map(([chunk]) => Buffer.from(chunk));
      expect(chunks.every((chunk) => chunk.length <= Math.max(4, budget))).toBe(true);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(header + '\n' + row + '\n'));
      expect(writer.rows).toBe(1);
    },
  );

  it('waits for drain between oversized fragments', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', 'id', 4);
    await writer.flush();
    stream.write.mockReturnValueOnce(false);
    const pending = writer.addRow('🙂🙂');
    expect(stream.write.mock.calls).toEqual([['id\n'], ['🙂']]);
    stream.emit('drain');
    await pending;
    await writer.finish();
    expect(stream.write.mock.calls).toEqual([['id\n'], ['🙂'], ['🙂'], ['\n']]);
  });

  it('retains asynchronous errors after write returned true', async () => {
    const stream = fakeStream();
    const writer = new BufferedCsvRowWriter('unused.csv', 'id', 8);
    await writer.flush();
    const failure = new Error('late stream failure');
    stream.emit('error', failure);
    expect(() => writer.addRow('later')).toThrow(failure);
    await expect(writer.finish()).rejects.toBe(failure);
    await expect(writer.finish()).rejects.toBe(failure);
    expect(stream.write).toHaveBeenCalledOnce();
  });

  it('rejects blocked writes and cleans drain listeners on failure', async () => {
    const stream = fakeStream();
    stream.write.mockReturnValueOnce(false);
    const writer = new BufferedCsvRowWriter('unused.csv', 'id');
    const pending = writer.flush();
    const failure = new Error('blocked stream failure');
    stream.emit('error', failure);
    await expect(pending).rejects.toBe(failure);
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('error')).toBe(1);
    await expect(writer.finish()).rejects.toBe(failure);
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
