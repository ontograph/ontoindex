import fs from 'fs/promises';
import path from 'path';

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
  private readonly filePath: string;

  constructor(repoPath: string, sessionId: string) {
    if (!sessionId || sessionId.includes('/') || sessionId.includes('\\')) {
      throw new Error('Invalid session ID');
    }
    this.filePath = path.join(repoPath, '.ontoindex', 'sessions', `${sessionId}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  private async load(): Promise<Record<string, string>> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
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
    await fs.writeFile(this.filePath, content, 'utf-8');
  }

  async get(k: string): Promise<string | null> {
    const data = await this.load();
    return data[k] ?? null;
  }

  async set(k: string, v: string): Promise<void> {
    const data = await this.load();
    data[k] = v;
    await this.save(data);
  }

  async list(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data);
  }
}
