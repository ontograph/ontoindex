/**
 * Unit Test: MCP Security Matrix (Path Traversal)
 *
 * Parametric per-tool test that submits "../../etc/passwd" to any
 * argument that accepts a file path, asserting rejection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ONTOINDEX_TOOLS } from '../../src/mcp/tools.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

// Mock DB and RepoManager to avoid side effects
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue([]),
  executeParameterized: vi.fn().mockResolvedValue([]),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isLbugReady: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([
    {
      name: 'test-repo',
      path: '/home/user/repo',
      storagePath: '/home/user/repo/.ontoindex',
      indexedAt: '2024-06-01T12:00:00Z',
      lastCommit: 'abc1234567890',
      stats: { files: 10, nodes: 50 },
    },
  ]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

describe('MCP Security Matrix: Path Traversal Rejection', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    await backend.init();
  });

  const pathArgs = ['file_path', 'filePath', 'filepath', 'path', 'file'];

  for (const tool of ONTOINDEX_TOOLS) {
    const props = tool.inputSchema.properties || {};
    const targetArgs = Object.keys(props).filter((arg) => pathArgs.includes(arg));

    if (targetArgs.length === 0) continue;

    for (const arg of targetArgs) {
      it(`tool "${tool.name}" rejects traversal in argument "${arg}"`, async () => {
        const params: any = { repo: 'test-repo' };
        params[arg] = '../../etc/passwd';

        // Add other required params if necessary
        if (tool.inputSchema.required) {
          for (const req of tool.inputSchema.required) {
            if (!params[req]) params[req] = 'mock-value';
          }
        }

        await expect(backend.callTool(tool.name, params)).rejects.toThrow(
          /Path escapes repository/i,
        );
      });
    }
  }
});
