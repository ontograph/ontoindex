import { GraphNode, GraphRelationship } from 'ontoindex-shared';
import { createRequire } from 'module';
import { isNativeFeatureEnabled, type OntoIndexNativeModule } from './module.js';
const require = createRequire(import.meta.url);

let nativeModule: OntoIndexNativeModule | null = null;

export interface GraphWriterRuntime {
  env?: NodeJS.ProcessEnv;
  nativeModule?: OntoIndexNativeModule | null;
}

export interface NativeGraphWriterStatus {
  flagName: 'ONTOINDEX_NATIVE_GRAPH_WRITER';
  configured: boolean;
  enabled: boolean;
  available: boolean;
  reason: string;
}

try {
  const locations = [
    '../../../ontoindex-native/index.cjs',
    '../../ontoindex-native/index.cjs',
    './ontoindex-native/index.cjs',
  ];

  for (const loc of locations) {
    try {
      nativeModule = require(loc);
      if (nativeModule?.writeGraphBatchNative) break;
    } catch (e) {
      // Continue
    }
  }
} catch (e) {
  // Fallback to JS
}

/**
 * Helper to derive a node label from its ID prefix if not explicitly stored.
 */
function deriveLabel(nodeId: string): string {
  if (nodeId.startsWith('comm_')) return 'Community';
  if (nodeId.startsWith('proc_')) return 'Process';
  return nodeId.split(':')[0] || 'Unknown';
}

/**
 * High-performance graph-to-CSV serializer using native Rust kernel.
 * Returns metadata about the files written.
 */
export async function writeGraphBatch(
  csvDir: string,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  runtime: GraphWriterRuntime = {},
): Promise<{ nodeCounts: Map<string, number>; relCounts: Map<string, number> }> {
  const nodeCounts = new Map<string, number>();
  const relCounts = new Map<string, number>();
  const selectedNativeModule = 'nativeModule' in runtime ? runtime.nativeModule : nativeModule;

  if (isNativeGraphWriterEnabled(runtime) && selectedNativeModule?.writeGraphBatchNative) {
    try {
      // 1. Prepare Nodes for Native
      const nativeNodes = nodes.map((node) => {
        const label = node.label || deriveLabel(node.id);
        nodeCounts.set(label, (nodeCounts.get(label) || 0) + 1);
        return {
          id: node.id,
          label,
          properties: Object.fromEntries(
            Object.entries(node.properties).map(([k, v]) => [k, String(v)]),
          ),
        };
      });

      // 2. Prepare Relationships for Native
      const nativeRels = relationships.map((rel) => {
        const fromLabel = deriveLabel(rel.sourceId);
        const toLabel = deriveLabel(rel.targetId);
        const pairKey = `${fromLabel}|${toLabel}`;
        relCounts.set(pairKey, (relCounts.get(pairKey) || 0) + 1);
        return {
          fromId: rel.sourceId,
          toId: rel.targetId,
          relType: rel.type,
          fromLabel,
          toLabel,
          properties: {
            confidence: String(rel.confidence),
            reason: rel.reason,
            step: rel.step !== undefined ? String(rel.step) : '0',
          },
        };
      });

      selectedNativeModule.writeGraphBatchNative(csvDir, nativeNodes, nativeRels);
      return { nodeCounts, relCounts };
    } catch (e) {
      console.warn('[native] Native graph batch write failed, falling back:', e);
    }
  }

  // Fallback: Pure TS (no-op for now)
  return { nodeCounts: new Map(), relCounts: new Map() };
}

export function isNativeGraphWriterEnabled(runtime: GraphWriterRuntime = {}): boolean {
  const status = getNativeGraphWriterStatus(runtime);
  return status.enabled && status.available;
}

export function getNativeGraphWriterStatus(
  runtime: GraphWriterRuntime = {},
): NativeGraphWriterStatus {
  const env = runtime.env ?? process.env;
  const selectedNativeModule = 'nativeModule' in runtime ? runtime.nativeModule : nativeModule;
  const flagName = 'ONTOINDEX_NATIVE_GRAPH_WRITER' as const;
  const configured = env[flagName] !== undefined;
  const enabled = isNativeFeatureEnabled(env, flagName);
  const available = !!selectedNativeModule?.writeGraphBatchNative;

  let reason = 'enabled and native graph writer is available';
  if (!configured) {
    reason = `${flagName} is not set`;
  } else if (!enabled) {
    reason = `${flagName} is not enabled`;
  } else if (!available) {
    reason = 'native graph writer export is not available';
  }

  return {
    flagName,
    configured,
    enabled,
    available,
    reason,
  };
}
