import { describe, expect, it, vi } from 'vitest';
import type { GraphNode } from 'ontoindex-shared';
import {
  getNativeGraphWriterStatus,
  isNativeGraphWriterEnabled,
  writeGraphBatch,
  type GraphWriterRuntime,
} from '../../src/native/graph-writer.js';

const nativeModule = () => ({
  writeGraphBatchNative: vi.fn(),
});

const runtime = (env: NodeJS.ProcessEnv): GraphWriterRuntime => ({
  env,
  nativeModule: nativeModule(),
});

const node: GraphNode = {
  id: 'Function:test.ts:run',
  type: 'Function',
  label: 'Function',
  properties: { name: 'run' },
};

describe('native graph writer selection', () => {
  it('treats the native graph writer feature flag as opt-in', () => {
    expect(isNativeGraphWriterEnabled(runtime({}))).toBe(false);
    expect(isNativeGraphWriterEnabled(runtime({ ONTOINDEX_NATIVE_GRAPH_WRITER: '0' }))).toBe(false);
    expect(isNativeGraphWriterEnabled(runtime({ ONTOINDEX_NATIVE_GRAPH_WRITER: 'false' }))).toBe(
      false,
    );
    expect(isNativeGraphWriterEnabled(runtime({ ONTOINDEX_NATIVE_GRAPH_WRITER: '1' }))).toBe(true);
    expect(isNativeGraphWriterEnabled(runtime({ ONTOINDEX_NATIVE_GRAPH_WRITER: 'true' }))).toBe(
      true,
    );
  });

  it('stays disabled when enabled but the native graph writer export is absent', () => {
    expect(
      isNativeGraphWriterEnabled({
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: {},
      }),
    ).toBe(false);
  });

  it('reports native graph writer status when the flag is unset', () => {
    expect(getNativeGraphWriterStatus(runtime({}))).toEqual({
      flagName: 'ONTOINDEX_NATIVE_GRAPH_WRITER',
      configured: false,
      enabled: false,
      available: true,
      reason: 'ONTOINDEX_NATIVE_GRAPH_WRITER is not set',
    });
  });

  it('reports native graph writer status when enabled but unavailable', () => {
    expect(
      getNativeGraphWriterStatus({
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: {},
      }),
    ).toEqual({
      flagName: 'ONTOINDEX_NATIVE_GRAPH_WRITER',
      configured: true,
      enabled: true,
      available: false,
      reason: 'native graph writer export is not available',
    });
  });

  it('does not call the native writer when env false or 0 disables it', async () => {
    for (const value of ['false', '0']) {
      const native = nativeModule();
      const result = await writeGraphBatch('/tmp/ontoindex-native-test', [node], [], {
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: value },
        nativeModule: native,
      });

      expect(native.writeGraphBatchNative).not.toHaveBeenCalled();
      expect(result.nodeCounts.size).toBe(0);
      expect(result.relCounts.size).toBe(0);
    }
  });

  it('calls the native writer when enabled and available', async () => {
    const native = nativeModule();

    const result = await writeGraphBatch('/tmp/ontoindex-native-test', [node], [], {
      env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
      nativeModule: native,
    });

    expect(native.writeGraphBatchNative).toHaveBeenCalledOnce();
    expect(result.nodeCounts.get('Function')).toBe(1);
  });
});
