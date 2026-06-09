import { spawn, ChildProcess } from 'child_process';

const parsePositiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const MAX_LSP_HEADER_BYTES = parsePositiveIntEnv('ONTOINDEX_LSP_MAX_HEADER_BYTES', 64 * 1024);
const MAX_LSP_BODY_BYTES = parsePositiveIntEnv('ONTOINDEX_LSP_MAX_BODY_BYTES', 10 * 1024 * 1024);

interface LSPPosition {
  line: number;
  character: number;
}

interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPLocationLink {
  targetUri: string;
  targetRange: LSPRange;
  targetSelectionRange: LSPRange;
  originSelectionRange?: LSPRange;
}

export type LSPDefinitionResult = LSPLocation | LSPLocation[] | LSPLocationLink[] | null;
export type LSPReferenceResult = LSPLocation[] | null;

export interface LSPPrepareRenameResult {
  /** Whether the LSP server confirmed rename is supported at the queried position. */
  supported: boolean;
  /** Validated rename range returned by the server, if available. */
  range?: LSPRange;
  /** Default placeholder name suggested by the server, if available. */
  placeholder?: string;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asJsonRpcResponse = (value: unknown): JsonRpcResponse | null =>
  isRecord(value) ? value : null;

const rpcErrorMessage = (error: unknown): string => {
  if (isRecord(error) && error.message != null) return String(error.message);
  return JSON.stringify(error);
};

/**
 * Basic LSP Client for precision symbol resolution.
 *
 * Communicates with a local Language Server (e.g. typescript-language-server)
 * via JSON-RPC over stdin/stdout.
 */
export class LSPClient {
  private process: ChildProcess | null = null;
  private requestId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private pendingRequests = new Map<
    number,
    {
      resolve: (res: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private _spawnFailed = false;
  private readonly requestTimeoutMs = Number.parseInt(
    process.env.ONTOINDEX_LSP_REQUEST_TIMEOUT_MS ?? '5000',
    10,
  );

  constructor(
    private command: string,
    private args: string[] = [],
  ) {}

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'inherit'] });

    // Wait for the spawn 'error' or 'spawn' event before touching stdin/stdout.
    // This prevents an uncaught-exception when the binary is not installed (ENOENT/EACCES).
    await new Promise<void>((resolve, reject) => {
      this.process!.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          console.warn(
            `[lsp-bridge] Language server '${this.command}' not found in PATH — LSP disabled for this client`,
          );
        } else {
          console.warn(`[lsp-bridge] LSP server spawn failed: ${err.message}`);
        }
        this._spawnFailed = true;
        reject(err);
      });
      this.process!.once('spawn', resolve);
    });

    if (!this.process.stdout) throw new Error('Failed to open LSP stdout');

    this.process.once('exit', (code, signal) => {
      this._spawnFailed = true;
      this.failPending(
        new Error(
          `[lsp-bridge] Language server exited${code !== null ? ` with code ${code}` : ''}${
            signal ? ` via ${signal}` : ''
          }`,
        ),
      );
    });
    this.process.once('error', (err) => {
      this._spawnFailed = true;
      this.failPending(err instanceof Error ? err : new Error(String(err)));
    });

    this.process.stdout.on('data', (chunk: Buffer | string) => {
      this.handleStdoutData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    // Initialize LSP
    await this.request('initialize', {
      processId: process.pid,
      rootUri: `file://${process.cwd()}`,
      capabilities: {},
    });
    await this.notify('initialized', {});
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.stdoutBuffer = Buffer.alloc(0);
    this.failPending(new Error('[lsp-bridge] Language server stopped'));
  }

  private handleStdoutData(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (this.stdoutBuffer.length > 0) {
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.stdoutBuffer.length > MAX_LSP_HEADER_BYTES) {
          this.failProtocol(
            `LSP header exceeded ${MAX_LSP_HEADER_BYTES} bytes before Content-Length terminator`,
          );
        }
        return;
      }

      if (headerEnd > MAX_LSP_HEADER_BYTES) {
        this.failProtocol(`LSP header exceeded ${MAX_LSP_HEADER_BYTES} bytes`);
        return;
      }

      const header = this.stdoutBuffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      const bodyStart = headerEnd + 4;
      if (!lengthMatch) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(bodyStart);
        continue;
      }

      const bodyLength = Number.parseInt(lengthMatch[1], 10);
      if (!Number.isFinite(bodyLength) || bodyLength < 0) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(bodyStart);
        continue;
      }
      if (bodyLength > MAX_LSP_BODY_BYTES) {
        this.failProtocol(`LSP frame body exceeded ${MAX_LSP_BODY_BYTES} bytes`);
        return;
      }
      if (this.stdoutBuffer.length < bodyStart + bodyLength) return;

      const body = this.stdoutBuffer.subarray(bodyStart, bodyStart + bodyLength).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyStart + bodyLength);

      try {
        const payload = asJsonRpcResponse(JSON.parse(body));
        const id = typeof payload?.id === 'number' ? payload.id : undefined;
        if (id !== undefined && this.pendingRequests.has(id)) {
          const pending = this.pendingRequests.get(id)!;
          this.pendingRequests.delete(id);
          clearTimeout(pending.timer);
          if (payload.error) {
            pending.reject(new Error(rpcErrorMessage(payload.error)));
          } else {
            pending.resolve(payload.result);
          }
        }
      } catch {
        // Ignore malformed server frames.
      }
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T | null> {
    if (this._spawnFailed) return Promise.resolve(null);
    if (!this.process?.stdin?.writable) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const timeoutMs = Number.isFinite(this.requestTimeoutMs)
        ? Math.max(1000, this.requestTimeoutMs)
        : 5000;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`[lsp-bridge] ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process!.stdin!.write(
        `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`,
        (err) => {
          if (!err) return;
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private failPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }

  private failProtocol(message: string): void {
    this._spawnFailed = true;
    this.stdoutBuffer = Buffer.alloc(0);
    this.failPending(new Error(`[lsp-bridge] ${message}`));
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  notify(method: string, params: unknown): void {
    if (this._spawnFailed) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process?.stdin?.write(
      `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`,
    );
  }

  /**
   * Find definition of a symbol at a given position.
   */
  async findDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPDefinitionResult> {
    if (this._spawnFailed) return null;
    return this.request<LSPDefinitionResult>('textDocument/definition', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    });
  }

  /**
   * Find references of a symbol at a given position.
   */
  async findReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPReferenceResult> {
    if (this._spawnFailed) return [];
    return this.request<LSPReferenceResult>('textDocument/references', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { includeDeclaration: true },
    });
  }

  /**
   * Best-effort rename validation using textDocument/prepareRename.
   *
   * Reports whether the LSP server confirms rename is supported at the given
   * position, along with the validated range and placeholder if returned.
   * Never throws — returns { supported: false } on any error or missing server.
   */
  async prepareRename(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LSPPrepareRenameResult> {
    if (this._spawnFailed) return { supported: false };
    try {
      const result = await this.request<unknown>('textDocument/prepareRename', {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
      });
      if (result === null || result === undefined) return { supported: false };
      if (isRecord(result)) {
        // { defaultBehavior: true } — server confirms rename is supported generically.
        if (result['defaultBehavior'] === true) return { supported: true };
        // { range: Range; placeholder?: string } — server returns the rename range.
        if (isRecord(result['range'])) {
          return {
            supported: true,
            range: result['range'] as unknown as LSPRange,
            placeholder:
              typeof result['placeholder'] === 'string' ? result['placeholder'] : undefined,
          };
        }
        // Plain Range shape: { start: {...}, end: {...} }
        if (isRecord(result['start']) && isRecord(result['end'])) {
          return { supported: true, range: result as unknown as LSPRange };
        }
      }
      return { supported: false };
    } catch {
      return { supported: false };
    }
  }
}
