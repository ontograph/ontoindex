/**
 * Tracks per-repo use so a long-lived server can drop runtime state for repos nobody is using.
 * Pure bookkeeping: the backend decides what eviction means and owns the cleanup.
 */
export interface RepoIdleOptions {
  /** Idle repos kept before the oldest are evicted. */
  maxIdle?: number;
  idleMs?: number;
  now?: () => number;
}

export class RepoIdleTracker {
  private readonly busy = new Map<string, number>();
  private readonly lastUsed = new Map<string, number>();
  private readonly maxIdle: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(options: RepoIdleOptions = {}) {
    this.maxIdle = options.maxIdle ?? 8;
    this.idleMs = options.idleMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Mark a request as using the repo; the repo cannot be evicted until `end`. */
  begin(repoId: string): void {
    this.busy.set(repoId, (this.busy.get(repoId) ?? 0) + 1);
    this.lastUsed.set(repoId, this.now());
  }

  end(repoId: string): void {
    const count = (this.busy.get(repoId) ?? 0) - 1;
    if (count > 0) this.busy.set(repoId, count);
    else this.busy.delete(repoId);
    this.lastUsed.set(repoId, this.now());
  }

  isBusy(repoId: string): boolean {
    return (this.busy.get(repoId) ?? 0) > 0;
  }

  forget(repoId: string): void {
    this.lastUsed.delete(repoId);
  }

  get size(): number {
    return this.lastUsed.size;
  }

  /** Idle repos to evict now: past the idle time, plus the oldest beyond the idle cap. */
  candidates(): string[] {
    const now = this.now();
    const idle = [...this.lastUsed].filter(([id]) => !this.isBusy(id)).sort((a, b) => a[1] - b[1]);
    const evict = new Set<string>();
    for (const [id, at] of idle) if (now - at >= this.idleMs) evict.add(id);
    const excess = idle.length - this.maxIdle;
    for (let i = 0; i < excess; i++) evict.add(idle[i][0]);
    return [...evict];
  }
}
