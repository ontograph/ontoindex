import { createWriteStream, type WriteStream } from 'fs';

/** Flush buffered rows to disk every N rows. */
const FLUSH_EVERY = 500;

/** Maximum UTF-8 bytes in a batch, including every newline. */
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** Compatibility alias; the limit is measured in UTF-8 bytes. */
export const MAX_BUFFERED_CHARACTERS = MAX_BUFFERED_BYTES;

/** Preserve surrogate pairs and Node's replacement encoding for lone surrogates. */
function* csvByteFragments(value: string, maxBytes: number): Generator<string> {
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < value.length; ) {
    const code = value.charCodeAt(i);
    const pair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff;
    const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes + size > maxBytes) {
      yield value.slice(start, i);
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += pair ? 2 : 1;
  }
  if (start < value.length) yield value.slice(start);
}

export interface CsvRowWriter {
  readonly csvPath: string;
  readonly rows: number;
  addRow(row: string): void | Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export type CsvRowWriterFactory = (csvPath: string, header: string) => CsvRowWriter;

export class BufferedCsvRowWriter implements CsvRowWriter {
  private ws: WriteStream;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private readonly maxBufferedBytes: number;
  private failure: Error | undefined;
  private readonly closed: Promise<void>;
  private aborting: Promise<void> | undefined;
  rows = 0;

  constructor(
    public readonly csvPath: string,
    header: string,
    maxBufferedBytes = MAX_BUFFERED_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new RangeError('CSV byte budget must be a positive safe integer');
    }
    // A UTF-8 codepoint needs up to four bytes, even with a tiny configured limit.
    this.maxBufferedBytes = Math.max(4, maxBufferedBytes);
    this.ws = createWriteStream(csvPath, 'utf-8');
    // Large repos flush many times, so raise listener cap to avoid warning noise.
    this.ws.setMaxListeners(50);
    this.ws.on('error', (error: Error) => {
      this.failure ??= error;
    });
    this.closed = new Promise((resolve) => this.ws.once('close', resolve));
    this.buffer.push(header);
    this.bufferedBytes = Buffer.byteLength(header) + 1;
  }

  addRow(row: string): void | Promise<void> {
    if (this.failure) throw this.failure;
    const rowBytes = Buffer.byteLength(row) + 1;
    if (this.buffer.length > 0 && this.bufferedBytes + rowBytes > this.maxBufferedBytes) {
      return this.flush().then(() => this.addRow(row));
    }
    this.buffer.push(row);
    this.bufferedBytes += rowBytes;
    this.rows++;
    if (this.buffer.length >= FLUSH_EVERY || this.bufferedBytes > this.maxBufferedBytes) {
      return this.flush();
    }
  }

  private write(chunk: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.ws.removeListener('error', onError);
        this.ws.removeListener('drain', onDrain);
        this.ws.removeListener('close', onClose);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(this.failure ?? error);
      };
      const onDrain = () => {
        cleanup();
        if (this.failure) reject(this.failure);
        else resolve();
      };
      const onClose = () => {
        this.failure ??= new Error('CSV stream closed before drain');
        cleanup();
        reject(this.failure);
      };
      this.ws.once('error', onError);
      this.ws.once('drain', onDrain);
      this.ws.once('close', onClose);
      try {
        const ok = this.ws.write(chunk);
        if (this.failure) {
          cleanup();
          reject(this.failure);
        } else if (ok) {
          cleanup();
          resolve();
        }
      } catch (error) {
        this.failure ??= error as Error;
        cleanup();
        reject(this.failure);
      }
    });
  }

  async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    const bytes = this.bufferedBytes;
    this.buffer = [];
    this.bufferedBytes = 0;
    if (bytes <= this.maxBufferedBytes) {
      await this.write(rows.join('\n') + '\n');
    } else {
      for (const row of rows) {
        for (const fragment of csvByteFragments(row, this.maxBufferedBytes)) {
          await this.write(fragment);
        }
        await this.write('\n');
      }
    }
    if (this.failure) throw this.failure;
  }

  async finish(): Promise<void> {
    await this.flush();
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.ws.removeListener('error', onError);
        this.ws.removeListener('close', onClose);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(this.failure ?? error);
      };
      const onClose = () => {
        this.failure ??= new Error('CSV stream closed before finish');
        cleanup();
        reject(this.failure);
      };
      this.ws.once('error', onError);
      this.ws.once('close', onClose);
      try {
        this.ws.end(() => {
          cleanup();
          if (this.failure) reject(this.failure);
          else resolve();
        });
      } catch (error) {
        this.failure ??= error as Error;
        cleanup();
        reject(this.failure);
      }
    });
  }

  abort(): Promise<void> {
    if (this.aborting) return this.aborting;
    this.failure ??= new Error('CSV writer aborted');
    this.buffer = [];
    this.bufferedBytes = 0;
    // destroyed can be true while an open or close is still pending.
    this.aborting = this.ws.closed ? Promise.resolve() : this.closed;
    this.ws.destroy();
    return this.aborting;
  }
}

export const createBufferedCsvRowWriter: CsvRowWriterFactory = (csvPath, header) =>
  new BufferedCsvRowWriter(csvPath, header);
