import { describe, it, expect } from 'vitest';
import { routeTool } from '../../src/mcp/local/backend-route.js';

describe('Router Classifier', () => {
  const mockRepo: any = { id: 'test-repo' };

  it('suggests context for "who calls" queries', async () => {
    const result = await routeTool(mockRepo, { query: 'who calls login?' });
    expect((result as unknown as Record<string, any>).tool).toBe('context');
  });

  it('suggests context for "what calls" queries', async () => {
    const result = await routeTool(mockRepo, { query: 'what calls AuthService' });
    expect((result as unknown as Record<string, any>).tool).toBe('context');
  });

  it('suggests context for "callers of" queries', async () => {
    const result = await routeTool(mockRepo, { query: 'show me callers of getUser' });
    expect((result as unknown as Record<string, any>).tool).toBe('context');
  });

  it('suggests impact for "what breaks" queries', async () => {
    const result = await routeTool(mockRepo, { query: 'what breaks if I change this?' });
    expect((result as unknown as Record<string, any>).tool).toBe('impact');
  });

  it('suggests impact for "safe to change" queries', async () => {
    const result = await routeTool(mockRepo, { query: 'is it safe to change the DB schema?' });
    expect((result as unknown as Record<string, any>).tool).toBe('impact');
  });

  it('suggests query for "how works" queries', async () => {
    const result = await routeTool(mockRepo, { query: 'how works the auth flow' });
    expect((result as unknown as Record<string, any>).tool).toBe('query');
  });

  it('suggests query for architecture queries', async () => {
    const result = await routeTool(mockRepo, { query: 'show me the system architecture' });
    expect((result as unknown as Record<string, any>).tool).toBe('query');
  });

  it('suggests repomap for structure queries', async () => {
    const result = await routeTool(mockRepo, { query: 'show me the file structure' });
    expect((result as unknown as Record<string, any>).tool).toBe('repomap');
  });

  it('suggests repomap for "show me the files" queries', async () => {
    const result = await routeTool(mockRepo, { query: 'show me the files in this project' });
    expect((result as unknown as Record<string, any>).tool).toBe('repomap');
  });

  it('defaults to query for generic concepts', async () => {
    const result = await routeTool(mockRepo, { query: 'database' });
    expect((result as unknown as Record<string, any>).tool).toBe('query');
  });
});
