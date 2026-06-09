import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }
});

// By default, execFileSync throws (simulating `which ontoindex` not found)
// so getMcpEntry() falls back to the npx path.
const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});
const getGitRootMock = vi.fn(() => '/mock/repo/path');
const expectedMockRepoPath = path.resolve('/mock/repo/path');

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
      args: [expect.stringMatching(/dist[/\\]cli[/\\]index\.js$/), 'mcp'],
      env: {
        NODE_ENV: 'production',
        ONTOINDEX_MCP_AUTO_ANALYZE: '0',
        ONTOINDEX_LBUG_POOL_SIZE: '1',
        ONTOINDEX_MCP_STARTUP_TIMEOUT_MS: '10000',
        ONTOINDEX_MCP_STARTUP_TRACE: '1',
        ONTOINDEX_MCP_PROJECT_CWD: expectedMockRepoPath,
        ONTOINDEX_MCP_REPO: expectedMockRepoPath,
        NODE_OPTIONS: '--max-old-space-size=1536',
      },
    });
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
      '    ! Claude Code hooks: Claude Code settings must be a JSON object',
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
    expect(raw).toMatch(/args = \[".*dist.*cli.*index\.js", "mcp"\]/);
    expect(raw).toContain('ONTOINDEX_MCP_AUTO_ANALYZE = "0"');
    expect(raw).toContain('ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = "10000"');
    expect(raw).toContain('ONTOINDEX_MCP_STARTUP_TRACE = "1"');
    expect(raw).toContain('NODE_OPTIONS = "--max-old-space-size=1536"');
    expect(raw).toContain('[profiles.default]');
    expect(raw).not.toContain('/dead/global/ontoindex');
    expect(raw).not.toContain('[mcp_servers.ontoindex.env]');
    expect(raw).not.toContain('[mcp_servers.ontoindex.tools.gn_explore]');
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
});
