export type VirtualSourceKind = 'sqlite' | 'duckdb' | 'jsonl' | 'csv' | 'http-json' | 'custom';

export type VirtualProjectionKind = 'node' | 'relationship';

export type VirtualSourceValidationSeverity = 'error' | 'warning' | 'info';

export interface VirtualSourceDefinition {
  readonly name: string;
  readonly kind: VirtualSourceKind | string;
}

export interface VirtualFieldMapping {
  readonly sourceField: string;
  readonly graphField: string;
}

export interface VirtualNodeProjection {
  readonly projectionKind: 'node';
  readonly sourceName: string;
  readonly graphLabel: string;
  readonly primaryKey: string;
  readonly fieldMappings: readonly VirtualFieldMapping[];
  readonly projectionId: string;
}

export interface VirtualRelationshipProjection {
  readonly projectionKind: 'relationship';
  readonly sourceName: string;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relationshipType: string;
  readonly joinFields: readonly string[];
  readonly projectionId: string;
}

export interface VirtualSourceMapping {
  readonly sources: readonly VirtualSourceDefinition[];
  readonly nodes: readonly VirtualNodeProjection[];
  readonly relationships: readonly VirtualRelationshipProjection[];
}

export type VirtualSourceValidationDiagnosticCode =
  | 'missing-source'
  | 'missing-source-reference'
  | 'unsupported-source-kind'
  | 'invalid-source-name'
  | 'missing-primary-key'
  | 'missing-field-mappings'
  | 'missing-relationship-type'
  | 'missing-relationship-endpoints'
  | 'invalid-join-fields'
  | 'invalid-label'
  | 'invalid-field-mapping'
  | 'dangling-relationship-endpoint'
  | 'missing-projection-kind'
  | 'duplicate-projection';

export interface VirtualSourceValidationDiagnostic {
  readonly code: VirtualSourceValidationDiagnosticCode;
  readonly severity: VirtualSourceValidationSeverity;
  readonly projectionKind?: VirtualProjectionKind;
  readonly projectionId?: string;
  readonly sourceName?: string;
  readonly graphLabel?: string;
  readonly relationshipType?: string;
  readonly message: string;
}

export interface VirtualSourceValidationSummaries {
  readonly bySourceKind: Record<string, number>;
  readonly byNodeLabel: Record<string, number>;
  readonly byRelationshipType: Record<string, number>;
  readonly byDiagnosticSeverity: Record<VirtualSourceValidationSeverity, number>;
}

export interface VirtualSourceValidationReport {
  readonly mapping: VirtualSourceMapping;
  readonly diagnostics: readonly VirtualSourceValidationDiagnostic[];
  readonly summaries: VirtualSourceValidationSummaries;
}

export interface VirtualSourceValidationInput {
  readonly sourceDefinitions?: readonly unknown[] | undefined;
  readonly sources?: readonly unknown[] | undefined;
  readonly virtualNodeProjections?: readonly unknown[] | undefined;
  readonly virtualRelationshipProjections?: readonly unknown[] | undefined;
  readonly graphProjections?: readonly unknown[] | undefined;
}

const SUPPORTED_SOURCE_KINDS = new Set<string>([
  'sqlite',
  'duckdb',
  'jsonl',
  'csv',
  'http-json',
  'custom',
]);

const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_:-]*$/;

const SEVERITY_RANK: Record<VirtualSourceValidationSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function buildVirtualSourceDefinition(input: unknown): VirtualSourceDefinition {
  const record = asRecord(input);
  return {
    name: normalizeText(record.name),
    kind: normalizeText(record.kind),
  };
}

export function buildVirtualFieldMapping(input: unknown): VirtualFieldMapping {
  const record = asRecord(input);
  return {
    sourceField: normalizeText(record.sourceField ?? record.from),
    graphField: normalizeText(record.graphField ?? record.to),
  };
}

export function buildVirtualNodeProjection(input: unknown): VirtualNodeProjection {
  const record = asRecord(input);
  const sourceName = normalizeText(record.sourceName);
  const graphLabel = normalizeText(record.graphLabel);
  const primaryKey = normalizeText(record.primaryKey);
  const fieldMappings = asArray(record.fieldMappings).map((entry) => buildVirtualFieldMapping(entry));

  return {
    projectionKind: 'node',
    sourceName,
    graphLabel,
    primaryKey,
    fieldMappings,
    projectionId: buildNodeProjectionId(sourceName, graphLabel, primaryKey),
  };
}

export function buildVirtualRelationshipProjection(input: unknown): VirtualRelationshipProjection {
  const record = asRecord(input);
  const sourceName = normalizeText(record.sourceName);
  const sourceNode = normalizeText(record.sourceNode);
  const targetNode = normalizeText(record.targetNode);
  const relationshipType = normalizeText(record.relationshipType);
  const joinFields = asArray(record.joinFields)
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0)
    .sort((a, b) => a.localeCompare(b));

  return {
    projectionKind: 'relationship',
    sourceName,
    sourceNode,
    targetNode,
    relationshipType,
    joinFields,
    projectionId: buildRelationshipProjectionId(sourceName, relationshipType, joinFields),
  };
}

export function validateVirtualSourceMapping(input: VirtualSourceValidationInput): VirtualSourceValidationReport {
  const sourceInputs = asArray(input?.sourceDefinitions ?? input?.sources);
  const nodeInputs = asArray(input?.virtualNodeProjections);
  const relationshipInputs = asArray(input?.virtualRelationshipProjections);
  const graphInputs = asArray(input?.graphProjections);

  const diagnostics: VirtualSourceValidationDiagnostic[] = [];

  const parsedSources = sourceInputs.map((sourceInput) => buildVirtualSourceDefinition(sourceInput));
  const sourceNames = new Set<string>();
  const sourceKindCounts = new Map<string, number>();

  const validSources: VirtualSourceDefinition[] = [];
  for (const source of parsedSources) {
    const kind = normalizeSourceKind(source.kind);
    if (!source.name) {
      diagnostics.push({
        code: 'invalid-source-name',
        severity: 'error',
        message: 'source name must be a non-empty string',
      });
      continue;
    }

    const normalized = { ...source, kind };
    sourceNames.add(normalized.name);
    sourceKindCounts.set(kind, (sourceKindCounts.get(kind) ?? 0) + 1);
    validSources.push(normalized);

    if (!SUPPORTED_SOURCE_KINDS.has(kind)) {
      diagnostics.push({
        code: 'unsupported-source-kind',
        severity: 'error',
        sourceName: normalized.name,
        message: `unsupported source kind ${kind}`,
      });
    }
  }

  const parsedNodes: VirtualNodeProjection[] = [];
  for (const nodeInput of nodeInputs) {
    const node = buildVirtualNodeProjection(nodeInput);
    parsedNodes.push(node);
    validateNode(node, sourceNames, diagnostics);
  }

  const parsedRelationships: VirtualRelationshipProjection[] = [];
  for (const relationshipInput of relationshipInputs) {
    const relationship = buildVirtualRelationshipProjection(relationshipInput);
    parsedRelationships.push(relationship);
    validateRelationship(relationship, sourceNames, diagnostics);
  }

  for (const graphInput of graphInputs) {
    const graphRecord = asRecord(graphInput);
    const rawKind = normalizeText(graphRecord.projectionKind ?? graphRecord.projection_kind ?? graphRecord.kind);
    if (rawKind === 'node') {
      const node = buildVirtualNodeProjection(graphRecord);
      parsedNodes.push(node);
      validateNode(node, sourceNames, diagnostics);
      continue;
    }

    if (rawKind === 'relationship') {
      const relationship = buildVirtualRelationshipProjection(graphRecord);
      parsedRelationships.push(relationship);
      validateRelationship(relationship, sourceNames, diagnostics);
      continue;
    }

    diagnostics.push({
      code: 'missing-projection-kind',
      severity: 'error',
      message: `graph projection is missing projectionKind or has unsupported value: ${rawKind || '<empty>'}`,
    });
  }

  const nodeByIdentity = new Map<string, number>();
  for (const node of parsedNodes) {
    const key = buildNodeProjectionId(node.sourceName, node.graphLabel, node.primaryKey);
    nodeByIdentity.set(key, (nodeByIdentity.get(key) ?? 0) + 1);
  }

  const relationshipByIdentity = new Map<string, number>();
  for (const relationship of parsedRelationships) {
    const key = buildRelationshipProjectionId(
      relationship.sourceName,
      relationship.relationshipType,
      relationship.joinFields,
    );
    relationshipByIdentity.set(key, (relationshipByIdentity.get(key) ?? 0) + 1);
  }

  for (const [identity, count] of nodeByIdentity.entries()) {
    if (count > 1) {
      diagnostics.push({
        code: 'duplicate-projection',
        severity: 'warning',
        projectionKind: 'node',
        projectionId: identity,
        message: `duplicate node projection ${identity}`,
      });
    }
  }

  for (const [identity, count] of relationshipByIdentity.entries()) {
    if (count > 1) {
      diagnostics.push({
        code: 'duplicate-projection',
        severity: 'warning',
        projectionKind: 'relationship',
        projectionId: identity,
        message: `duplicate relationship projection ${identity}`,
      });
    }
  }

  validateRelationshipEndpoints(parsedRelationships, parsedNodes, diagnostics);

  const stableNodes = [...parsedNodes].sort((left, right) =>
    compareNodeProjection(left, right),
  );
  const stableRelationships = [...parsedRelationships].sort((left, right) =>
    compareRelationshipProjection(left, right),
  );
  const stableSources = [...validSources].sort((left, right) => {
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) {
      return byKind;
    }
    return left.name.localeCompare(right.name);
  });

  const diagnosticsSorted = [...diagnostics].sort(compareDiagnostic);
  const byDiagnosticSeverity = summarizeSeverities(diagnosticsSorted);

  const bySourceKind = sortedCountRecord(sourceKindCounts);
  const byNodeLabel = sortedCountFromArray(stableNodes.map((item) => item.graphLabel));
  const byRelationshipType = sortedCountFromArray(stableRelationships.map((item) => item.relationshipType));

  return {
    mapping: {
      sources: stableSources,
      nodes: stableNodes,
      relationships: stableRelationships,
    },
    diagnostics: diagnosticsSorted,
    summaries: {
      bySourceKind,
      byNodeLabel,
      byRelationshipType,
      byDiagnosticSeverity,
    },
  };
}

function validateNode(
  projection: VirtualNodeProjection,
  sourceNames: Set<string>,
  diagnostics: VirtualSourceValidationDiagnostic[],
): void {
  if (!projection.graphLabel) {
    diagnostics.push({
      code: 'invalid-label',
      severity: 'error',
      projectionKind: 'node',
      projectionId: projection.projectionId,
      graphLabel: projection.graphLabel,
      message: `virtual node projection ${projection.projectionId} has no graph label`,
    });
    return;
  }

  if (!LABEL_PATTERN.test(projection.graphLabel)) {
    diagnostics.push({
      code: 'invalid-label',
      severity: 'error',
      projectionKind: 'node',
      projectionId: projection.projectionId,
      graphLabel: projection.graphLabel,
      message: `invalid node label ${projection.graphLabel}`,
    });
  }

  if (!projection.sourceName) {
    diagnostics.push({
      code: 'missing-source',
      severity: 'error',
      projectionKind: 'node',
      projectionId: projection.projectionId,
      message: `virtual node projection ${projection.graphLabel} has no sourceName`,
    });
  } else if (!sourceNames.has(projection.sourceName)) {
    diagnostics.push({
      code: 'missing-source-reference',
      severity: 'error',
      projectionKind: 'node',
      projectionId: projection.projectionId,
      sourceName: projection.sourceName,
      message: `node projection ${projection.projectionId} references missing source ${projection.sourceName}`,
    });
  }

  if (!projection.primaryKey) {
    diagnostics.push({
      code: 'missing-primary-key',
      severity: 'error',
      projectionKind: 'node',
      projectionId: projection.projectionId,
      graphLabel: projection.graphLabel,
      message: `node projection ${projection.projectionId} has no primary key`,
    });
  }

  if (!Array.isArray((projection as { fieldMappings: unknown }).fieldMappings)) {
    diagnostics.push({
      code: 'missing-field-mappings',
      severity: 'error',
      projectionKind: 'node',
      projectionId: projection.projectionId,
      graphLabel: projection.graphLabel,
      message: `node projection ${projection.projectionId} has no fieldMappings`,
    });
    return;
  }

  if (projection.fieldMappings.length === 0) {
    diagnostics.push({
      code: 'missing-field-mappings',
      severity: 'error',
      projectionKind: 'node',
      projectionId: projection.projectionId,
      graphLabel: projection.graphLabel,
      message: `node projection ${projection.projectionId} must define fieldMappings`,
    });
    return;
  }

  for (const mapping of projection.fieldMappings) {
    if (!mapping.sourceField || !mapping.graphField) {
      diagnostics.push({
        code: 'invalid-field-mapping',
        severity: 'warning',
        projectionKind: 'node',
        projectionId: projection.projectionId,
        graphLabel: projection.graphLabel,
        message: `node projection ${projection.projectionId} has incomplete field mapping`,
      });
      continue;
    }

    if (!LABEL_PATTERN.test(mapping.sourceField) || !LABEL_PATTERN.test(mapping.graphField)) {
      diagnostics.push({
        code: 'invalid-field-mapping',
        severity: 'warning',
        projectionKind: 'node',
        projectionId: projection.projectionId,
        graphLabel: projection.graphLabel,
        message: `node projection ${projection.projectionId} has invalid field mapping`,
      });
    }
  }
}

function validateRelationship(
  projection: VirtualRelationshipProjection,
  sourceNames: Set<string>,
  diagnostics: VirtualSourceValidationDiagnostic[],
): void {
  if (!projection.sourceName) {
    diagnostics.push({
      code: 'missing-source',
      severity: 'error',
      projectionKind: 'relationship',
      projectionId: projection.projectionId,
      message: `relationship projection ${projection.projectionId} has no sourceName`,
    });
  } else if (!sourceNames.has(projection.sourceName)) {
    diagnostics.push({
      code: 'missing-source-reference',
      severity: 'error',
      projectionKind: 'relationship',
      projectionId: projection.projectionId,
      sourceName: projection.sourceName,
      message: `relationship projection ${projection.projectionId} references missing source ${projection.sourceName}`,
    });
  }

  if (!projection.relationshipType) {
    diagnostics.push({
      code: 'missing-relationship-type',
      severity: 'error',
      projectionKind: 'relationship',
      projectionId: projection.projectionId,
      message: `relationship projection ${projection.projectionId} has no relationshipType`,
    });
  } else if (!LABEL_PATTERN.test(projection.relationshipType)) {
    diagnostics.push({
      code: 'invalid-label',
      severity: 'error',
      projectionKind: 'relationship',
      projectionId: projection.projectionId,
      relationshipType: projection.relationshipType,
      message: `invalid relationship type ${projection.relationshipType}`,
    });
  }

  if (!projection.sourceNode || !projection.targetNode) {
    diagnostics.push({
      code: 'missing-relationship-endpoints',
      severity: 'error',
      projectionKind: 'relationship',
      projectionId: projection.projectionId,
      message: `relationship projection ${projection.projectionId} is missing source/target node references`,
    });
    return;
  }

  if (!projection.joinFields || projection.joinFields.length === 0) {
    diagnostics.push({
      code: 'invalid-join-fields',
      severity: 'error',
      projectionKind: 'relationship',
      projectionId: projection.projectionId,
      message: `relationship projection ${projection.projectionId} has no join fields`,
    });
  }
}

function validateRelationshipEndpoints(
  relationships: readonly VirtualRelationshipProjection[],
  nodes: readonly VirtualNodeProjection[],
  diagnostics: VirtualSourceValidationDiagnostic[],
): void {
  const nodeIndex = new Set<string>();
  for (const node of nodes) {
    if (node.sourceName && node.graphLabel) {
      nodeIndex.add(`${node.sourceName}::${node.graphLabel}`);
    }
  }

  for (const relationship of relationships) {
    if (!relationship.sourceName || !relationship.sourceNode || !relationship.targetNode) {
      continue;
    }

    const sourceKey = `${relationship.sourceName}::${relationship.sourceNode}`;
    if (!nodeIndex.has(sourceKey)) {
      diagnostics.push({
        code: 'dangling-relationship-endpoint',
        severity: 'error',
        projectionKind: 'relationship',
        projectionId: relationship.projectionId,
        relationshipType: relationship.relationshipType,
        message: `relationship projection ${relationship.projectionId} has dangling sourceNode ${relationship.sourceNode}`,
      });
    }

    const targetKey = `${relationship.sourceName}::${relationship.targetNode}`;
    if (!nodeIndex.has(targetKey)) {
      diagnostics.push({
        code: 'dangling-relationship-endpoint',
        severity: 'error',
        projectionKind: 'relationship',
        projectionId: relationship.projectionId,
        relationshipType: relationship.relationshipType,
        message: `relationship projection ${relationship.projectionId} has dangling targetNode ${relationship.targetNode}`,
      });
    }
  }
}

function buildNodeProjectionId(sourceName: string, graphLabel: string, primaryKey: string): string {
  return `${sourceName}||node||${graphLabel}||${primaryKey}`;
}

function buildRelationshipProjectionId(
  sourceName: string,
  relationshipType: string,
  joinFields: readonly string[],
): string {
  const stableJoin = [...joinFields].sort((left, right) => left.localeCompare(right)).join(',');
  return `${sourceName}||relationship||${relationshipType}||${stableJoin}`;
}

function summarizeSeverities(
  diagnostics: readonly VirtualSourceValidationDiagnostic[],
): Record<VirtualSourceValidationSeverity, number> {
  const summary: Record<VirtualSourceValidationSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const diagnostic of diagnostics) {
    summary[diagnostic.severity] += 1;
  }

  return summary;
}

function sortedCountFromArray(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized === '') {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return sortedCountRecord(counts);
}

function sortedCountRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  const entries = [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
  const normalized: Record<string, number> = {};
  for (const [key, count] of entries) {
    normalized[key] = count;
  }
  return normalized;
}

function compareDiagnostic(left: VirtualSourceValidationDiagnostic, right: VirtualSourceValidationDiagnostic): number {
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (bySeverity !== 0) {
    return bySeverity;
  }
  const byCode = left.code.localeCompare(right.code);
  if (byCode !== 0) {
    return byCode;
  }
  const byProjection = (left.projectionId ?? '').localeCompare(right.projectionId ?? '');
  if (byProjection !== 0) {
    return byProjection;
  }
  return left.message.localeCompare(right.message);
}

function compareNodeProjection(left: VirtualNodeProjection, right: VirtualNodeProjection): number {
  const bySource = left.sourceName.localeCompare(right.sourceName);
  if (bySource !== 0) {
    return bySource;
  }
  const byLabel = left.graphLabel.localeCompare(right.graphLabel);
  if (byLabel !== 0) {
    return byLabel;
  }
  return left.primaryKey.localeCompare(right.primaryKey);
}

function compareRelationshipProjection(
  left: VirtualRelationshipProjection,
  right: VirtualRelationshipProjection,
): number {
  const bySource = left.sourceName.localeCompare(right.sourceName);
  if (bySource !== 0) {
    return bySource;
  }
  const byType = left.relationshipType.localeCompare(right.relationshipType);
  if (byType !== 0) {
    return byType;
  }
  return left.projectionId.localeCompare(right.projectionId);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSourceKind(raw: string): string {
  return normalizeText(raw).toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: readonly unknown[] | unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
