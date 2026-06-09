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

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

describe('setupCommand codex execution', () => {
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

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-codex-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    setPlatform('win32');
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

  it('writes Codex MCP config on Windows instead of shelling out to npm', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    expect(execFileMock).not.toHaveBeenCalled();
    const raw = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf-8');
    expect(raw).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(raw).toMatch(/args = \[".*dist.*cli.*index\.js", "mcp"\]/);
    expect(raw).toContain('ONTOINDEX_MCP_AUTO_ANALYZE = "0"');
    expect(raw).toContain('ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = "10000"');
    expect(raw).toContain('ONTOINDEX_MCP_STARTUP_TRACE = "1"');
  });

  it('writes Codex MCP config on non-Windows and does not shell out to npm', async () => {
    setPlatform('darwin');

    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    expect(execFileMock).not.toHaveBeenCalled();
    const raw = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf-8');
    expect(raw).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(raw).toMatch(/args = \[".*dist.*cli.*index\.js", "mcp"\]/);
    expect(raw).not.toContain('ontoindex@latest');
  });

  it('skips Codex setup entirely when ~/.codex is missing', async () => {
    await fs.rm(path.join(tempHome, '.codex'), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    expect(execFileMock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(tempHome, '.agents', 'skills'))).rejects.toThrow();
  });
});
