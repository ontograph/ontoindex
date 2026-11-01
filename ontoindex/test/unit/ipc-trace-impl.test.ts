import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../src/audit/scan-engine.js', () => ({
  scanAuditPatterns: vi.fn(),
}));

vi.mock('../../src/core/ingestion/filesystem-walker.js', () => ({
  walkRepositoryPaths: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { traceIPCBridges } from '../../src/audit/ipc-trace.js';
import { scanAuditPatterns } from '../../src/audit/scan-engine.js';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';

const executeParameterizedMock = vi.mocked(executeParameterized);
const scanAuditPatternsMock = vi.mocked(scanAuditPatterns);
const walkRepositoryPathsMock = vi.mocked(walkRepositoryPaths);

describe('traceIPCBridges', () => {
  beforeEach(() => {
    executeParameterizedMock.mockReset();
    scanAuditPatternsMock.mockReset();
    walkRepositoryPathsMock.mockReset();

    walkRepositoryPathsMock.mockResolvedValue([]);
    scanAuditPatternsMock.mockResolvedValue({ hits: [] } as never);
  });

  it('labels Rust symbols without JS wording', async () => {
    executeParameterizedMock.mockResolvedValueOnce([
      {
        filePath: 'src/native/provider.rs',
        startLine: 12,
        labels: ['Function'],
        id: 'rust-fn',
      },
    ]);

    const result = await traceIPCBridges({
      repoId: 'ontoindex',
      repoPath: '/tmp/repo',
      symbolName: 'create_model_provider',
    });

    expect(result.flow).toHaveLength(1);
    expect(result.flow[0].kind).toBe('Rust Function');
    expect(result.flow[0].detail).toBe('Rust definition/export of "create_model_provider"');
    expect(result.summary).toMatch(/1 observations.*connectivity unverified/);
  });

  it('keeps JS symbols clearly labeled', async () => {
    executeParameterizedMock.mockResolvedValueOnce([
      {
        filePath: 'src/runtime/ipc-bridge.ts',
        startLine: 8,
        labels: ['Function'],
        id: 'js-fn',
      },
    ]);

    const result = await traceIPCBridges({
      repoId: 'ontoindex',
      repoPath: '/tmp/repo',
      symbolName: 'traceBridge',
    });

    expect(result.flow).toHaveLength(1);
    expect(result.flow[0].kind).toBe('JS Function');
    expect(result.flow[0].detail).toBe('JS definition/export of "traceBridge"');
    expect(result.summary).toMatch(/1 observations.*connectivity unverified/);
  });

  it('does not claim connectivity from disconnected native observations', async () => {
    executeParameterizedMock
      .mockResolvedValueOnce([
        { filePath: 'src/bridge.ts', startLine: 8, labels: ['Function'], id: 'js-fn' },
      ])
      .mockResolvedValueOnce([{ name: 'fooUnrelated', startLine: 42 }]);
    walkRepositoryPathsMock.mockResolvedValue([
      { path: 'src/bridge.ts' },
      { path: 'native/unrelated.cc' },
    ] as never);
    scanAuditPatternsMock
      .mockResolvedValueOnce({ hits: [{ file: '/tmp/repo/src/bridge.ts', line: 3 }] } as never)
      .mockResolvedValueOnce({
        hits: [{ file: '/tmp/repo/native/unrelated.cc', line: 30 }],
      } as never);

    const result = await traceIPCBridges({
      repoId: 'ontoindex',
      repoPath: '/tmp/repo',
      symbolName: 'foo',
    });

    expect(result.summary).toBe(
      'Collected 3 observations for "foo"; bridge connectivity unverified',
    );
    expect(result.flow).toEqual([
      expect.objectContaining({
        kind: 'JS Bridge Candidate',
        file: 'src/bridge.ts',
        line: 8,
        confidence: 'high',
        detail: expect.stringMatching(/same file; bridge connectivity unverified/),
      }),
      expect.objectContaining({
        kind: 'C++ Registration',
        file: 'native/unrelated.cc',
        line: 30,
        confidence: 'high',
        detail: expect.stringMatching(/Possible Node-API registration.*text match.*unverified/),
      }),
      expect.objectContaining({
        kind: 'C++ Implementation',
        file: 'native/unrelated.cc',
        line: 42,
        confidence: 'medium',
        detail: expect.stringMatching(
          /Candidate.*heuristic name match; registration linkage unverified/,
        ),
      }),
    ]);
  });

  it('returns no traces when no observations exist', async () => {
    executeParameterizedMock.mockResolvedValueOnce([]);
    const result = await traceIPCBridges({
      repoId: 'ontoindex',
      repoPath: '/tmp/repo',
      symbolName: 'absent',
    });
    expect(result).toEqual({ summary: 'No IPC bridge traces found for "absent"', flow: [] });
  });
});
