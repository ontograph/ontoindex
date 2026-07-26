import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }

  it('installs hooks for Codex and Ontocode', async () => {
    setPlatform('linux');
    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });
    await fs.mkdir(path.join(tempHome, '.ontocode'), { recursive: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const codexHooksRaw = await fs.readFile(path.join(tempHome, '.codex', 'hooks.json'), 'utf-8');
    const codexHooks = JSON.parse(codexHooksRaw);
    expect(codexHooks.hooks.PreToolUse).toBeDefined();
    expect(codexHooks.hooks.PostToolUse).toBeDefined();

    const ontocodeHooksRaw = await fs.readFile(
      path.join(tempHome, '.ontocode', 'hooks.json'),
      'utf-8',
    );
    const ontocodeHooks = JSON.parse(ontocodeHooksRaw);
    expect(ontocodeHooks.hooks.PreToolUse).toBeDefined();
    expect(ontocodeHooks.hooks.PostToolUse).toBeDefined();
  });
});

// By default, execFileSync throws (simulating `which ontoindex` not found)
// so getMcpEntry() falls back to the npx path.
const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});
const getGitRootMock = vi.fn(() => '/mock/repo/path');
const expectedMockRepoPath = path.resolve('/mock/repo/path');
const existsSyncMock = vi.hoisted(() => vi.fn());

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  existsSyncMock.mockImplementation(actual.existsSync);
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: getGitRootMock,
}));

describe('setupClaudeCode', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let platformDescriptor: PropertyDescriptor | undefined;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value,
      configurable: true,
    });
  };

  const expectPackagedMcpEntry = (entry: any) => {
    expect(entry).toMatchObject({
      command: process.execPath,
      args: [
        expect.stringMatching(/dist[/\\]cli[/\\]index\.js$/),
        'mcp',
        '--project',
        expectedMockRepoPath,
      ],
      env: {
        NODE_ENV: 'production',
        ONTOINDEX_MCP_AUTO_ANALYZE: '0',
        ONTOINDEX_LBUG_POOL_SIZE: '1',
        ONTOINDEX_MCP_STARTUP_TIMEOUT_MS: '10000',
        ONTOINDEX_MCP_STARTUP_TRACE: '1',
        NODE_OPTIONS: '--max-old-space-size=1536',
      },
    });
    expect(entry.env).not.toHaveProperty('ONTOINDEX_MCP_REPO');
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-claude-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Only create ~/.claude — no other editor directories so their
    // setup functions skip and don't pollute assertions.
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }

    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('writes win32 MCP entry with packaged CLI path', async () => {
    setPlatform('win32');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expectPackagedMcpEntry(config.mcpServers.ontoindex);
    expect(
      console.log.mock.calls.some((call) =>
        call.some((value) => typeof value === 'string' && value.includes('Warnings:')),
      ),
    ).toBe(false);
  });

  it('writes non-win32 MCP entry with packaged CLI path', async () => {
    setPlatform('darwin');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expectPackagedMcpEntry(config.mcpServers.ontoindex);
  });

  it('skips when ~/.claude directory does not exist', async () => {
    await fs.rm(path.join(tempHome, '.claude'), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
  });

  it('preserves existing keys in ~/.claude.json', async () => {
    setPlatform('linux');

    await fs.writeFile(
      path.join(tempHome, '.claude.json'),
      JSON.stringify({ existingKey: 'keep-me', mcpServers: { other: { command: 'foo' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.existingKey).toBe('keep-me');
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    expect(config.mcpServers.ontoindex).toBeDefined();
  });

  it('replaces array mcpServers with an object in ~/.claude.json', async () => {
    setPlatform('linux');

    await fs.writeFile(
      path.join(tempHome, '.claude.json'),
      JSON.stringify({ mcpServers: [] }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(Array.isArray(config.mcpServers)).toBe(false);
    expect(config.mcpServers.ontoindex).toBeDefined();
  });

  it('handles missing ~/.claude.json (creates fresh)', async () => {
    setPlatform('linux');

    // Ensure no pre-existing file
    await fs.rm(path.join(tempHome, '.claude.json'), { force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.ontoindex).toBeDefined();
  });

  it('leaves truthy non-object Claude Code settings unchanged', async () => {
    setPlatform('linux');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    const original = JSON.stringify('invalid-settings');
    await fs.writeFile(settingsPath, original, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(original);
    expect(console.log).toHaveBeenCalledWith(
      '    ! Claude Code hooks: Claude Code config must be a JSON object',
    );
  });

  it('leaves malformed Claude Code hooks object unchanged', async () => {
    setPlatform('linux');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    const original = JSON.stringify({ hooks: [] });
    await fs.writeFile(settingsPath, original, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(original);
    expect(console.log).toHaveBeenCalledWith(
      '    ! Claude Code hooks: Claude Code hooks must be a JSON object',
    );
  });

  it.each([
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
  ])('leaves present falsy Claude Code hooks unchanged: %s', async (_label, hooksValue) => {
    setPlatform('linux');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    const original = JSON.stringify({ hooks: hooksValue });
    await fs.writeFile(settingsPath, original, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(original);
    expect(console.log).toHaveBeenCalledWith(
      '    ! Claude Code hooks: Claude Code hooks must be a JSON object',
    );
  });

  it('leaves malformed Claude Code event hooks unchanged', async () => {
    setPlatform('linux');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    const original = JSON.stringify({ hooks: { PreToolUse: { matcher: 'Bash' } } });
    await fs.writeFile(settingsPath, original, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(original);
    expect(console.log).toHaveBeenCalledWith(
      '    ! Claude Code hooks: Claude Code PreToolUse hooks must be an array',
    );
  });

  it.each([
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
  ])(
    'leaves present falsy Claude Code event hooks unchanged: %s',
    async (_label, eventHooksValue) => {
      setPlatform('linux');
      const settingsPath = path.join(tempHome, '.claude', 'settings.json');
      const original = JSON.stringify({ hooks: { PreToolUse: eventHooksValue } });
      await fs.writeFile(settingsPath, original, 'utf-8');

      const { setupCommand } = await import('../../src/cli/setup.js');
      await setupCommand();

      await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(original);
      expect(console.log).toHaveBeenCalledWith(
        '    ! Claude Code hooks: Claude Code PreToolUse hooks must be an array',
      );
    },
  );

  it('repairs stale Codex MCP config instead of preserving a broken command', async () => {
    setPlatform('linux');
    const codexDir = path.join(tempHome, '.codex');
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, 'config.toml'),
      [
        'model = "gpt-5.4"',
        '',
        '[mcp_servers.ontoindex]',
        'command = "/dead/global/ontoindex"',
        'args = ["mcp"]',
        '',
        '[mcp_servers.ontoindex.env]',
        'ONTOINDEX_MCP_AUTO_ANALYZE = "1"',
        '',
        '[mcp_servers.ontoindex.tools.gn_explore]',
        'approval_mode = "approve"',
        '',
        '[profiles.default]',
        'approval_policy = "never"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(raw).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(raw).toMatch(new RegExp(escapeRegExp(JSON.stringify(expectedMockRepoPath))));
    expect(raw).toContain('ONTOINDEX_MCP_AUTO_ANALYZE = "0"');
    expect(raw).toContain('ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = "10000"');
    expect(raw).toContain('ONTOINDEX_MCP_STARTUP_TRACE = "1"');
    expect(raw).toContain('NODE_OPTIONS = "--max-old-space-size=1536"');
    expect(raw).toContain('[profiles.default]');
    expect(raw).not.toContain('/dead/global/ontoindex');
    expect(raw).not.toContain('[mcp_servers.ontoindex.env]');
    expect(raw).not.toContain('[mcp_servers.ontoindex.tools.gn_explore]');
  });

  it('reports a packaged CLI validation error when the generated path goes missing', async () => {
    setPlatform('linux');
    existsSyncMock.mockImplementationOnce(() => true);
    existsSyncMock.mockImplementationOnce(() => false);

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expectPackagedMcpEntry(config.mcpServers.ontoindex);
    expect(
      console.log.mock.calls.some((call) =>
        call.some(
          (value) =>
            typeof value === 'string' && value.includes('Packaged CLI path does not exist:'),
        ),
      ),
    ).toBe(true);
  });

  it('reports npx fallback mode without failing setup when no packaged entry is available', async () => {
    setPlatform('linux');
    existsSyncMock.mockImplementationOnce(() => false);
    existsSyncMock.mockImplementationOnce(() => false);

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.ontoindex.command).toBe('npx');
    expect(
      console.log.mock.calls.some((call) =>
        call.some((value) => typeof value === 'string' && value.includes('Using npx fallback')),
      ),
    ).toBe(true);
  });

  it('handles corrupt JSON gracefully', async () => {
    setPlatform('linux');

    await fs.writeFile(
      path.join(tempHome, '.claude.json'),
      '{ this is not valid json !!!',
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    // readJsonFile returns null on invalid JSON, so mergeMcpConfig
    // creates a fresh config — the file should now be valid.
    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.ontoindex).toBeDefined();
  });

  it('leaves truthy non-object OpenCode config unchanged', async () => {
    setPlatform('linux');
    const opencodeDir = path.join(tempHome, '.config', 'opencode');
    await fs.mkdir(opencodeDir, { recursive: true });
    const configPath = path.join(opencodeDir, 'opencode.json');
    const original = JSON.stringify('invalid-opencode');
    await fs.writeFile(configPath, original, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.readFile(configPath, 'utf-8')).resolves.toBe(original);
    expect(console.log).toHaveBeenCalledWith(
      '    ! OpenCode: OpenCode config must be a JSON object',
    );
  });

  it('replaces array OpenCode mcp config with an object', async () => {
    setPlatform('linux');
    const opencodeDir = path.join(tempHome, '.config', 'opencode');
    await fs.mkdir(opencodeDir, { recursive: true });
    const configPath = path.join(opencodeDir, 'opencode.json');
    await fs.writeFile(configPath, JSON.stringify({ mcp: [] }), 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);

    expect(Array.isArray(config.mcp)).toBe(false);
    expect(config.mcp.ontoindex).toBeDefined();
  });

  it('prefers packaged CLI path when ontoindex is also on PATH', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValueOnce('/usr/local/bin/ontoindex\n');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expectPackagedMcpEntry(config.mcpServers.ontoindex);
  });

  it('does not require ontoindex on PATH when packaged CLI path exists', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not found');
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expectPackagedMcpEntry(config.mcpServers.ontoindex);
  });

  it('writes OntoIndex agent guidance once for Claude, Codex, and Ontocode', async () => {
    setPlatform('linux');
    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });
    await fs.mkdir(path.join(tempHome, '.ontocode'), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, '.codex', 'AGENTS.md'),
      '# Global Agent Instructions\n\n@LEAN-CTX.md\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempHome, '.ontocode', 'AGENTS.md'),
      '# Global Agent Instructions\n\n@LEAN-CTX.md\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempHome, '.claude', 'CLAUDE.md'),
      '# Global Agent Instructions\n',
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();
    const firstGuidance = await Promise.all(
      ['.claude', '.codex', '.ontocode'].map((dirName) =>
        fs.readFile(path.join(tempHome, dirName, 'ONTOINDEX.md'), 'utf-8'),
      ),
    );
    await setupCommand();

    for (const [index, dirName] of ['.claude', '.codex', '.ontocode'].entries()) {
      const guidance = await fs.readFile(path.join(tempHome, dirName, 'ONTOINDEX.md'), 'utf-8');
      expect(guidance).toBe(firstGuidance[index]);
      expect(guidance).toContain('Never claim OntoIndex was used');
      expect(guidance).toContain('gn_explore');
      // Concise ordered ladder: explore/search -> inspect -> impact -> verify-diff.
      const explore = guidance.indexOf('1. Explore/search');
      const inspect = guidance.indexOf('2. Inspect/context');
      const impact = guidance.indexOf('3. Impact before edits');
      const verify = guidance.indexOf('4. gn_verify_diff before commit');
      expect(explore).toBeGreaterThan(-1);
      expect(inspect).toBeGreaterThan(explore);
      expect(impact).toBeGreaterThan(inspect);
      expect(verify).toBeGreaterThan(impact);
      // Commit-based index + forbid silent dirty-worktree assumptions.
      expect(guidance).toContain('The graph index is commit-based');
      expect(guidance).toContain('current HEAD differs from the indexed');
      expect(guidance).toContain(
        'silently assume dirty or uncommitted worktree changes are represented in the',
      );
    }

    const claudeInstructions = await fs.readFile(
      path.join(tempHome, '.claude', 'CLAUDE.md'),
      'utf-8',
    );
    const codexInstructions = await fs.readFile(
      path.join(tempHome, '.codex', 'AGENTS.md'),
      'utf-8',
    );
    const ontocodeInstructions = await fs.readFile(
      path.join(tempHome, '.ontocode', 'AGENTS.md'),
      'utf-8',
    );

    for (const content of [claudeInstructions, codexInstructions, ontocodeInstructions]) {
      expect(content.match(/@ONTOINDEX\.md/g)).toHaveLength(1);
    }
    expect(codexInstructions).toContain('@LEAN-CTX.md');
    expect(ontocodeInstructions).toContain('@LEAN-CTX.md');
  });
});
