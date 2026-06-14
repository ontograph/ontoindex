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
    getGitRootMock.mockReturnValue('/target/repo');
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

  it('resolves label-based --repo through the registry before comparing paths', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    backendMocks.listRepos.mockResolvedValue([
      { name: 'ontocode', path: '/opt/demodb/_workfolder/ontocode' },
    ]);

    await mcpCommand({ repo: 'ontocode', project: '/opt/demodb/_workfolder/ontocode' });

    expect(process.exitCode).toBeUndefined();
    expect(backendMocks.init).toHaveBeenCalled();
    expect(startMCPServer).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OntoIndex: MCP executable cwd:'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OntoIndex: MCP target project path:'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('/opt/demodb/_workfolder/ontocode'),
    );
    expect(backendMocks.dispose).not.toHaveBeenCalled();
  });

  it('passes the target project path to the backend when no repo filter is pinned', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    delete process.env.ONTOINDEX_MCP_REPO;
    delete process.env.ONTOINDEX_MCP_PROJECT_CWD;
    backendMocks.listRepos.mockResolvedValue([
      { name: 'OntoIndex', path: '/opt/demodb/_workfolder/OntoIndex' },
      { name: 'codex', path: '/opt/demodb/_workfolder/codex' },
    ]);

    await mcpCommand();

    expect(LocalBackend).toHaveBeenCalledWith({
      repoFilter: undefined,
      preferredProjectPath: '/opt/demodb/_workfolder/OntoIndex',
    });
    expect(process.exitCode).toBeUndefined();
    expect(startMCPServer).toHaveBeenCalled();
  });

  it('uses --project as the preferred startup project path and ignores env repo pinning', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    process.env.ONTOINDEX_MCP_REPO = 'wrong-repo';
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/project/env-target';
    backendMocks.listRepos.mockResolvedValue([{ name: 'repo-a', path: '/project/explicit-target' }]);

    await mcpCommand({ project: '/project/explicit-target' });

    expect(LocalBackend).toHaveBeenCalledWith({
      repoFilter: undefined,
      preferredProjectPath: '/project/explicit-target',
    });
    expect(process.exitCode).toBeUndefined();
    expect(startMCPServer).toHaveBeenCalled();
  });

  it('fails fast when --repo resolves to a different project', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/project/a';
    process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS = '10000';
    backendMocks.listRepos.mockResolvedValue([{ name: 'repo-b', path: '/project/b' }]);

    await mcpCommand({ repo: 'repo-b' });

    expect(process.exitCode).toBe(1);
    expect(backendMocks.dispose).toHaveBeenCalled();
    expect(startMCPServer).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('--repo "repo-b" resolves to repo-b -> /project/b'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Project cwd: /opt/demodb/_workfolder/OntoIndex'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`Process cwd: ${process.cwd()}`),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Restart command:'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "ontoindex mcp --project '/opt/demodb/_workfolder/OntoIndex' --repo 'repo-b'",
      ),
    );
  });

  it('warns and continues when ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1', async () => {
    getGitRootMock.mockReturnValue('/opt/demodb/_workfolder/OntoIndex');
    process.env.ONTOINDEX_MCP_REPO = 'repo-b';
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/project/a';
    process.env.ONTOINDEX_MCP_ALLOW_REPO_MISMATCH = '1';
    backendMocks.listRepos.mockResolvedValue([{ name: 'repo-b', path: '/project/b' }]);

    await mcpCommand();

    expect(process.exitCode).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ONTOINDEX_MCP_REPO'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Resolved repo: repo-b -> /project/b'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Project cwd: /opt/demodb/_workfolder/OntoIndex'),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Restart command:'));
    expect(backendMocks.dispose).not.toHaveBeenCalled();
    expect(startMCPServer).toHaveBeenCalled();
  });

  it('logs startup cwd and target repo filter', async () => {
    getGitRootMock.mockReturnValue('/project/a');
    process.env.ONTOINDEX_MCP_REPO = '/project/a';
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/project/a';
    backendMocks.listRepos.mockResolvedValue([{ name: 'repo-a', path: '/project/a' }]);

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
    delete process.env.ONTOINDEX_MCP_PROJECT_CWD;
    backendMocks.listRepos.mockResolvedValue([{ name: 'only-this-repo', path: '/target/repo' }]);

    await mcpCommand({ repo: 'only-this-repo' });

    expect(LocalBackend).toHaveBeenCalledWith({
      repoFilter: 'only-this-repo',
      preferredProjectPath: '/target/repo',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('passes both explicit project path and repo filter to the backend before startup', async () => {
    backendMocks.listRepos.mockResolvedValue([{ name: 'only-this-repo', path: '/target/repo' }]);

    await mcpCommand({ repo: 'only-this-repo', project: '/target/repo' });

    expect(LocalBackend).toHaveBeenCalledWith({
      repoFilter: 'only-this-repo',
      preferredProjectPath: '/target/repo',
    });
    expect(process.exitCode).toBeUndefined();
  });
});
