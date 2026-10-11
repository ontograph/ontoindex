import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { resolveContainedMetadataPath } from '../../mcp/local/path-util.js';

interface SessionStore {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<void>;
  list(): Promise<string[]>;
}

const MAX_SESSION_SIZE = 1 * 1024 * 1024; // 1 MB

function getThrownField(value: unknown, field: 'code' | 'message'): unknown {
  return (value as Record<'code' | 'message', unknown>)[field];
}

export class FileSessionStore implements SessionStore {
  private readonly repoPath: string;
  private readonly filePath: string;

  constructor(repoPath: string, sessionId: string) {
    if (
      !sessionId ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      sessionId.includes('\0')
    ) {
      throw new Error('Invalid session ID');
    }
    this.repoPath = repoPath;
    this.filePath = path.join(repoPath, '.ontoindex', 'sessions', `${sessionId}.json`);
  }

  private async ensureDir(): Promise<void> {
    const safePath = await this.resolvePath();
    await fs.mkdir(path.dirname(safePath), { recursive: true });
  }

  private resolvePath(): Promise<string> {
    return resolveContainedMetadataPath(this.repoPath, this.filePath);
  }

  private async load(): Promise<Record<string, string>> {
    try {
      const content = await fs.readFile(await this.resolvePath(), 'utf-8');
      return JSON.parse(content);
    } catch (e: unknown) {
      if (getThrownField(e, 'code') === 'ENOENT') {
        return {};
      }
      throw new Error(`Failed to load session store: ${getThrownField(e, 'message')}`);
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(content, 'utf-8') > MAX_SESSION_SIZE) {
      throw new Error('Session store exceeds 1 MB cap');
    }
    await this.ensureDir();
    const filePath = await this.resolvePath();
    const tempPath = await resolveContainedMetadataPath(
      this.repoPath,
      `${filePath}.${randomUUID()}.tmp`,
    );
    let created = false;
    try {
      const handle = await fs.open(tempPath, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(content, 'utf-8');
      } finally {
        await handle.close();
      }
      await resolveContainedMetadataPath(this.repoPath, tempPath);
      await fs.rename(tempPath, await this.resolvePath());
    } catch (error) {
      if (created)
        await resolveContainedMetadataPath(this.repoPath, tempPath)
          .then((safePath) => fs.rm(safePath, { force: true }))
          .catch(() => undefined);
      throw error;
    }
  }

  async get(k: string): Promise<string | null> {
    const data = await this.load();
    return Object.hasOwn(data, k) ? data[k] : null;
  }

  async set(k: string, v: string): Promise<void> {
    const filePath = await this.resolvePath();
    const lockPath = `${filePath}.lock`;
    await this.ensureDir();
    const owner = randomUUID();
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        lock = await fs.open(
          await resolveContainedMetadataPath(this.repoPath, lockPath),
          'wx',
          0o600,
        );
        break;
      } catch (error) {
        if (getThrownField(error, 'code') !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!lock) throw new Error(`Timed out acquiring session store lock: ${lockPath}`);
    try {
      await lock.writeFile(owner, 'utf-8');
      const data = await this.load();
      Object.defineProperty(data, k, {
        value: v,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      await this.save(data);
    } finally {
      try {
        const safeLock = await resolveContainedMetadataPath(this.repoPath, lockPath);
        if ((await fs.readFile(safeLock, 'utf-8')) === owner) await fs.unlink(safeLock);
      } finally {
        await lock.close();
      }
    }
  }

  async list(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data);
  }
}
