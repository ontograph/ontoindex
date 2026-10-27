import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export type DatabaseDigest = { sha256: string; size: number };

export async function digestDatabaseFile(dbPath: string): Promise<DatabaseDigest> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(dbPath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}
