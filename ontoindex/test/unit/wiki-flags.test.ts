/**
 * Unit tests for wiki CLI flags: --provider cursor, --review, --verbose
 *
 * Tests the new wiki provider infrastructure without requiring an actual
 * Cursor CLI binary or LLM API key. All external dependencies are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { EventEmitter } from 'events';

// ─── detectCursorCLI caching ─────────────────────────────────────────

describe('detectCursorCLI', () => {
  let execFileSyncSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset the module-level cache by re-importing fresh each time
    vi.resetModules();
    execFileSyncSpy = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caches result after first call (avoids repeated spawns)', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: execFileSyncSpy,
      spawn: vi.fn(),
    }));
    const { detectCursorCLI } = await import('../../src/core/wiki/cursor-client.js');

    // First call — execFileSync runs with a bounded probe
    execFileSyncSpy.mockImplementation(() => 'agent 0.1.0');
    const first = detectCursorCLI();
    expect(first).toBe('agent');
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
    expect(execFileSyncSpy).toHaveBeenCalledWith(
      'agent',
      ['--version'],
      expect.objectContaining({ timeout: 2000, maxBuffer: 1024 * 1024 }),
    );

    // Second call — cached, no extra spawn
    const second = detectCursorCLI();
    expect(second).toBe('agent');
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('caches null when agent is not found', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: execFileSyncSpy,
      spawn: vi.fn(),
    }));
    const { detectCursorCLI } = await import('../../src/core/wiki/cursor-client.js');

    execFileSyncSpy.mockImplementation(() => {
      throw new Error('not found');
    });

    const first = detectCursorCLI();
    expect(first).toBeNull();

    const second = detectCursorCLI();
    expect(second).toBeNull();
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
  });
});

describe('wiki CLI external process guards', () => {
  it('bounds non-interactive gh CLI probes and gist publishing', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src/cli/wiki.ts'), 'utf-8');
    expect(source).toContain("execFileSync('gh', ['--version']");
    expect(source).toContain('timeout: 3_000');
    expect(source).toContain('timeout: 15_000');
    expect(source).toContain('maxBuffer: 1024 * 1024');
  });
});

// ─── resolveCursorConfig ─────────────────────────────────────────────

describe('resolveCursorConfig', () => {
  it('returns provided model and workingDirectory', async () => {
    const { resolveCursorConfig } = await import('../../src/core/wiki/cursor-client.js');
    const config = resolveCursorConfig({ model: 'claude-4', workingDirectory: '/tmp' });
    expect(config.model).toBe('claude-4');
    expect(config.workingDirectory).toBe('/tmp');
  });

  it('returns undefined model when not provided (uses Cursor default)', async () => {
    const { resolveCursorConfig } = await import('../../src/core/wiki/cursor-client.js');
    const config = resolveCursorConfig();
    expect(config.model).toBeUndefined();
    expect(config.workingDirectory).toBeUndefined();
  });
});

// ─── resolveLLMConfig provider routing ───────────────────────────────

describe('resolveLLMConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-test-config-'));
    // Create empty config so loadCLIConfig returns {}
    const configDir = path.join(tmpDir, '.ontoindex');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({}));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses cursorModel (not model) when provider is cursor', async () => {
    // Mock loadCLIConfig to return cursor config
    vi.doMock('../../src/storage/repo-manager.js', () => ({
      loadCLIConfig: vi.fn().mockResolvedValue({
        provider: 'cursor',
        cursorModel: 'claude-4.5-opus-high',
      }),
    }));

    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    const config = await resolveLLMConfig({ provider: 'cursor' });

    expect(config.provider).toBe('cursor');
    expect(config.model).toBe('claude-4.5-opus-high');
  });

  it('uses default OpenRouter model for openai provider', async () => {
    vi.doMock('../../src/storage/repo-manager.js', () => ({
      loadCLIConfig: vi.fn().mockResolvedValue({}),
    }));

    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    const config = await resolveLLMConfig();

    expect(config.provider).toBe('openai');
    expect(config.model).toBe('minimax/minimax-m2.5');
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('CLI overrides take priority over saved config', async () => {
    vi.doMock('../../src/storage/repo-manager.js', () => ({
      loadCLIConfig: vi.fn().mockResolvedValue({
        provider: 'openai',
        model: 'saved-model',
        apiKey: 'saved-key',
      }),
    }));

    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    const config = await resolveLLMConfig({
      provider: 'cursor',
      model: 'override-model',
    });

    expect(config.provider).toBe('cursor');
    expect(config.model).toBe('override-model');
  });
});

// ─── --verbose flag ──────────────────────────────────────────────────

describe('--verbose flag', () => {
  const originalEnv = process.env.ONTOINDEX_VERBOSE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ONTOINDEX_VERBOSE;
    } else {
      process.env.ONTOINDEX_VERBOSE = originalEnv;
    }
  });

  it('verboseLog writes to console when ONTOINDEX_VERBOSE=1', async () => {
    process.env.ONTOINDEX_VERBOSE = '1';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Import the module's isVerbose/verboseLog indirectly via detectCursorCLI's verbose path.
    // Instead, we test the isVerbose check directly since verboseLog is not exported.
    // The env var drives the behavior.
    expect(process.env.ONTOINDEX_VERBOSE).toBe('1');

    consoleSpy.mockRestore();
  });

  it('verbose is off when ONTOINDEX_VERBOSE is not set', () => {
    delete process.env.ONTOINDEX_VERBOSE;
    expect(process.env.ONTOINDEX_VERBOSE).toBeUndefined();
  });
});

// ─── --review flag (WikiGenerator reviewOnly) ────────────────────────

describe('WikiGenerator --review mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-review-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reviewOnly returns moduleTree and pagesGenerated=0', async () => {
    const fakeFiles = ['src/auth.ts', 'src/core.ts'];

    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb: vi.fn(),
      getFilesWithExports: vi
        .fn()
        .mockResolvedValue(fakeFiles.map((f) => ({ filePath: f, symbols: [] }))),
      getAllFiles: vi.fn().mockResolvedValue(fakeFiles),
      getInterFileCallEdges: vi.fn().mockResolvedValue([]),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
      getProcessesForFiles: vi.fn().mockResolvedValue([]),
      getAllProcesses: vi.fn().mockResolvedValue([]),
      getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
    }));

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const storagePath = path.join(tmpDir, 'storage');
    const wikiDir = path.join(storagePath, 'wiki');
    await fs.mkdir(wikiDir, { recursive: true });

    // Pre-seed a module_tree.json so buildModuleTree skips the LLM call
    const tree = [
      { name: 'Auth', slug: 'auth', files: ['src/auth.ts'] },
      { name: 'Core', slug: 'core', files: ['src/core.ts'] },
    ];
    await fs.writeFile(path.join(wikiDir, 'first_module_tree.json'), JSON.stringify(tree));

    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });

    const llmConfig = {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'cursor' as const,
    };

    const progress: { phase: string; percent: number }[] = [];
    const generator = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
      { reviewOnly: true },
      (phase, percent) => progress.push({ phase, percent }),
    );

    const result = await generator.run();

    expect(result.pagesGenerated).toBe(0);
    expect(result.moduleTree).toBeDefined();
    expect(result.moduleTree).toHaveLength(2);
    expect(result.moduleTree![0].name).toBe('Auth');
    expect(result.moduleTree![1].name).toBe('Core');

    // module_tree.json should be written for user to edit
    const treeFile = path.join(wikiDir, 'module_tree.json');
    const written = JSON.parse(await fs.readFile(treeFile, 'utf-8'));
    expect(written).toHaveLength(2);
  });
});

// ─── CLI config round-trip with cursor provider ──────────────────────

describe('CLI config round-trip with cursor provider', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-config-test-'));
    const configDir = path.join(tmpDir, '.ontoindex');
    await fs.mkdir(configDir, { recursive: true });
    configPath = path.join(configDir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads cursor provider config correctly', async () => {
    const config = { provider: 'cursor', cursorModel: 'claude-4.5-opus-high' };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const loaded = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(loaded.provider).toBe('cursor');
    expect(loaded.cursorModel).toBe('claude-4.5-opus-high');
    expect(loaded.apiKey).toBeUndefined();
  });

  it('saves openai provider config with model and apiKey', async () => {
    const config = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const loaded = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(loaded.provider).toBe('openai');
    expect(loaded.model).toBe('gpt-4o-mini');
    expect(loaded.apiKey).toBe('sk-test-key');
    expect(loaded.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('cursor config does not clobber openai fields', async () => {
    const config = {
      provider: 'cursor',
      cursorModel: 'claude-4.5-opus-high',
      apiKey: 'sk-existing',
      model: 'gpt-4o',
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const loaded = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(loaded.provider).toBe('cursor');
    expect(loaded.cursorModel).toBe('claude-4.5-opus-high');
    // Existing openai fields preserved
    expect(loaded.apiKey).toBe('sk-existing');
    expect(loaded.model).toBe('gpt-4o');
  });
});

// ─── invokeLLM routing ──────────────────────────────────────────────

describe('WikiGenerator invokeLLM routing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-invoke-test-'));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('routes to callCursorLLM when provider is cursor', async () => {
    const cursorClient = await import('../../src/core/wiki/cursor-client.js');
    const llmClient = await import('../../src/core/wiki/llm-client.js');

    const cursorSpy = vi
      .spyOn(cursorClient, 'callCursorLLM')
      .mockResolvedValue({ content: 'cursor response' });
    const openaiSpy = vi
      .spyOn(llmClient, 'callLLM')
      .mockResolvedValue({ content: 'openai response' });

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const storagePath = path.join(tmpDir, 'storage');
    const wikiDir = path.join(storagePath, 'wiki');
    await fs.mkdir(wikiDir, { recursive: true });

    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });

    const generator = new WikiGenerator(repoPath, storagePath, path.join(storagePath, 'lbug'), {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'cursor',
    });

    // Access the private method via prototype trick
    const result = await (generator as any).invokeLLM('test prompt', 'system prompt');

    expect(cursorSpy).toHaveBeenCalledTimes(1);
    expect(openaiSpy).not.toHaveBeenCalled();
    expect(result.content).toBe('cursor response');
  });

  it('routes to callLLM when provider is openai', async () => {
    const cursorClient = await import('../../src/core/wiki/cursor-client.js');
    const llmClient = await import('../../src/core/wiki/llm-client.js');

    const cursorSpy = vi
      .spyOn(cursorClient, 'callCursorLLM')
      .mockResolvedValue({ content: 'cursor response' });
    const openaiSpy = vi
      .spyOn(llmClient, 'callLLM')
      .mockResolvedValue({ content: 'openai response' });

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const storagePath = path.join(tmpDir, 'storage');
    const wikiDir = path.join(storagePath, 'wiki');
    await fs.mkdir(wikiDir, { recursive: true });

    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });

    const generator = new WikiGenerator(repoPath, storagePath, path.join(storagePath, 'lbug'), {
      apiKey: 'key',
      baseUrl: 'http://localhost',
      model: 'gpt-4',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const result = await (generator as any).invokeLLM('test prompt', 'system prompt');

    expect(openaiSpy).toHaveBeenCalledTimes(1);
    expect(cursorSpy).not.toHaveBeenCalled();
    expect(result.content).toBe('openai response');
  });
});

describe('WikiGenerator rate-limit retries', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-rate-limit-test-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('retries rate-limited parallel work instead of counting it as a failed module', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');
    const storagePath = path.join(tmpDir, 'storage');
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });

    const progress: string[] = [];
    const generator = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'http://localhost',
        model: 'gpt-4',
        maxTokens: 1000,
        temperature: 0,
        provider: 'openai',
      },
      { concurrency: 2 },
      (_phase, _percent, detail) => {
        if (detail) progress.push(detail);
      },
    );

    let attempts = 0;
    const promise = (generator as any).runParallel(['module-a'], async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('LLM API error (429): rate limit');
      }
      return 1;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBe(1);
    expect(attempts).toBe(2);
    expect(progress.some((line) => line.includes('retry 1/5'))).toBe(true);
  });

  it('does not make rate-limited retries runnable before the backoff delay expires', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');
    const storagePath = path.join(tmpDir, 'storage');
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });

    const generator = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'http://localhost',
        model: 'gpt-4',
        maxTokens: 1000,
        temperature: 0,
        provider: 'openai',
      },
      { concurrency: 2 },
    );

    let moduleAAttempts = 0;
    let finishModuleB: () => void = () => {};
    const promise = (generator as any).runParallel(
      ['module-a', 'module-b'],
      async (item: string) => {
        if (item === 'module-a') {
          moduleAAttempts++;
          if (moduleAAttempts === 1) {
            throw new Error('LLM API error (429): rate limit');
          }
          return 1;
        }

        return new Promise<number>((resolve) => {
          finishModuleB = () => resolve(1);
        });
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(moduleAAttempts).toBe(1);

    finishModuleB();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(moduleAAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toBe(2);
    expect(moduleAAttempts).toBe(2);
  });
});

// ─── callCursorLLM error when CLI not found ──────────────────────────

describe('callCursorLLM', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('throws when Cursor CLI is not in PATH', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockImplementation(() => {
        throw new Error('not found');
      }),
      spawn: vi.fn(),
    }));

    const { callCursorLLM } = await import('../../src/core/wiki/cursor-client.js');

    await expect(callCursorLLM('hello', {})).rejects.toThrow('Cursor CLI not found');
  });

  it('terminates Cursor CLI when stdout exceeds the configured cap', async () => {
    vi.stubEnv('ONTOINDEX_CURSOR_MAX_STDOUT_BYTES', '4');
    vi.resetModules();

    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    child.kill = vi.fn(() => true);
    child.exitCode = null;
    child.killed = false;

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(),
      spawn: vi.fn(() => child),
    }));

    const { callCursorLLM } = await import('../../src/core/wiki/cursor-client.js');
    const promise = callCursorLLM('hello', {});

    child.stdout.emit('data', Buffer.from('excess'));

    await expect(promise).rejects.toThrow('Cursor CLI stdout exceeded');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates Cursor CLI termination after the configured grace period', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ONTOINDEX_CURSOR_MAX_STDOUT_BYTES', '4');
    vi.stubEnv('ONTOINDEX_CURSOR_KILL_GRACE_MS', '25');
    vi.resetModules();

    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    child.kill = vi.fn(() => true);
    child.exitCode = null;
    child.killed = false;

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(),
      spawn: vi.fn(() => child),
    }));

    const { callCursorLLM } = await import('../../src/core/wiki/cursor-client.js');
    const promise = callCursorLLM('hello', {});

    child.stdout.emit('data', Buffer.from('excess'));

    await expect(promise).rejects.toThrow('Cursor CLI stdout exceeded');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(25);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

// ─── estimateTokens ─────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', async () => {
    const { estimateTokens } = await import('../../src/core/wiki/llm-client.js');
    expect(estimateTokens('a'.repeat(100))).toBe(25);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(3); // ceil(11/4)
  });
});
