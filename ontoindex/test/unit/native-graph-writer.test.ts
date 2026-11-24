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

const node = {
  id: 'Function:test.ts:run',
  type: 'Function',
  label: 'Function',
  properties: { name: 'run' },
} as unknown as GraphNode;

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

  it('preserves the original native write failure', async () => {
    const primary = new Error('native write failed');
    const native = nativeModule();
    native.writeGraphBatchNative.mockImplementation(() => {
      throw primary;
    });
    await expect(
      writeGraphBatch('/tmp/ontoindex-native-test', [node], [], {
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: native,
      }),
    ).rejects.toBe(primary);
  });

  it('defers Concept arrays to typed writes after the CSV boundary', async () => {
    const native = nativeModule();
    const mixed = ['kept', '', 0, false, null, undefined, {}, "owner's\\path", '\u0000'];
    const concept = {
      id: 'Concept:normalization',
      label: 'Concept',
      properties: {
        aliases: mixed,
        sourceDocuments: mixed,
        sourceFactKeys: 'not-an-array',
        resolutionKeys: null,
        authority: false,
        confidence: 3,
      },
    } as unknown as GraphNode;
    await writeGraphBatch(
      '/tmp/ontoindex-native-test',
      [
        concept,
        {
          ...node,
          properties: { aliases: [0, false, ''] },
        } as unknown as GraphNode,
      ],
      [],
      {
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: native,
      },
    );

    const nodes = native.writeGraphBatchNative.mock.calls[0][1];
    expect(nodes[0].properties).toEqual({
      aliases: '[]',
      sourceDocuments: '[]',
      sourceFactKeys: '[]',
      resolutionKeys: '[]',
      authority: 'advisory',
      confidence: 'low',
    });
    expect(nodes[1].properties.aliases).toBe("['0','false','']");
    expect(concept.properties.aliases).toBe(mixed);
  });

  it('sanitizes raw fields after Concept defaults and Method navigation type checks', async () => {
    const native = nativeModule();
    const text = 'a\r\nb\rc\t\n😀\uFFFD\uD800\uDC00\uD800x\uDC00\u0000\uFFFF';
    const clean = 'a\nb\nc\t\n😀\uFFFD\uD800\uDC00x';
    const method = {
      id: `Method:${text}`,
      label: 'Method',
      properties: {
        name: text,
        declarationFilePath: 4,
        definitionFilePath: text,
        declarationStartLine: '4',
        declarationEndLine: 0,
        definitionStartLine: NaN,
        definitionEndLine: false,
      },
    } as unknown as GraphNode;
    const concept = {
      id: 'Concept:control',
      label: 'Concept',
      properties: {
        authority: '\u0000',
        confidence: '',
        evidenceClass: false,
        freshness: '\uFFFF',
      },
    } as unknown as GraphNode;
    const snapshot = structuredClone(method);
    await writeGraphBatch(
      '/tmp/ontoindex-native-test',
      [method, concept],
      [
        {
          sourceId: method.id,
          targetId: concept.id,
          type: text,
          confidence: null,
          step: null,
          reason: text,
        } as any,
      ],
      { env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' }, nativeModule: native },
    );
    const [, nodes, rels] = native.writeGraphBatchNative.mock.calls[0];
    expect(nodes[0]).toEqual({
      id: `Method:${clean}`,
      label: 'Method',
      properties: {
        name: clean,
        declarationFilePath: '',
        definitionFilePath: clean,
        declarationStartLine: '-1',
        declarationEndLine: '0',
        definitionStartLine: 'NaN',
        definitionEndLine: '-1',
      },
    });
    expect(nodes[1].properties).toEqual({
      authority: '',
      confidence: 'low',
      evidenceClass: 'docs_evidence',
      freshness: '',
    });
    expect(rels[0]).toMatchObject({
      fromId: `Method:${clean}`,
      toId: concept.id,
      relType: clean,
      properties: { confidence: '1', step: '0', reason: clean },
    });
    expect(method).toEqual(snapshot);
  });
});
