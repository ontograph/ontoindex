import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { backendMocks, serverMocks } = vi.hoisted(() => ({
  backendMocks: {
    init: vi.fn().mockResolvedValue(false),
    listRepos: vi.fn().mockResolvedValue([]),
    dispose: vi.fn().mockResolvedValue(undefined),
  },
  serverMocks: {
    startMCPServer: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: vi.fn(function LocalBackendMock() {
    return backendMocks;
  }),
}));

vi.mock('../../src/mcp/server.js', () => serverMocks);

import { mcpCommand } from '../../src/cli/mcp.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { startMCPServer } from '../../src/mcp/server.js';

describe('mcpCommand', () => {
  const originalStartupTimeout = process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS;
  const originalExitCode = process.exitCode;

  const restoreStartupTimeout = () => {
    if (originalStartupTimeout === undefined) {
      delete process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS;
    } else {
      process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = originalStartupTimeout;
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    backendMocks.init.mockResolvedValue(false);
    backendMocks.listRepos.mockResolvedValue([]);
    backendMocks.dispose.mockResolvedValue(undefined);
    restoreStartupTimeout();
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreStartupTimeout();
    process.exitCode = originalExitCode;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails fast when a requested repo filter has no match', async () => {
    await mcpCommand({ repo: 'missing-repo' });

    expect(process.exitCode).toBe(1);
    expect(backendMocks.dispose).toHaveBeenCalled();
    expect(startMCPServer).not.toHaveBeenCalled();
  });

  it('fails fast when backend initialization exceeds the MCP startup timeout', async () => {
    vi.useFakeTimers();
    process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = '5';
    backendMocks.init.mockImplementationOnce(
      () =>
        new Promise<boolean>(() => {
          // Simulate a stuck registry/index open.
        }),
    );

    const command = mcpCommand();
    await vi.advanceTimersByTimeAsync(5);
    await command;

    expect(backendMocks.init).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(backendMocks.dispose).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(startMCPServer).not.toHaveBeenCalled();
  });

  it('passes the requested repo filter to the backend before startup', async () => {
    backendMocks.listRepos.mockResolvedValue([{ name: 'only-this-repo' }]);

    await mcpCommand({ repo: 'only-this-repo' });

    expect(LocalBackend).toHaveBeenCalledWith({ repoFilter: 'only-this-repo' });
    expect(process.exitCode).toBeUndefined();
  });
});
