import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueryExecutionDiagnostics } from '../runtime/query-diagnostics.js';
import type { RetrievalCandidate } from '../../mcp/local/backend-search.js';
import type { TypedQueryFilter } from './typed-query-document.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

export type SemanticCacheLookupStatus = 'hit' | 'miss' | 'stale' | 'expired';

export interface SemanticCacheLookupResult {
  status: SemanticCacheLookupStatus;
  result: CachedQueryResult | null;
  ageMs?: number;
}

export interface SemanticCacheSetResult {
  evicted: number;
}

export interface SemanticRetrievalCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface CachedQueryResult {
  candidates: RetrievalCandidate[];
  diagnostics: Partial<QueryExecutionDiagnostics>;
  timestamp: number;
  indexedHead: string;
}

export class SemanticRetrievalCache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(repoPath: string | undefined, options: SemanticRetrievalCacheOptions = {}) {
    this.cacheDir = join(repoPath ?? process.cwd(), '.ontoindex', 'cache', 'semantic');
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes ?? Infinity));
    this.now = options.now ?? Date.now;
  }

  async get(key: string, indexedHead: string): Promise<CachedQueryResult | null> {
    const lookup = await this.lookup(key, indexedHead);
    return lookup.result;
  }

  async lookup(key: string, indexedHead: string): Promise<SemanticCacheLookupResult> {
    try {
      const path = join(this.cacheDir, `${key}.json`);
      const data = await readFile(path, 'utf8');
      const cached: unknown = JSON.parse(data);
      if (!isCachedQueryResult(cached)) return { status: 'miss', result: null };
      const ageMs = Math.max(0, this.now() - cached.timestamp);

      if (cached.indexedHead !== indexedHead) {
        return { status: 'stale', result: null, ageMs };
      }

      if (ageMs > this.ttlMs) {
        await unlink(path).catch(() => {});
        return { status: 'expired', result: null, ageMs };
      }

      return { status: 'hit', result: cached, ageMs };
    } catch {
      return { status: 'miss', result: null };
    }
  }

  async set(
    key: string,
    result: Omit<CachedQueryResult, 'timestamp'>,
  ): Promise<SemanticCacheSetResult> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const path = join(this.cacheDir, `${key}.json`);
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const data = JSON.stringify({
        ...result,
        timestamp: this.now(),
      });
      try {
        await writeFile(temporaryPath, data, 'utf8');
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
      return { evicted: await this.evictOverflow() };
    } catch {
      // Best-effort
      return { evicted: 0 };
    }
  }

  private async evictOverflow(): Promise<number> {
    const names = (await readdir(this.cacheDir)).filter((name) => name.endsWith('.json'));
    const readSnapshot = async (path: string) => {
      const handle = await open(path, 'r');
      try {
        const data = await handle.readFile();
        const stats = await handle.stat();
        return {
          data,
          bytes: stats.size,
          identity: `${stats.dev}:${stats.ino}`,
        };
      } finally {
        await handle.close();
      }
    };
    const scanned = await Promise.all(
      names.map(async (name) => {
        try {
          const path = join(this.cacheDir, name);
          const snapshot = await readSnapshot(path);
          try {
            const cached: unknown = JSON.parse(snapshot.data.toString('utf8'));
            if (!isCachedQueryResult(cached)) throw new Error('Invalid cache entry');
            return { name, timestamp: cached.timestamp, garbage: false, ...snapshot };
          } catch {
            return { name, timestamp: 0, garbage: true, ...snapshot };
          }
        } catch {
          return null;
        }
      }),
    );

    const entries = scanned
      .filter((entry) => entry !== null)
      .sort(
        (a, b) =>
          Number(b.garbage) - Number(a.garbage) ||
          a.timestamp - b.timestamp ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
    let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    let evicted = 0;
    while (entries[0]?.garbage || entries.length > this.maxEntries || totalBytes > this.maxBytes) {
      const entry = entries.shift();
      if (!entry) break;
      try {
        const path = join(this.cacheDir, entry.name);
        await this.beforeEvictionCheck(path);
        const evictionPath = `${path}.${process.pid}.${randomUUID()}.evict.tmp`;
        await rename(path, evictionPath);
        const current = await readSnapshot(evictionPath);
        if (current.identity !== entry.identity || !current.data.equals(entry.data)) {
          await link(evictionPath, path).catch(() => {});
          await unlink(evictionPath).catch(() => {});
          continue;
        }
        await unlink(evictionPath);
        totalBytes -= entry.bytes;
        evicted++;
      } catch {
        // Best-effort
      }
    }
    return evicted;
  }

  protected async beforeEvictionCheck(_path: string): Promise<void> {}

  static computeKey(params: {
    query: string;
    retrievalPolicy?: string;
    capabilities: string[];
    indexedHead: string;
    embeddingModelHash?: string;
    filters?: TypedQueryFilter[];
  }): string {
    const raw = JSON.stringify({
      q: params.query,
      p: params.retrievalPolicy,
      c: [...params.capabilities].sort(),
      h: params.indexedHead,
      e: params.embeddingModelHash,
      f: params.filters
        ? [...params.filters]
            .map((filter) => ({
              field: filter.field,
              operator: filter.operator,
              value: filter.value,
            }))
            .sort((a, b) =>
              `${a.field}:${a.operator}:${a.value}`.localeCompare(
                `${b.field}:${b.operator}:${b.value}`,
              ),
            )
        : undefined,
    });
    return createHash('sha256').update(raw).digest('hex');
  }
}

function isCachedQueryResult(value: unknown): value is CachedQueryResult {
  if (!value || typeof value !== 'object') return false;
  const cached = value as Partial<CachedQueryResult>;
  return (
    Array.isArray(cached.candidates) &&
    !!cached.diagnostics &&
    typeof cached.diagnostics === 'object' &&
    Number.isFinite(cached.timestamp) &&
    typeof cached.indexedHead === 'string'
  );
}
