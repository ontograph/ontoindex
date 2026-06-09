/**
 * Unit Test: Checks Runner
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runChecks } from '../../src/checks/runner.js';
import * as loader from '../../src/checks/loader.js';
import * as impact from '../../src/checks/impact-threshold.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

vi.mock('../../src/checks/loader.js');
vi.mock('../../src/checks/impact-threshold.js');
vi.mock('../../src/mcp/local/local-backend.js');

describe('Checks Runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty results if no checks file found', async () => {
    vi.mocked(loader.loadChecks).mockRejectedValue({ code: 'ENOENT' });
    const results = await runChecks('/fake/repo');
    expect(results).toEqual([]);
  });

  it('executes impact-threshold checks', async () => {
    const mockChecks = [
      { id: 'check1', type: 'impact-threshold', args: { target: 'T1', max_d1: 5 } },
    ];
    vi.mocked(loader.loadChecks).mockResolvedValue(mockChecks);
    vi.mocked(impact.evaluateImpactThreshold).mockResolvedValue({ pass: true, message: 'OK' });

    const mockBackend = new LocalBackend();
    const results = await runChecks('/fake/repo', mockBackend);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ id: 'check1', success: true, message: 'OK' });
    expect(impact.evaluateImpactThreshold).toHaveBeenCalledWith(mockBackend, mockChecks[0].args);
  });

  it('executes semantic-contract checks without initializing a backend', async () => {
    vi.mocked(loader.loadChecks).mockResolvedValue([
      {
        id: 'semantic-ok',
        type: 'semantic-contract',
        args: {
          diagnostics: [
            {
              category: 'code-graph',
              kind: 'extracted',
              source: 'graph',
              authority: 'authoritative',
              subject: 'changed symbols',
              reason: 'resolved from graph index',
              advisory: false,
            },
          ],
        },
      },
    ]);

    const results = await runChecks('/fake/repo');

    expect(results).toEqual([
      {
        id: 'semantic-ok',
        success: true,
        message: 'Semantic contracts passed (0 violations).',
      },
    ]);
    expect(LocalBackend).not.toHaveBeenCalled();
  });

  it('reports semantic-contract failures from the pure evaluator', async () => {
    vi.mocked(loader.loadChecks).mockResolvedValue([
      {
        id: 'semantic-fail',
        type: 'semantic-contract',
        args: {
          diagnostics: [
            {
              category: 'code-graph',
              kind: 'extracted',
              source: 'graph',
              authority: 'authoritative',
              subject: 'mixed authority',
              reason: 'resolved from graph index',
              advisory: true,
            },
          ],
        },
      },
    ]);

    const results = await runChecks('/fake/repo');

    expect(results[0]).toMatchObject({
      id: 'semantic-fail',
      success: false,
    });
    expect(results[0].message).toContain('Semantic contracts failed');
    expect(results[0].message).toContain('authority-consistency: 1');
  });

  it('handles unknown check types', async () => {
    vi.mocked(loader.loadChecks).mockResolvedValue([{ id: 'bad', type: 'unknown-type', args: {} }]);

    const results = await runChecks('/fake/repo', new LocalBackend());
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain('Unknown check type');
  });

  it('handles malformed semantic-contract args', async () => {
    vi.mocked(loader.loadChecks).mockResolvedValue([
      { id: 'bad-semantic', type: 'semantic-contract', args: {} },
    ]);

    const results = await runChecks('/fake/repo');

    expect(results[0]).toEqual({
      id: 'bad-semantic',
      success: false,
      message:
        'Error running check: semantic-contract check requires args.diagnostics to be an array',
    });
  });
});
