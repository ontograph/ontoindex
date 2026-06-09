import { LSPClient, type LSPDefinitionResult, type LSPPrepareRenameResult } from './client.js';
import path from 'path';

export type { LSPPrepareRenameResult };

/**
 * LSP Bridge for managing language-specific servers.
 */
export class LSPBridge {
  private clients = new Map<string, LSPClient>();
  private clientStarts = new Map<string, Promise<LSPClient | null>>();

  /**
   * Get or start a client for a specific language/file extension.
   */
  async getClient(ext: string): Promise<LSPClient | null> {
    if (this.clients.has(ext)) return this.clients.get(ext)!;
    if (this.clientStarts.has(ext)) return this.clientStarts.get(ext)!;

    const start = this.startClient(ext);
    this.clientStarts.set(ext, start);
    try {
      return await start;
    } finally {
      this.clientStarts.delete(ext);
    }
  }

  private async startClient(ext: string): Promise<LSPClient | null> {
    if (this.clients.has(ext)) return this.clients.get(ext)!;
    let client: LSPClient | null = null;

    if (ext === '.ts' || ext === '.js') {
      // requires: npm install -g typescript-language-server typescript
      client = new LSPClient('typescript-language-server', ['--stdio']);
    } else if (ext === '.py') {
      // requires: pip install pyright
      client = new LSPClient('pyright-langserver', ['--stdio']);
    }

    if (client) {
      try {
        await client.start();
        if (this.clients.has(ext)) {
          await client.stop().catch(() => {});
          return this.clients.get(ext)!;
        }
        this.clients.set(ext, client);
        return client;
      } catch (err) {
        console.warn(`[LSPBridge] Failed to start client for ${ext}:`, err);
        await client.stop().catch(() => {});
        return null;
      }
    }

    return null;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.clientStarts.values());
    this.clientStarts.clear();
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
  }

  /**
   * Resolve a symbol using LSP if possible.
   */
  async resolveSymbol(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPDefinitionResult> {
    const ext = path.extname(filePath);
    const client = await this.getClient(ext);
    if (!client) return null;

    return client.findDefinition(filePath, line, character);
  }

  /**
   * Best-effort rename validation using textDocument/prepareRename.
   *
   * Returns { supported: false } when the LSP server is unavailable for the
   * file extension, or when the server indicates rename is not possible.
   */
  async validateRename(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPPrepareRenameResult> {
    const ext = path.extname(filePath);
    const client = await this.getClient(ext);
    if (!client) return { supported: false };
    return client.prepareRename(filePath, line, character);
  }
}

export const lspBridge = new LSPBridge();
