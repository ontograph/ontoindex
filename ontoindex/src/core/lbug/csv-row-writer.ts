import { createWriteStream, type WriteStream } from 'fs';

/** Flush buffered rows to disk every N rows. */
const FLUSH_EVERY = 500;

/** Keep joined batches well below V8's maximum string length. */
export const MAX_BUFFERED_CHARACTERS = 64 * 1024 * 1024;

export interface CsvRowWriter {
  readonly csvPath: string;
  readonly rows: number;
  addRow(row: string): void | Promise<void>;
  finish(): Promise<void>;
}

export type CsvRowWriterFactory = (csvPath: string, header: string) => CsvRowWriter;

export class BufferedCsvRowWriter implements CsvRowWriter {
  private ws: WriteStream;
  private buffer: string[] = [];
  private bufferedCharacters = 0;
  rows = 0;

  constructor(
    public readonly csvPath: string,
    header: string,
    private readonly maxBufferedCharacters = MAX_BUFFERED_CHARACTERS,
  ) {
    this.ws = createWriteStream(csvPath, 'utf-8');
    // Large repos flush many times, so raise listener cap to avoid warning noise.
    this.ws.setMaxListeners(50);
    this.buffer.push(header);
    this.bufferedCharacters = header.length + 1;
  }

  addRow(row: string): void | Promise<void> {
    if (
      this.buffer.length > 0 &&
      this.bufferedCharacters + row.length + 1 > this.maxBufferedCharacters
    ) {
      return this.flush().then(() => this.addRow(row));
    }
    this.buffer.push(row);
    this.bufferedCharacters += row.length + 1;
    this.rows++;
    if (this.buffer.length >= FLUSH_EVERY || this.bufferedCharacters > this.maxBufferedCharacters) {
      return this.flush();
    }
  }

  flush(): Promise<void> {
    if (this.buffer.length === 0) return Promise.resolve();
    const chunk = (this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('\n')) + '\n';
    this.buffer.length = 0;
    this.bufferedCharacters = 0;
    return new Promise((resolve, reject) => {
      this.ws.once('error', reject);
      const ok = this.ws.write(chunk);
      if (ok) {
        this.ws.removeListener('error', reject);
        resolve();
      } else {
        this.ws.once('drain', () => {
          this.ws.removeListener('error', reject);
          resolve();
        });
      }
    });
  }

  async finish(): Promise<void> {
    await this.flush();
    return new Promise((resolve, reject) => {
      this.ws.end(() => resolve());
      this.ws.on('error', reject);
    });
  }
}

export const createBufferedCsvRowWriter: CsvRowWriterFactory = (csvPath, header) =>
  new BufferedCsvRowWriter(csvPath, header);
