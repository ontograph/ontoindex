import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BufferedCsvRowWriter } from '../../src/core/lbug/csv-row-writer.js';

describe('BufferedCsvRowWriter', () => {
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
