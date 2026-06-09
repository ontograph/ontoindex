import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommunityEvidencePack } from '../../src/mcp/local/backend-community-evidence-pack.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
}));

describe('runCommunityEvidencePack', () => {
  const repo = { id: 'test-repo', name: 'test-repo' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully aggregates community evidence', async () => {
    const mockSymbols = [
      { uid: 's1', name: 'Symbol1', kind: 'Function', filePath: 'f1.ts', citationCount: 10 },
      { uid: 's2', name: 'Symbol2', kind: 'Class', filePath: 'f2.ts', citationCount: 5 },
    ];
    const mockProcesses = [{ id: 'p1', label: 'Process1', stepCount: 3 }];
    const mockConcepts = [
      { conceptId: 'concept-1', label: 'Concept1', docPath: 'docs/c1.md' },
      { conceptId: 'concept-1', label: 'Concept1', docPath: 'docs/c2.md' },
    ];

    vi.mocked(executeParameterized)
      .mockResolvedValueOnce(mockSymbols)
      .mockResolvedValueOnce(mockProcesses)
      .mockResolvedValueOnce(mockConcepts);

    const result = await runCommunityEvidencePack(repo, { community_id: 'c-1', limit: 10 });

    expect(result).toMatchObject({
      status: 'success',
      communityId: 'c-1',
      citationDensity: 7.5,
      emptyResult: false,
    });

    if ('status' in result && result.status === 'success') {
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].name).toBe('Symbol1');
      expect(result.processes).toHaveLength(1);
      expect(result.concepts).toHaveLength(1);
      expect(result.concepts[0].label).toBe('Concept1');
      expect(result.concepts[0].sourceDocuments).toEqual(['docs/c1.md', 'docs/c2.md']);
      expect(result.truncationState.symbols).toBe(false);
      expect(result.truncationState.processes).toBe(false);
      expect(result.truncationState.concepts).toBe(false);
    }
    expect(vi.mocked(executeParameterized).mock.calls[0][2]).toEqual({
      communityId: 'c-1',
      rowLimit: 11,
    });
    expect(vi.mocked(executeParameterized).mock.calls[0][1]).toContain("type: 'MENTIONS'");
    expect(vi.mocked(executeParameterized).mock.calls[0][1]).not.toContain('EVIDENCE_FOR');
    expect(vi.mocked(executeParameterized).mock.calls[2][1]).toContain('concept:Concept');
    expect(vi.mocked(executeParameterized).mock.calls[2][1]).not.toContain('MarkdownDocument');
  });

  it('does not mark truncation for exactly limit rows', async () => {
    const mockSymbols = Array(10).fill({
      uid: 's',
      name: 'S',
      kind: 'K',
      filePath: 'P',
      citationCount: 1,
    });

    vi.mocked(executeParameterized)
      .mockResolvedValueOnce(mockSymbols)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await runCommunityEvidencePack(repo, { community_id: 'c-1', limit: 10 });

    if ('status' in result && result.status === 'success') {
      expect(result.symbols).toHaveLength(10);
      expect(result.truncationState.symbols).toBe(false);
    }
  });

  it('handles truncation when the backend returns more than the requested limit', async () => {
    const mockSymbols = Array(11).fill({
      uid: 's',
      name: 'S',
      kind: 'K',
      filePath: 'P',
      citationCount: 1,
    });
    const mockProcesses = Array(11).fill({ id: 'p', label: 'P', stepCount: 1 });
    const mockConcepts = Array(11).fill({ conceptId: 'c', label: 'C', docPath: 'docs/c.md' });

    vi.mocked(executeParameterized)
      .mockResolvedValueOnce(mockSymbols)
      .mockResolvedValueOnce(mockProcesses)
      .mockResolvedValueOnce(mockConcepts);

    const result = await runCommunityEvidencePack(repo, { community_id: 'c-1', limit: 10 });

    if ('status' in result && result.status === 'success') {
      expect(result.symbols).toHaveLength(10);
      expect(result.processes).toHaveLength(10);
      expect(result.truncationState).toEqual({
        symbols: true,
        processes: true,
        concepts: true,
      });
    }
  });

  it('returns an explicit empty result when the community has no evidence', async () => {
    vi.mocked(executeParameterized)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await runCommunityEvidencePack(repo, { community_id: 'missing', limit: 10 });

    expect(result).toMatchObject({
      status: 'success',
      communityId: 'missing',
      emptyResult: true,
      symbols: [],
      processes: [],
      concepts: [],
      citationDensity: 0,
      truncationState: { symbols: false, processes: false, concepts: false },
    });
  });

  it('normalizes invalid limits to the deterministic default', async () => {
    vi.mocked(executeParameterized)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runCommunityEvidencePack(repo, { community_id: 'c-1', limit: Number.NaN });

    expect(vi.mocked(executeParameterized).mock.calls[0][2]).toEqual({
      communityId: 'c-1',
      rowLimit: 101,
    });
  });

  it('falls back to heuristic process labels', async () => {
    vi.mocked(executeParameterized)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'p1', heuristicLabel: 'Heuristic Process', stepCount: 2 }])
      .mockResolvedValueOnce([]);

    const result = await runCommunityEvidencePack(repo, { community_id: 'c-1', limit: 10 });

    if ('status' in result && result.status === 'success') {
      expect(result.processes[0].label).toBe('Heuristic Process');
    }
  });

  it('returns error when query fails', async () => {
    vi.mocked(executeParameterized).mockRejectedValue(new Error('DB Down'));

    const result = await runCommunityEvidencePack(repo, { community_id: 'c-1' });

    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.status).toBe('error');
      expect(result.communityId).toBe('c-1');
      expect(result.error).toContain('DB Down');
    }
  });
});
