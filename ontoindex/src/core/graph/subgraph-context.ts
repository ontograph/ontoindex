export type SubgraphContextFormat = 'shape' | 'triples' | 'compact-json';

export interface GraphSchemaNodeLabel {
  id: string;
  properties: readonly string[];
}

export interface GraphSchemaEdgeType {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  properties: readonly string[];
}

export interface GraphSchemaManifestInput {
  nodeLabels?: readonly GraphSchemaNodeLabel[];
  edgeTypes?: readonly GraphSchemaEdgeType[];
}

export interface GraphSchemaManifest {
  nodeLabels: readonly GraphSchemaNodeLabel[];
  edgeTypes: readonly GraphSchemaEdgeType[];
  renderedShape: string;
  warnings: readonly string[];
}

export interface SubgraphContextNode {
  id: string;
  label: string;
  properties: Record<string, GraphPropertyValue>;
  sourceId?: string;
}

export interface SubgraphContextEdge {
  id: string;
  type: string;
  fromNodeId: string;
  toNodeId: string;
  properties: Record<string, GraphPropertyValue>;
  sourceId?: string;
}

export interface SubgraphContextLimits {
  maxNodes: number;
  maxEdges: number;
  maxProperties: number;
  maxTextLength: number;
}

export interface SubgraphContextInput {
  schema: GraphSchemaManifestInput;
  nodes: readonly SubgraphContextNode[];
  edges: readonly SubgraphContextEdge[];
  limits?: Partial<SubgraphContextLimits>;
  formats?: readonly SubgraphContextFormat[];
}

export interface SubgraphContextReport {
  manifest: GraphSchemaManifest;
  limits: SubgraphContextLimits;
  observed: {
    nodes: number;
    edges: number;
    properties: number;
    textLength: number;
  };
  emitted: {
    nodes: number;
    edges: number;
    properties: number;
    textLength: number;
  };
  truncated: {
    nodes: boolean;
    edges: boolean;
    properties: boolean;
    textLength: boolean;
  };
  warnings: readonly string[];
  nodes: readonly SubgraphContextNode[];
  edges: readonly SubgraphContextEdge[];
  rendered: Partial<Record<SubgraphContextFormat, string>>;
}

type GraphPropertyValue = string | number | boolean | null;
type PropertyPair = readonly [string, GraphPropertyValue];

type InternalNode = Readonly<{
  id: string;
  label: string;
  sourceId?: string;
  properties: readonly PropertyPair[];
}>;

type InternalEdge = Readonly<{
  id: string;
  type: string;
  fromNodeId: string;
  toNodeId: string;
  sourceId?: string;
  properties: readonly PropertyPair[];
}>;

const DEFAULT_LIMITS: SubgraphContextLimits = {
  maxNodes: 128,
  maxEdges: 256,
  maxProperties: 256,
  maxTextLength: 4096,
};

export function buildGraphSchemaManifest(input: GraphSchemaManifestInput = {}): GraphSchemaManifest {
  const normalizedNodeLabelsResult = dedupeByIdWithWarnings(
    (input.nodeLabels ?? [])
      .map((nodeLabel) => ({
        id: normalizeText(nodeLabel?.id),
        properties: normalizePropertiesList(nodeLabel?.properties),
      }))
      .filter((nodeLabel) => nodeLabel.id.length > 0)
      .sort((left, right) => compareLexical(left.id, right.id)),
    'node label',
  );

  const normalizedEdgeTypesResult = dedupeByIdWithWarnings(
    (input.edgeTypes ?? [])
      .map((edgeType) => ({
        id: normalizeText(edgeType?.id),
        sourceLabel: normalizeText(edgeType?.sourceLabel),
        targetLabel: normalizeText(edgeType?.targetLabel),
        properties: normalizePropertiesList(edgeType?.properties),
      }))
      .filter(
        (edgeType) =>
          edgeType.id.length > 0 &&
          edgeType.sourceLabel.length > 0 &&
          edgeType.targetLabel.length > 0,
      )
      .sort((left, right) => compareLexical(left.id, right.id)),
    'edge type',
  );

  const normalizedNodeLabels = normalizedNodeLabelsResult.items;
  const normalizedEdgeTypes = normalizedEdgeTypesResult.items;

  const nodeLabelById = new Map(
    normalizedNodeLabels.map((nodeLabel) => [nodeLabel.id, nodeLabel] as const),
  );

  const renderedShape = normalizedEdgeTypes
    .map((edgeType) => {
      const sourceLabel = nodeLabelById.get(edgeType.sourceLabel);
      const sourceText = sourceLabel
        ? formatLabelWithProperties(sourceLabel.id, sourceLabel.properties)
        : edgeType.sourceLabel;
      return `${sourceText} -${edgeType.id}-> ${edgeType.targetLabel}`;
    })
    .join('\n');

  return {
    nodeLabels: normalizedNodeLabels,
    edgeTypes: normalizedEdgeTypes,
    renderedShape,
    warnings: dedupeWarnings([
      ...normalizedNodeLabelsResult.warnings,
      ...normalizedEdgeTypesResult.warnings,
    ]),
  };
}

export function buildSubgraphContext(input: SubgraphContextInput): SubgraphContextReport {
  const limits = resolveLimits(input.limits);
  const requestedFormats = resolveFormats(input.formats);
  const manifest = buildGraphSchemaManifest(input.schema);

  const nodesSorted = normalizeSubgraphNodes(input.nodes).sort(nodeSort);
  const edgesSorted = normalizeSubgraphEdges(input.edges).sort(edgeSort);

  const nodeDedupe = dedupeByIdWithWarnings(nodesSorted, 'node');
  const edgeDedupe = dedupeByIdWithWarnings(edgesSorted, 'edge');

  const dedupedNodes = nodeDedupe.items;
  const dedupedEdges = edgeDedupe.items;

  const emittedNodesRaw = dedupedNodes.slice(0, limits.maxNodes);
  const emittedEdgesRaw = dedupedEdges.slice(0, limits.maxEdges);

  const observedPropertyCount =
    dedupedNodes.reduce((sum, node) => sum + node.properties.length, 0) +
    dedupedEdges.reduce((sum, edge) => sum + edge.properties.length, 0);

  const nodeMap = new Map<string, InternalNode>(emittedNodesRaw.map((node) => [node.id, node] as const));

  const warnings: string[] = [...manifest.warnings, ...nodeDedupe.warnings, ...edgeDedupe.warnings];

  for (const edge of emittedEdgesRaw) {
    if (!nodeMap.has(edge.fromNodeId) || !nodeMap.has(edge.toNodeId)) {
      warnings.push(
        `Dangling edge ${edge.id}: endpoint missing for ${edge.fromNodeId} -> ${edge.toNodeId}.`,
      );
    }
  }

  const {
    emittedItems: emittedNodes,
    propertyCount: emittedNodeProperties,
    warnings: nodePropertyWarnings,
  } = truncatePropertyLists(emittedNodesRaw, limits.maxProperties);

  const remainingProperties = Math.max(0, limits.maxProperties - emittedNodeProperties);
  const {
    emittedItems: emittedEdges,
    propertyCount: emittedEdgeProperties,
    warnings: edgePropertyWarnings,
  } = truncatePropertyLists(emittedEdgesRaw, remainingProperties);

  const emittedProperties = emittedNodeProperties + emittedEdgeProperties;
  const emittedNodesForOutput = emittedNodes.map(toContextNodeRecord);
  const emittedEdgesForOutput = emittedEdges.map(toContextEdgeRecord);

  const emittedNodeMap = new Map(
    emittedNodesForOutput.map((node) => [node.id, node] as const),
  );

  const renderedShape = manifest.renderedShape;
  const renderedTriples = emittedEdges
    .map((edge) => {
      const fromNode = emittedNodeMap.get(edge.fromNodeId);
      const toNode = emittedNodeMap.get(edge.toNodeId);
      return `${fromNode?.label ?? edge.fromNodeId}:${edge.fromNodeId} ${edge.type} ${
        toNode?.label ?? edge.toNodeId
      }:${edge.toNodeId}`;
    })
    .join('\n');

  const compactPayload = makeCompactJsonPayload({
    manifestShape: renderedShape,
    nodes: emittedNodesForOutput,
    edges: emittedEdgesForOutput,
    observed: {
      nodes: dedupedNodes.length,
      edges: dedupedEdges.length,
      properties: observedPropertyCount,
    },
    emitted: {
      nodes: emittedNodesForOutput.length,
      edges: emittedEdgesForOutput.length,
      properties: emittedProperties,
    },
    omitted: {
      nodes: dedupedNodes.length - emittedNodesForOutput.length,
      edges: dedupedEdges.length - emittedEdgesForOutput.length,
      properties: observedPropertyCount - emittedProperties,
    },
    warnings: dedupeWarnings([...warnings, ...nodePropertyWarnings, ...edgePropertyWarnings]),
  });

  const rawRendered: Partial<Record<SubgraphContextFormat, string>> = {
    shape: renderedShape,
    triples: renderedTriples,
    'compact-json': JSON.stringify(compactPayload),
  };

  const observedTextLength = requestedFormats.reduce(
    (sum, format) => sum + (rawRendered[format] ?? '').length,
    0,
  );

  const rendered: Partial<Record<SubgraphContextFormat, string>> = {};
  let emittedTextLength = 0;
  let textLengthTruncated = false;

  for (const format of requestedFormats) {
    const candidate = rawRendered[format] ?? '';
    const truncated = candidate.length > limits.maxTextLength;
    const text = truncated
      ? candidate.slice(0, Math.max(0, limits.maxTextLength))
      : candidate;

    rendered[format] = text;
    emittedTextLength += text.length;
    textLengthTruncated = textLengthTruncated || truncated;
  }

  return {
    manifest: {
      ...manifest,
      warnings: dedupeWarnings(manifest.warnings),
    },
    limits,
    observed: {
      nodes: dedupedNodes.length,
      edges: dedupedEdges.length,
      properties: observedPropertyCount,
      textLength: observedTextLength,
    },
    emitted: {
      nodes: emittedNodesForOutput.length,
      edges: emittedEdgesForOutput.length,
      properties: emittedProperties,
      textLength: emittedTextLength,
    },
    truncated: {
      nodes: emittedNodesRaw.length < dedupedNodes.length,
      edges: emittedEdgesRaw.length < dedupedEdges.length,
      properties: emittedProperties < observedPropertyCount,
      textLength: textLengthTruncated,
    },
    warnings: dedupeWarnings([...warnings, ...nodePropertyWarnings, ...edgePropertyWarnings]),
    nodes: emittedNodesForOutput,
    edges: emittedEdgesForOutput,
    rendered,
  };
}

function resolveLimits(input?: Partial<SubgraphContextLimits>): SubgraphContextLimits {
  return {
    maxNodes: normalizeLimit(input?.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxEdges: normalizeLimit(input?.maxEdges, DEFAULT_LIMITS.maxEdges),
    maxProperties: normalizeLimit(input?.maxProperties, DEFAULT_LIMITS.maxProperties),
    maxTextLength: normalizeLimit(input?.maxTextLength, DEFAULT_LIMITS.maxTextLength),
  };
}

function resolveFormats(formats?: readonly SubgraphContextFormat[]): readonly SubgraphContextFormat[] {
  if (!formats || formats.length === 0) {
    return ['shape', 'triples', 'compact-json'];
  }

  const unique: SubgraphContextFormat[] = [];
  for (const format of formats) {
    if (
      format !== 'shape' &&
      format !== 'triples' &&
      format !== 'compact-json'
    ) {
      continue;
    }
    if (!unique.includes(format)) unique.push(format);
  }

  return unique.length > 0 ? unique : ['shape', 'triples', 'compact-json'];
}

function normalizeLimit(value: unknown, fallback: number): number {
  const candidate = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(candidate) || candidate < 0) return fallback;
  return candidate;
}

function dedupeById<T extends { id: string }>(
  items: readonly T[],
  kind: string,
  warnings?: string[],
): T[] {
  const result = dedupeByIdWithWarnings(items, kind, warnings);
  return result.items;
}

function dedupeByIdWithWarnings<T extends { id: string }>(
  items: readonly T[],
  kind: string,
  warnings: string[] = [],
): { items: T[]; warnings: string[] } {
  const seen = new Set<string>();
  const deduped: T[] = [];
  const collected = [...warnings];

  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) {
      collected.push(`Duplicate ${kind} id "${item.id}" was skipped.`);
      continue;
    }
    seen.add(item.id);
    deduped.push(item);
  }

  return { items: deduped, warnings: collected };
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function compareLexical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizePropertiesList(values?: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) return [];
  const normalized = values.map((name) => normalizeText(name)).filter((name) => name.length > 0);
  return [...new Set(normalized)].sort(compareLexical);
}

function formatLabelWithProperties(label: string, properties: readonly string[]): string {
  if (properties.length === 0) return label;
  return `${label} {${properties.join(',')}}`;
}

function normalizeSubgraphNodes(nodes: readonly SubgraphContextNode[]): InternalNode[] {
  return nodes
    .map((node) => ({
      id: normalizeText(node?.id),
      label: normalizeText(node?.label),
      sourceId: normalizeText(node?.sourceId).length > 0 ? normalizeText(node.sourceId) : undefined,
      properties: normalizePropertiesFromRecord(node?.properties),
    }))
    .filter((node) => node.id.length > 0 && node.label.length > 0);
}

function normalizeSubgraphEdges(edges: readonly SubgraphContextEdge[]): InternalEdge[] {
  return edges
    .map((edge) => ({
      id: normalizeText(edge?.id),
      type: normalizeText(edge?.type),
      fromNodeId: normalizeText(edge?.fromNodeId),
      toNodeId: normalizeText(edge?.toNodeId),
      sourceId: normalizeText(edge?.sourceId).length > 0 ? normalizeText(edge.sourceId) : undefined,
      properties: normalizePropertiesFromRecord(edge?.properties),
    }))
    .filter(
      (edge) =>
        edge.id.length > 0 &&
        edge.type.length > 0 &&
        edge.fromNodeId.length > 0 &&
        edge.toNodeId.length > 0,
    );
}

function normalizePropertiesFromRecord(properties?: unknown): readonly PropertyPair[] {
  if (!properties || typeof properties !== 'object') return [];

  const source = properties as Record<string, unknown>;
  const keys = Object.keys(source).filter((name) => name.trim().length > 0).sort(compareLexical);

  const propertyPairs: PropertyPair[] = [];
  for (const key of keys) {
    propertyPairs.push([key, normalizePropertyValue(source[key])]);
  }
  return propertyPairs;
}

function normalizePropertyValue(value: unknown): GraphPropertyValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return null;
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : rendered;
  } catch {
    return String(value);
  }
}

function nodeSort(left: InternalNode, right: InternalNode): number {
  const idCmp = compareLexical(left.id, right.id);
  if (idCmp !== 0) return idCmp;
  return compareLexical(left.label, right.label);
}

function edgeSort(left: InternalEdge, right: InternalEdge): number {
  const idCmp = compareLexical(left.id, right.id);
  if (idCmp !== 0) return idCmp;
  const fromCmp = compareLexical(left.fromNodeId, right.fromNodeId);
  if (fromCmp !== 0) return fromCmp;
  const toCmp = compareLexical(left.toNodeId, right.toNodeId);
  if (toCmp !== 0) return toCmp;
  return compareLexical(left.type, right.type);
}

function truncatePropertyLists<T extends { id: string; properties: readonly PropertyPair[] }>(
  items: readonly T[],
  maxProperties: number,
): { emittedItems: T[]; propertyCount: number; warnings: string[] } {
  let remaining = Math.max(0, maxProperties);
  const emittedItems: T[] = [];
  let propertyCount = 0;
  const warnings: string[] = [];

  for (const item of items) {
    const keptProperties = item.properties.slice(0, remaining);
    remaining -= keptProperties.length;
    propertyCount += keptProperties.length;

    if (keptProperties.length !== item.properties.length) {
      warnings.push(`Property list on ${item.id} was truncated.`);
    }

    emittedItems.push({ ...(item as T), properties: keptProperties } as T);
    if (remaining <= 0) {
      continue;
    }
  }

  return { emittedItems, propertyCount, warnings };
}

function toContextNodeRecord(node: InternalNode): SubgraphContextNode {
  return {
    id: node.id,
    label: node.label,
    sourceId: node.sourceId,
    properties: propertyPairsToRecord(node.properties),
  };
}

function toContextEdgeRecord(edge: InternalEdge): SubgraphContextEdge {
  return {
    id: edge.id,
    type: edge.type,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    sourceId: edge.sourceId,
    properties: propertyPairsToRecord(edge.properties),
  };
}

function propertyPairsToRecord(pairs: readonly PropertyPair[]): Record<string, GraphPropertyValue> {
  const properties: Record<string, GraphPropertyValue> = {};
  for (const [key, value] of pairs) {
    properties[key] = value;
  }
  return properties;
}

function dedupeWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)];
}

function makeCompactJsonPayload(input: {
  manifestShape: string;
  nodes: readonly SubgraphContextNode[];
  edges: readonly SubgraphContextEdge[];
  observed: { nodes: number; edges: number; properties: number };
  emitted: { nodes: number; edges: number; properties: number };
  omitted: { nodes: number; edges: number; properties: number };
  warnings: readonly string[];
}) {
  return {
    v: 1,
    n: input.nodes.map((node) => [
      node.id,
      node.label,
      node.properties,
      node.sourceId ?? null,
    ]),
    e: input.edges.map((edge) => [
      edge.id,
      edge.type,
      edge.fromNodeId,
      edge.toNodeId,
      edge.properties,
      edge.sourceId ?? null,
    ]),
    s: input.manifestShape,
    c: {
      o: input.omitted,
      e: input.emitted,
      m: input.observed,
    },
    w: input.warnings,
  };
}
