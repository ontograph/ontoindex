import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const CACHE_MAX_AGE_DAYS = 30;

export function pageKey(inputs: string[], modelName: string, templateVersion: string): string {
  const sorted = [...inputs].sort().join('\0');
  const data = `${templateVersion}\0${modelName}\0${sorted}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function getCachedPage(cacheDir: string, key: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(cacheDir, `${key}.md`), 'utf-8');
  } catch {
    return null;
  }
}

export async function setCachedPage(cacheDir: string, key: string, content: string): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${key}.md`), content, 'utf-8');
}

export async function evictStaleCache(cacheDir: string): Promise<void> {
  const cutoff = Date.now() - CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await fs.readdir(cacheDir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(cacheDir, f);
    try {
      const stat = await fs.stat(fp);
      if (stat.mtimeMs < cutoff) await fs.unlink(fp);
    } catch {}
  }
}
