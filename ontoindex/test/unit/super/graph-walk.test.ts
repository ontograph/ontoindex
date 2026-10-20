import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gnGraphWalk } from '../../../src/mcp/super/graph-walk.js';
import { dispatchSuper } from '../../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';
import {
  executeParameterized,
  getPinnedGenerationDir,
} from '../../../src/core/lbug/pool-adapter.js';
import { getPublicToolRegistry } from '../../../src/mcp/shared/tool-registry.js';

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  getPinnedGenerationDir: vi.fn(),
}));

vi.mock('../../../src/mcp/local/backend-overlay.js', () => ({
  getPinnedOverlaySnapshot: vi.fn(),
}));

const mockExecute = vi.mocked(executeParameterized);

describe('gnGraphWalk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPinnedGenerationDir).mockReturnValue(undefined);
  });

  it('rejects changed admitted generations before status or step changes state', async () => {
    vi.mocked(getPinnedGenerationDir).mockReturnValue('/generation/a');
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const started = await gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' });
    expect((await gnGraphWalk('repo1', { action: 'status', walkId: started.state.id })).ok).toBe(
      true,
    );
    const before = JSON.stringify(started.state);
    mockExecute.mockClear();
    vi.mocked(getPinnedGenerationDir).mockReturnValue('/generation/b');
    for (const action of ['status', 'step'] as const) {
      expect(await gnGraphWalk('repo1', { action, walkId: started.state.id })).toMatchObject({
        ok: false,
        code: 'RESTART_REQUIRED',
      });
      expect(JSON.stringify(started.state)).toBe(before);
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('checks a queued step binding when its serialized operation begins', async () => {
    vi.mocked(getPinnedGenerationDir).mockReturnValue('/generation/a');
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const started = await gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' });
    let release!: (rows: any[]) => void;
    mockExecute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = gnGraphWalk('repo1', { action: 'step', walkId: started.state.id });
    await Promise.resolve();
    const queued = gnGraphWalk('repo1', { action: 'step', walkId: started.state.id });
    vi.mocked(getPinnedGenerationDir).mockReturnValue('/generation/b');
    release([{ tid: 'next', tname: 'next', rel: 'CALLS' }]);
    await first;
    const before = JSON.stringify(started.state);
    await expect(queued).resolves.toMatchObject({ ok: false, code: 'RESTART_REQUIRED' });
    expect(JSON.stringify(started.state)).toBe(before);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('starts a walk', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const result = await gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' });

    expect(result.version).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.state.id).toBeDefined();
    expect(result.state.frontier).toContain('seed-id');
    expect(result.state.maxSteps).toBe(10);
    expect(result.state.maxFrontier).toBe(100);
    expect(result.state.maxExpansionPerStep).toBe(5);
  });

  it('assigns independent identities to walks with the same seed', async () => {
    mockExecute.mockResolvedValue([{ n: { id: 'seed-id' } }]);

    const [first, second] = await Promise.all([
      gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' }),
      gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' }),
    ]);

    expect(first.state.id).not.toBe(second.state.id);
  });

  it('steps through a walk', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const startResult = await gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' });
    const walkId = startResult.state.id;

    mockExecute.mockResolvedValueOnce([{ tid: 'target1', tname: 'target1', rel: 'CALLS' }]);
    const stepResult = await gnGraphWalk('repo1', { action: 'step', walkId });

    expect(stepResult.ok).toBe(true);
    expect(stepResult.newDiscoveries).toHaveLength(1);
    expect(stepResult.state.visited).toContain('seed-id');
    expect(stepResult.state.frontier).toContain('target1');
  });

  it('returns status', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const startResult = await gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' });
    const walkId = startResult.state.id;

    const statusResult = await gnGraphWalk('repo1', { action: 'status', walkId });
    expect(statusResult.ok).toBe(true);
    expect(statusResult.state.id).toBe(walkId);
  });

  it('returns a structured error for missing seed', async () => {
    const result = await gnGraphWalk('repo1', { action: 'start' });

    expect(result).toMatchObject({
      version: 1,
      action: 'start',
      ok: false,
      status: 'error',
      code: 'SEED_SYMBOL_REQUIRED',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns a structured error for unknown walks', async () => {
    const result = await gnGraphWalk('repo1', { action: 'step', walkId: 'missing-walk' });

    expect(result).toMatchObject({
      version: 1,
      action: 'step',
      ok: false,
      status: 'error',
      code: 'WALK_NOT_FOUND',
    });
  });

  it('does not expose a walk to another repository', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const startResult = await gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' });

    const result = await gnGraphWalk('repo2', { action: 'status', walkId: startResult.state.id });

    expect(result).toMatchObject({ ok: false, code: 'WALK_NOT_FOUND' });
  });

  it('keeps progress intact when an expansion query fails', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const startResult = await gnGraphWalk('repo1', { action: 'start', seedSymbol: 'seed-id' });
    mockExecute.mockRejectedValueOnce(new Error('temporary query failure'));

    await expect(
      gnGraphWalk('repo1', { action: 'step', walkId: startResult.state.id }),
    ).rejects.toThrow('temporary query failure');
    const unchanged = await gnGraphWalk('repo1', {
      action: 'status',
      walkId: startResult.state.id,
    });
    expect(unchanged.state).toMatchObject({ frontier: ['seed-id'], visited: [], stepsTaken: 0 });

    mockExecute.mockResolvedValueOnce([{ tid: 'target1', tname: 'target1', rel: 'CALLS' }]);
    const retried = await gnGraphWalk('repo1', { action: 'step', walkId: startResult.state.id });
    expect(retried.state).toMatchObject({
      frontier: ['target1'],
      visited: ['seed-id'],
      stepsTaken: 1,
    });
  });

  it('serializes concurrent steps for one walk', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const startResult = await gnGraphWalk('repo1', {
      action: 'start',
      seedSymbol: 'seed-id',
      maxSteps: 1,
    });

    let resolveExpansion!: (rows: unknown[]) => void;
    const expansion = new Promise<unknown[]>((resolve) => {
      resolveExpansion = resolve;
    });
    mockExecute.mockReturnValueOnce(expansion as ReturnType<typeof executeParameterized>);

    const firstStep = gnGraphWalk('repo1', { action: 'step', walkId: startResult.state.id });
    const secondStep = gnGraphWalk('repo1', { action: 'step', walkId: startResult.state.id });
    await Promise.resolve();
    expect(mockExecute).toHaveBeenCalledTimes(2);

    resolveExpansion([{ tid: 'target1', tname: 'target1', rel: 'CALLS' }]);
    const [first, second] = await Promise.all([firstStep, secondStep]);

    expect(first.state.stepsTaken).toBe(1);
    expect(second.state.stepsTaken).toBe(1);
    expect(second.message).toBe('Max steps reached');
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('caps max steps and expansion limits on start', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);

    const result = await gnGraphWalk('repo1', {
      action: 'start',
      seedSymbol: 'seed-id',
      maxSteps: 999,
      maxExpansionPerStep: 999,
    });

    expect(result.state.maxSteps).toBe(50);
    expect(result.state.maxExpansionPerStep).toBe(25);
    expect(result.warnings).toContain('maxSteps capped at 50.');
    expect(result.warnings).toContain('maxExpansionPerStep capped at 25.');
  });

  it('limits frontier growth during expansion', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const startResult = await gnGraphWalk('repo1', {
      action: 'start',
      seedSymbol: 'seed-id',
      maxFrontier: 1,
      maxExpansionPerStep: 3,
    });

    mockExecute.mockResolvedValueOnce([
      { tid: 'target1', tname: 'target1', rel: 'CALLS' },
      { tid: 'target2', tname: 'target2', rel: 'CALLS' },
      { tid: 'target3', tname: 'target3', rel: 'CALLS' },
    ]);
    const stepResult = await gnGraphWalk('repo1', {
      action: 'step',
      walkId: startResult.state.id,
    });

    expect(stepResult.newDiscoveries).toHaveLength(1);
    expect(stepResult.truncatedDiscoveries).toBe(2);
    expect(stepResult.state.frontier).toEqual(['target1']);
    expect(stepResult.warnings).toContain(
      'Dropped 2 discoveries because maxFrontier=1 was reached.',
    );
  });

  it('completes instead of stepping beyond maxSteps', async () => {
    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const startResult = await gnGraphWalk('repo1', {
      action: 'start',
      seedSymbol: 'seed-id',
      maxSteps: 1,
    });

    mockExecute.mockResolvedValueOnce([{ tid: 'target1', tname: 'target1', rel: 'CALLS' }]);
    await gnGraphWalk('repo1', { action: 'step', walkId: startResult.state.id });

    const result = await gnGraphWalk('repo1', {
      action: 'step',
      walkId: startResult.state.id,
    });

    expect(result.message).toBe('Max steps reached');
    expect(result.state.status).toBe('completed');
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('registers, advertises, and dispatches gn_graph_walk coherently', async () => {
    const definition = ONTOINDEX_SUPER_TOOLS.find((tool) => tool.name === 'gn_graph_walk');
    const generalTools = getPublicToolRegistry({ includeFacades: false, mode: 'general' }).map(
      (entry) => entry.name,
    );
    const queryTools = getPublicToolRegistry({
      includeFacades: false,
      mode: 'query-projects',
    }).map((entry) => entry.name);

    expect(definition).toBeDefined();
    expect(definition?.inputSchema.properties.navigationPolicy.enum).toEqual([
      'follow-calls',
      'follow-imports',
      'expand-outward',
    ]);
    expect(definition?.inputSchema.properties.maxSteps.maximum).toBe(50);
    expect(definition?.inputSchema.properties.maxFrontier.maximum).toBe(250);
    expect(definition?.inputSchema.properties.maxExpansionPerStep.maximum).toBe(25);
    for (const field of ['maxSteps', 'maxFrontier', 'maxExpansionPerStep']) {
      expect(definition?.inputSchema.properties[field].type).toBe('integer');
      await expect(
        dispatchSuper(
          'gn_graph_walk',
          { action: 'start', seedSymbol: 'seed-id', [field]: 1.5 },
          'repo1',
        ),
      ).rejects.toThrow(`${field}: expected integer`);
    }
    expect(generalTools).toContain('gn_graph_walk');
    expect(queryTools).not.toContain('gn_graph_walk');

    mockExecute.mockResolvedValueOnce([{ n: { id: 'seed-id' } }]);
    const dispatched = await dispatchSuper(
      'gn_graph_walk',
      { action: 'start', seedSymbol: 'seed-id' },
      'repo1',
    );
    expect(dispatched).toMatchObject({ version: 1, ok: true });
  });
});
