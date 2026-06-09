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
const getGitRootMock = vi.hoisted(() => vi.fn(() => '/target/repo'));

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: vi.fn(function LocalBackendMock() {
    return backendMocks;
  }),
}));
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: getGitRootMock,
}));

vi.mock('../../src/mcp/server.js', () => serverMocks);
import { mcpCommand } from '../../src/cli/mcp.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { startMCPServer } from '../../src/mcp/server.js';

describe('mcpCommand', () => {
  const originalStartupTimeout = process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS;
  const originalMcpRepo = process.env.ONTOINDEX_MCP_REPO;
  const originalMcpProjectCwd = process.env.ONTOINDEX_MCP_PROJECT_CWD;
  const originalMcpAllowMismatch = process.env.ONTOINDEX_MCP_ALLOW_REPO_MISMATCH;
  const originalExitCode = process.exitCode;

  const restoreStartupTimeout = () => {
    if (originalStartupTimeout === undefined) {
      delete process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS;
    } else {
      process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = originalStartupTimeout;
    }
    if (originalMcpRepo === undefined) {
      delete process.env.ONTOINDEX_MCP_REPO;
    } else {
      process.env.ONTOINDEX_MCP_REPO = originalMcpRepo;
    }
    if (originalMcpProjectCwd === undefined) {
      delete process.env.ONTOINDEX_MCP_PROJECT_CWD;
    } else {
      process.env.ONTOINDEX_MCP_PROJECT_CWD = originalMcpProjectCwd;
    }
    if (originalMcpAllowMismatch === undefined) {
      delete process.env.ONTOINDEX_MCP_ALLOW_REPO_MISMATCH;
    } else {
      process.env.ONTOINDEX_MCP_ALLOW_REPO_MISMATCH = originalMcpAllowMismatch;
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

  it('allows known-good external checkout when project hint matches ONTOINDEX_MCP_REPO', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    process.env.ONTOINDEX_MCP_REPO = '/opt/demodb/_workfolder/ontocode';
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/opt/demodb/_workfolder/ontocode';
    backendMocks.listRepos.mockResolvedValue([{ name: 'ontocode' }]);

    await mcpCommand();

    expect(process.exitCode).toBeUndefined();
    expect(backendMocks.init).toHaveBeenCalled();
    expect(startMCPServer).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OntoIndex: MCP executable cwd:'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OntoIndex: MCP target project path:'),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ontocode'));
    expect(backendMocks.dispose).not.toHaveBeenCalled();
  });

  it('fails fast when ONTOINDEX_MCP_PROJECT_CWD confirms a different project than ONTOINDEX_MCP_REPO', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    process.env.ONTOINDEX_MCP_REPO = '/project/b';
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/project/a';
    process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = '10000';

    await mcpCommand();

    expect(process.exitCode).toBe(1);
    expect(backendMocks.dispose).not.toHaveBeenCalled();
    expect(startMCPServer).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ONTOINDEX_MCP_REPO'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('does not match this project scope'),
    );
  });

  it('warns and continues when ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    process.env.ONTOINDEX_MCP_REPO = '/project/b';
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/project/a';
    process.env.ONTOINDEX_MCP_ALLOW_REPO_MISMATCH = '1';
    backendMocks.listRepos.mockResolvedValue([{ name: 'repo-b' }]);

    await mcpCommand();

    expect(process.exitCode).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ONTOINDEX_MCP_REPO'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('does not match this project scope'),
    );
    expect(backendMocks.dispose).not.toHaveBeenCalled();
    expect(startMCPServer).toHaveBeenCalled();
  });

  it('logs startup cwd and target repo filter', async () => {
    getGitRootMock.mockReturnValue('/project/a');
    process.env.ONTOINDEX_MCP_REPO = '/project/a';
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/project/a';
    backendMocks.listRepos.mockResolvedValue([{ name: 'repo-a' }]);

    await mcpCommand();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OntoIndex: MCP executable cwd:'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OntoIndex: MCP target repo filter: /project/a'),
    );
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
