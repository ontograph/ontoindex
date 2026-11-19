import { GraphNode, GraphRelationship } from 'ontoindex-shared';
import { createRequire } from 'module';
import { isNativeFeatureEnabled, type OntoIndexNativeModule } from './module.js';
import { sanitizeUTF8 } from '../core/lbug/csv-sanitize.js';
const require = createRequire(import.meta.url);

let nativeModule: OntoIndexNativeModule | null = null;

export const NATIVE_GRAPH_BATCH_BYTES = 64 * 1024 * 1024;
const NATIVE_GRAPH_BATCH_COUNT = 1000;

function estimatePropertyBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) {
    let bytes = 2;
    for (const item of value) {
      if (item !== null && item !== undefined) {
        bytes += (typeof item === 'string' ? item.length : String(item).length) * 12 + 32;
      }
    }
    return bytes;
  }
  // UTF-8, array quoting/backslash expansion and CSV quote escaping, without
  // allocating an escaped copy of large content strings.
  return (typeof value === 'string' ? value.length : String(value).length) * 12 + 16;
}

/** Conservative admission estimate; one oversized record is written alone.
 * The input record and its largest scalar conversion remain a single-object
 * residual, including explicit uncapped File content.
 */
export function estimateNativeGraphRecordBytes(record: GraphNode | GraphRelationship): number {
  let bytes = 128;
  if ('properties' in record) {
    bytes +=
      estimatePropertyBytes(record.id) +
      estimatePropertyBytes(record.label || deriveLabel(record.id));
    for (const key in record.properties) {
      if (Object.prototype.hasOwnProperty.call(record.properties, key)) {
        bytes += estimatePropertyBytes(key) + estimatePropertyBytes(record.properties[key]) + 32;
      }
    }
  } else {
    bytes +=
      estimatePropertyBytes(record.sourceId) +
      estimatePropertyBytes(record.targetId) +
      estimatePropertyBytes(deriveLabel(record.sourceId)) +
      estimatePropertyBytes(deriveLabel(record.targetId)) +
      estimatePropertyBytes(record.type) +
      estimatePropertyBytes(record.reason) +
      estimatePropertyBytes(record.confidence) +
      estimatePropertyBytes(record.step ?? 0) +
      128;
  }
  return bytes;
}

function serializedRecordBytes(record: Record<string, string | Record<string, string>>): number {
  let bytes = 128;
  for (const key in record) {
    bytes += Buffer.byteLength(key) * 2 + 32;
    const value = record[key];
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value) * 2;
    } else {
      for (const property in value) {
        bytes += (Buffer.byteLength(property) + Buffer.byteLength(value[property])) * 2 + 32;
      }
    }
  }
  return bytes;
}

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

function serializeNativeProperty(value: unknown): string {
  if (Array.isArray(value)) {
    return sanitizeUTF8(
      `[${value
        .filter((item): item is string | number | boolean => item !== null && item !== undefined)
        .map((item) => `'${String(item).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`)
        .join(',')}]`,
    );
  }
  if (value === undefined || value === null) {
    return '';
  }
  return sanitizeUTF8(String(value));
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
    const writeNative = selectedNativeModule.writeGraphBatchNative.bind(selectedNativeModule);
    let nativeNodes: { id: string; label: string; properties: Record<string, string> }[] = [];
    let nativeRels: {
      fromId: string;
      toId: string;
      relType: string;
      fromLabel: string;
      toLabel: string;
      properties: Record<string, string>;
    }[] = [];
    let batchBytes = 0;
    const flush = () => {
      if (nativeNodes.length + nativeRels.length === 0) return;
      writeNative(csvDir, nativeNodes, nativeRels);
      nativeNodes = [];
      nativeRels = [];
      batchBytes = 0;
    };
    const admit = (bytes: number) => {
      if (
        nativeNodes.length + nativeRels.length >= NATIVE_GRAPH_BATCH_COUNT ||
        batchBytes + bytes > NATIVE_GRAPH_BATCH_BYTES
      )
        flush();
    };

    for (const node of nodes) {
      admit(estimateNativeGraphRecordBytes(node));
      const label = node.label || deriveLabel(node.id);
      const properties: Record<string, string> = Object.create(null);
      for (const key in node.properties) {
        if (Object.prototype.hasOwnProperty.call(node.properties, key)) {
          let value: unknown = node.properties[key];
          if (label === 'Concept') {
            if (['aliases', 'sourceDocuments', 'sourceFactKeys', 'resolutionKeys'].includes(key)) {
              value = Array.isArray(value)
                ? value.filter((item) => typeof item === 'string' && item.length > 0)
                : [];
            } else if (['authority', 'confidence', 'evidenceClass', 'freshness'].includes(key)) {
              const defaults: Record<string, string> = {
                authority: 'advisory',
                confidence: 'low',
                evidenceClass: 'docs_evidence',
                freshness: 'unknown',
              };
              value = typeof value === 'string' && value.length > 0 ? value : defaults[key];
            }
          }
          if (label === 'Method') {
            if (['declarationFilePath', 'definitionFilePath'].includes(key)) {
              value = typeof value === 'string' ? value : '';
            } else if (
              [
                'declarationStartLine',
                'declarationEndLine',
                'definitionStartLine',
                'definitionEndLine',
              ].includes(key)
            ) {
              value = typeof value === 'number' ? value : -1;
            }
          }
          properties[key] = serializeNativeProperty(value);
        }
      }
      const nativeNode = {
        id: sanitizeUTF8(node.id),
        label,
        properties,
      };
      const bytes = serializedRecordBytes(nativeNode);
      admit(bytes);
      nativeNodes.push(nativeNode);
      batchBytes += bytes;
      nodeCounts.set(label, (nodeCounts.get(label) || 0) + 1);
      if (batchBytes >= NATIVE_GRAPH_BATCH_BYTES) flush();
    }

    for (const rel of relationships) {
      admit(estimateNativeGraphRecordBytes(rel));
      const fromLabel = deriveLabel(rel.sourceId);
      const toLabel = deriveLabel(rel.targetId);
      const pairKey = `${fromLabel}|${toLabel}`;
      const nativeRel = {
        fromId: sanitizeUTF8(rel.sourceId),
        toId: sanitizeUTF8(rel.targetId),
        relType: sanitizeUTF8(rel.type),
        fromLabel,
        toLabel,
        properties: {
          confidence: String(rel.confidence ?? 1.0),
          reason: sanitizeUTF8(rel.reason ?? ''),
          step: String(rel.step ?? 0),
        },
      };
      const bytes = serializedRecordBytes(nativeRel);
      admit(bytes);
      nativeRels.push(nativeRel);
      batchBytes += bytes;
      relCounts.set(pairKey, (relCounts.get(pairKey) || 0) + 1);
      if (batchBytes >= NATIVE_GRAPH_BATCH_BYTES) flush();
    }

    flush();
    return { nodeCounts, relCounts };
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
