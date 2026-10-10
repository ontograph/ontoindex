import fs from 'node:fs';
import path from 'node:path';

export interface DebouncedWatcherOptions {
  root: string;
  debounceMs?: number;
  isLockHeld: () => Promise<boolean> | boolean;
  refresh: () => Promise<void>;
  shouldIgnore?: (relPath: string) => boolean;
  log?: (msg: string) => void;
  watchImpl?: typeof fs.watch;
}

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
const IGNORED_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.avi',
  '.bin',
  '.bmp',
  '.class',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.lock',
  '.log',
  '.mp3',
  '.mp4',
  '.o',
  '.pdf',
  '.png',
  '.so',
  '.sqlite',
  '.swp',
  '.tar',
  '.tmp',
  '.ttf',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

function isIgnoredByDefault(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => IGNORED_DIRECTORIES.has(part))) return true;
  return IGNORED_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

export function createDebouncedWatcher(opts: DebouncedWatcherOptions): {
  start(): void;
  stop(): void;
} {
  const watch = opts.watchImpl ?? fs.watch;
  const debounceMs = opts.debounceMs ?? 750;
  const log = opts.log ?? (() => {});
  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let followUp = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runRefresh();
    }, debounceMs);
  };

  const runRefresh = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      followUp = true;
      return;
    }

    running = true;
    let lockHeld = false;
    try {
      lockHeld = await opts.isLockHeld();
      if (lockHeld) {
        log('Skipping refresh because analyze.lock is held.');
        return;
      }
      await opts.refresh();
    } catch (error) {
      log(`Watcher refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      if (lockHeld) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        followUp = false;
      }
      if (!stopped && followUp) {
        followUp = false;
        if (timer) return;
        void runRefresh();
      }
    }
  };

  const onChange = (_eventType: string, filename: string | Buffer | null) => {
    if (stopped) return;
    const relPath = filename == null ? '' : filename.toString();
    if (isIgnoredByDefault(relPath) || opts.shouldIgnore?.(relPath)) return;
    schedule();
  };

  return {
    start() {
      if (watcher || stopped) return;
      watcher = watch(opts.root, { recursive: true }, onChange);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      followUp = false;
      watcher?.close();
      watcher = undefined;
    },
  };
}
