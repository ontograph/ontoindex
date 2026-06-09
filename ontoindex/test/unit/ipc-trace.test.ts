import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/audit/ipc-trace.js', () => ({
  traceIPCBridges: vi.fn(),
}));

import { traceIPCBridges } from '../../src/audit/ipc-trace.js';
import { runIpcTrace } from '../../src/mcp/local/backend-ipc-trace.js';

const traceMock = traceIPCBridges as unknown as ReturnType<typeof vi.fn>;

function makeRepo(): any {
  return {
    id: 'ipc-trace-test',
    name: 'ipc-trace-test',
    repoPath: '/tmp/ipc-trace-test',
  };
}

describe('ipc_trace', () => {
  beforeEach(() => {
    traceMock.mockReset();
  });

  it('returns error when symbol_name is missing or blank', async () => {
    const repo = makeRepo();
    const missing = await runIpcTrace(repo, {});
    expect(missing.status).toBe('error');
    expect(missing.error).toMatch(/symbol_name/);

    const blank = await runIpcTrace(repo, { symbol_name: '   ' });
    expect(blank.status).toBe('error');

    expect(traceMock).not.toHaveBeenCalled();
  });

  it('passes repo metadata through to traceIPCBridges', async () => {
    traceMock.mockResolvedValue({ summary: 'no hits', flow: [] });
    const repo = makeRepo();
    await runIpcTrace(repo, { symbol_name: 'scanAuditPatterns' });
    expect(traceMock).toHaveBeenCalledWith({
      repoId: 'ipc-trace-test',
      repoPath: '/tmp/ipc-trace-test',
      symbolName: 'scanAuditPatterns',
    });
  });

  it('returns flow steps when the bridge is resolvable', async () => {
    traceMock.mockResolvedValue({
      summary: 'Successfully traced IPC bridge for "foo" across 3 steps',
      flow: [
        { kind: 'JS Function', file: 'src/foo.js', line: 10, confidence: 'high' },
        { kind: 'JS Bridge', file: 'src/bridge.js', line: 5, confidence: 'high' },
        { kind: 'C++ Registration', file: 'native/foo.cc', line: 42, confidence: 'high' },
      ],
    });
    const repo = makeRepo();
    const result = await runIpcTrace(repo, { symbol_name: 'foo' });
    expect(result.status).toBe('success');
    expect(result.flow_count).toBe(3);
    expect(result.flow[0].kind).toBe('JS Function');
    expect(result.flow[2].kind).toBe('C++ Registration');
    expect(result.summary).toMatch(/3 steps/);
  });

  it('returns an empty-success structure when no hits are found', async () => {
    traceMock.mockResolvedValue({ summary: 'No IPC bridge traces found', flow: [] });
    const repo = makeRepo();
    const result = await runIpcTrace(repo, { symbol_name: 'absent' });
    expect(result.status).toBe('success');
    expect(result.flow_count).toBe(0);
    expect(result.flow).toEqual([]);
    expect(result.summary).toMatch(/no.*traces/i);
  });

  it('returns an error response when traceIPCBridges throws', async () => {
    traceMock.mockRejectedValue(new Error('graph not initialised'));
    const repo = makeRepo();
    const result = await runIpcTrace(repo, { symbol_name: 'foo' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/graph not initialised/);
    expect(result.flow).toEqual([]);
  });
});
