import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../src/mcp/tools.js';

function createMockBackend(): any {
  return {
    callTool: vi.fn(),
    resolveRepo: vi.fn(),
    ensureRepoInitialized: vi.fn(),
  };
}

describe('MCP server lazy super-function loading', () => {
  it('creates the server without importing the super-function dispatcher', async () => {
    vi.resetModules();
    vi.doMock('../../src/mcp/super/dispatch.js', () => {
      throw new Error('super dispatcher was imported eagerly');
    });

    const { createMCPServer } = await import('../../src/mcp/server.js');

    expect(() => createMCPServer(createMockBackend())).not.toThrow();

    vi.doUnmock('../../src/mcp/super/dispatch.js');
  });

  it('passes the active startup profile into public tool discovery', async () => {
    vi.resetModules();

    const getPublicToolDefinitions = vi.fn((_options?: unknown): ToolDefinition[] => []);
    vi.doMock('../../src/mcp/shared/tool-registry.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/mcp/shared/tool-registry.js')>();
      return {
        ...actual,
        getMcpStartupProfileFromEnv: vi.fn(() => 'core'),
        getPublicToolDefinitions,
      };
    });

    const { createMCPServer } = await import('../../src/mcp/server.js');

    createMCPServer(createMockBackend());

    expect(getPublicToolDefinitions).toHaveBeenCalledWith({ startupProfile: 'core' });

    vi.doUnmock('../../src/mcp/shared/tool-registry.js');
  });
});
