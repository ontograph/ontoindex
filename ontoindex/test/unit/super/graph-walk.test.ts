import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gnGraphWalk } from '../../../src/mcp/super/graph-walk.js';
import { dispatchSuper } from '../../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';
import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { getPublicToolRegistry } from '../../../src/mcp/shared/tool-registry.js';

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

const mockExecute = vi.mocked(executeParameterized);

describe('gnGraphWalk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
