import { createWriteStream, type WriteStream } from 'fs';

/** Flush buffered rows to disk every N rows. */
const FLUSH_EVERY = 500;

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
  rows = 0;

  constructor(
    public readonly csvPath: string,
    header: string,
  ) {
    this.ws = createWriteStream(csvPath, 'utf-8');
    // Large repos flush many times, so raise listener cap to avoid warning noise.
    this.ws.setMaxListeners(50);
    this.buffer.push(header);
  }

  addRow(row: string): void | Promise<void> {
    this.buffer.push(row);
    this.rows++;
    if (this.buffer.length >= FLUSH_EVERY) {
      return this.flush();
    }
  }

  flush(): Promise<void> {
    if (this.buffer.length === 0) return Promise.resolve();
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer.length = 0;
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
