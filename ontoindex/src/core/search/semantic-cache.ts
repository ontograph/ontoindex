import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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
  private readonly now: () => number;

  constructor(repoPath: string | undefined, options: SemanticRetrievalCacheOptions = {}) {
    this.cacheDir = join(repoPath ?? process.cwd(), '.ontoindex', 'cache', 'semantic');
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
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
      const cached: CachedQueryResult = JSON.parse(data);
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
      const data = JSON.stringify({
        ...result,
        timestamp: this.now(),
      });
      await writeFile(path, data, 'utf8');
      return { evicted: await this.evictOverflow() };
    } catch {
      // Best-effort
      return { evicted: 0 };
    }
  }

  private async evictOverflow(): Promise<number> {
    const names = (await readdir(this.cacheDir)).filter((name) => name.endsWith('.json'));
    const overflow = names.length - this.maxEntries;
    if (overflow <= 0) return 0;

    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          const path = join(this.cacheDir, name);
          const data = await readFile(path, 'utf8');
          const cached = JSON.parse(data) as Partial<CachedQueryResult>;
          return { name, timestamp: Number(cached.timestamp) || 0 };
        } catch {
          return { name, timestamp: 0 };
        }
      }),
    );

    const evictable = entries.sort((a, b) => a.timestamp - b.timestamp).slice(0, overflow);
    let evicted = 0;
    for (const entry of evictable) {
      try {
        await unlink(join(this.cacheDir, entry.name));
        evicted++;
      } catch {
        // Best-effort
      }
    }
    return evicted;
  }

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
