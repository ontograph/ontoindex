export const CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION = 1;

export type AxelEnrichmentFactKind =
  | 'domain-classification'
  | 'semantic-bridge'
  | 'architecture-drift'
  | 'orphan-anchor-suggestion';

export type AxelSubjectType = 'file' | 'symbol' | 'process' | 'cluster' | 'edge' | 'unresolved';

export type AxelBridgeType = 'semantic' | 'tag' | 'usage' | 'architecture';

export type AxelMissingAnchor = 'owner' | 'process' | 'cluster' | 'parent' | 'call-anchor';

export interface AxelReferencedFile {
  filePath: string;
  fileHash: string;
}

export interface AxelResolvedSubject {
  type: Exclude<AxelSubjectType, 'unresolved'>;
  id: string;
  filePath?: string;
}

export interface AxelUnresolvedSubject {
  type: 'unresolved';
  label: string;
  reason: string;
  filePath?: string;
}

export type AxelSubject = AxelResolvedSubject | AxelUnresolvedSubject;

export interface AxelEvidence {
  kind: string;
  description?: string;
  filePath?: string;
  fileHash?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface AxelBaseFact {
  kind: AxelEnrichmentFactKind;
  subject: AxelSubject;
  confidence: number;
  evidence: AxelEvidence[];
  referencedFiles: AxelReferencedFile[];
}

export interface AxelDomainClassificationFact extends AxelBaseFact {
  kind: 'domain-classification';
  domain: string;
}

export interface AxelSemanticBridgeFact extends AxelBaseFact {
  kind: 'semantic-bridge';
  from: AxelSubject;
  to: AxelSubject;
  bridgeType: AxelBridgeType;
}

export interface AxelArchitectureDriftFact extends AxelBaseFact {
  kind: 'architecture-drift';
  expectedDomain?: string;
  observedDomain: string;
  childMix?: Record<string, number>;
}

export interface AxelOrphanAnchorSuggestionFact extends AxelBaseFact {
  kind: 'orphan-anchor-suggestion';
  missing: AxelMissingAnchor;
  suggestedAnchor?: AxelSubject;
}

export type AxelEnrichmentFact =
  | AxelDomainClassificationFact
  | AxelSemanticBridgeFact
  | AxelArchitectureDriftFact
  | AxelOrphanAnchorSuggestionFact;

export interface AxelEnrichmentFactEnvelope {
  analyzerId: string;
  analyzerVersion: string;
  schemaVersion: number;
  sourceIndexId: string;
  sourceCommitHash: string;
  repoId: string;
  facts: AxelEnrichmentFact[];
}

const FACT_KINDS = new Set<AxelEnrichmentFactKind>([
  'domain-classification',
  'semantic-bridge',
  'architecture-drift',
  'orphan-anchor-suggestion',
]);

const SUBJECT_TYPES = new Set<AxelSubjectType>([
  'file',
  'symbol',
  'process',
  'cluster',
  'edge',
  'unresolved',
]);

const BRIDGE_TYPES = new Set<AxelBridgeType>(['semantic', 'tag', 'usage', 'architecture']);

const MISSING_ANCHORS = new Set<AxelMissingAnchor>([
  'owner',
  'process',
  'cluster',
  'parent',
  'call-anchor',
]);

export function normalizeAxelEnrichmentFactEnvelope(input: unknown): AxelEnrichmentFactEnvelope {
  const value = requireRecord(input, 'Axel enrichment fact envelope');
  const schemaVersion = normalizeSchemaVersion(value.schemaVersion);
  if (schemaVersion !== CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION) {
    throw new Error(
      `Axel enrichment fact schemaVersion must be ${CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION}`,
    );
  }

  const facts = value.facts;
  if (!Array.isArray(facts)) {
    throw new Error('Axel enrichment fact envelope requires facts');
  }

  return {
    analyzerId: requireNonEmptyString(value.analyzerId, 'analyzerId'),
    analyzerVersion: requireNonEmptyString(value.analyzerVersion, 'analyzerVersion'),
    schemaVersion,
    sourceIndexId: requireNonEmptyString(value.sourceIndexId, 'sourceIndexId'),
    sourceCommitHash: requireNonEmptyString(value.sourceCommitHash, 'sourceCommitHash'),
    repoId: requireNonEmptyString(value.repoId, 'repoId'),
    facts: facts.map((fact, index) => normalizeAxelEnrichmentFact(fact, `facts[${index}]`)),
  };
}

export function normalizeAxelEnrichmentFact(
  input: unknown,
  fieldName = 'fact',
): AxelEnrichmentFact {
  const value = requireRecord(input, fieldName);
  const kind = requireKnownFactKind(value.kind, `${fieldName}.kind`);
  const base = normalizeBaseFact(value, fieldName, kind);

  switch (kind) {
    case 'domain-classification':
      return {
        ...base,
        kind,
        domain: requireNonEmptyString(value.domain, `${fieldName}.domain`),
      };
    case 'semantic-bridge':
      return {
        ...base,
        kind,
        from: normalizeSubject(value.from, `${fieldName}.from`),
        to: normalizeSubject(value.to, `${fieldName}.to`),
        bridgeType: requireKnownBridgeType(value.bridgeType, `${fieldName}.bridgeType`),
      };
    case 'architecture-drift': {
      const fact: AxelArchitectureDriftFact = {
        ...base,
        kind,
        observedDomain: requireNonEmptyString(value.observedDomain, `${fieldName}.observedDomain`),
      };
      if (value.expectedDomain !== undefined) {
        fact.expectedDomain = requireNonEmptyString(
          value.expectedDomain,
          `${fieldName}.expectedDomain`,
        );
      }
      if (value.childMix !== undefined) {
        fact.childMix = normalizeChildMix(value.childMix, `${fieldName}.childMix`);
      }
      return fact;
    }
    case 'orphan-anchor-suggestion': {
      const fact: AxelOrphanAnchorSuggestionFact = {
        ...base,
        kind,
        missing: requireKnownMissingAnchor(value.missing, `${fieldName}.missing`),
      };
      if (value.suggestedAnchor !== undefined) {
        fact.suggestedAnchor = normalizeSubject(
          value.suggestedAnchor,
          `${fieldName}.suggestedAnchor`,
        );
      }
      return fact;
    }
  }
}

function normalizeBaseFact(
  value: Record<string, unknown>,
  fieldName: string,
  kind: AxelEnrichmentFactKind,
): AxelBaseFact {
  return {
    kind,
    subject: normalizeSubject(value.subject, `${fieldName}.subject`),
    confidence: normalizeConfidence(value.confidence, `${fieldName}.confidence`),
    evidence: normalizeEvidenceList(value.evidence, `${fieldName}.evidence`),
    referencedFiles: normalizeReferencedFiles(
      value.referencedFiles,
      `${fieldName}.referencedFiles`,
    ),
  };
}

function normalizeSubject(input: unknown, fieldName: string): AxelSubject {
  const value = requireRecord(input, fieldName);
  const type = requireKnownSubjectType(value.type, `${fieldName}.type`);
  const filePath =
    value.filePath === undefined
      ? undefined
      : requireNonEmptyString(value.filePath, `${fieldName}.filePath`);

  if (type === 'unresolved') {
    const subject: AxelUnresolvedSubject = {
      type,
      label: requireNonEmptyString(value.label, `${fieldName}.label`),
      reason: requireNonEmptyString(value.reason, `${fieldName}.reason`),
    };
    if (filePath !== undefined) {
      subject.filePath = filePath;
    }
    return subject;
  }

  if (value.label !== undefined || value.reason !== undefined) {
    throw new Error(`${fieldName} unresolved label/reason requires type unresolved`);
  }

  const subject: AxelResolvedSubject = {
    type,
    id: requireNonEmptyString(value.id, `${fieldName}.id`),
  };
  if (filePath !== undefined) {
    subject.filePath = filePath;
  }
  return subject;
}

function normalizeReferencedFiles(input: unknown, fieldName: string): AxelReferencedFile[] {
  if (!Array.isArray(input)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return input.map((item, index) => {
    const value = requireRecord(item, `${fieldName}[${index}]`);
    return {
      filePath: requireNonEmptyString(value.filePath, `${fieldName}[${index}].filePath`),
      fileHash: requireNonEmptyString(value.fileHash, `${fieldName}[${index}].fileHash`),
    };
  });
}

function normalizeEvidenceList(input: unknown, fieldName: string): AxelEvidence[] {
  if (!Array.isArray(input)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return input.map((item, index) => normalizeEvidence(item, `${fieldName}[${index}]`));
}

function normalizeEvidence(input: unknown, fieldName: string): AxelEvidence {
  const value = requireRecord(input, fieldName);
  const evidence: AxelEvidence = {
    kind: requireNonEmptyString(value.kind, `${fieldName}.kind`),
  };

  if (value.description !== undefined) {
    evidence.description = requireNonEmptyString(value.description, `${fieldName}.description`);
  }
  if (value.filePath !== undefined) {
    evidence.filePath = requireNonEmptyString(value.filePath, `${fieldName}.filePath`);
    evidence.fileHash = requireNonEmptyString(value.fileHash, `${fieldName}.fileHash`);
  } else if (value.fileHash !== undefined) {
    throw new Error(`${fieldName}.fileHash requires filePath`);
  }
  if (value.lineStart !== undefined) {
    evidence.lineStart = normalizeNonNegativeInteger(value.lineStart, `${fieldName}.lineStart`);
  }
  if (value.lineEnd !== undefined) {
    evidence.lineEnd = normalizeNonNegativeInteger(value.lineEnd, `${fieldName}.lineEnd`);
  }

  return evidence;
}

function normalizeChildMix(input: unknown, fieldName: string): Record<string, number> {
  const value = requireRecord(input, fieldName);
  const childMix: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw new Error(`${fieldName} keys must be non-empty strings`);
    }
    childMix[key] = normalizeFiniteNumber(count, `${fieldName}.${key}`);
  }
  return childMix;
}

function requireRecord(input: unknown, fieldName: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireNonEmptyString(input: unknown, fieldName: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function requireKnownFactKind(input: unknown, fieldName: string): AxelEnrichmentFactKind {
  const value = requireNonEmptyString(input, fieldName);
  if (!FACT_KINDS.has(value as AxelEnrichmentFactKind)) {
    throw new Error(`${fieldName} has unsupported value: ${value}`);
  }
  return value as AxelEnrichmentFactKind;
}

function requireKnownSubjectType(input: unknown, fieldName: string): AxelSubjectType {
  const value = requireNonEmptyString(input, fieldName);
  if (!SUBJECT_TYPES.has(value as AxelSubjectType)) {
    throw new Error(`${fieldName} has unsupported value: ${value}`);
  }
  return value as AxelSubjectType;
}

function requireKnownBridgeType(input: unknown, fieldName: string): AxelBridgeType {
  const value = requireNonEmptyString(input, fieldName);
  if (!BRIDGE_TYPES.has(value as AxelBridgeType)) {
    throw new Error(`${fieldName} has unsupported value: ${value}`);
  }
  return value as AxelBridgeType;
}

function requireKnownMissingAnchor(input: unknown, fieldName: string): AxelMissingAnchor {
  const value = requireNonEmptyString(input, fieldName);
  if (!MISSING_ANCHORS.has(value as AxelMissingAnchor)) {
    throw new Error(`${fieldName} has unsupported value: ${value}`);
  }
  return value as AxelMissingAnchor;
}

function normalizeSchemaVersion(input: unknown): number {
  if (!Number.isInteger(input) || Number(input) < 0) {
    throw new Error('schemaVersion must be a non-negative integer');
  }
  return input as number;
}

function normalizeConfidence(input: unknown, fieldName: string): number {
  const value = normalizeFiniteNumber(input, fieldName);
  if (value < 0 || value > 1) {
    throw new Error(`${fieldName} must be from 0 to 1`);
  }
  return value;
}

function normalizeNonNegativeInteger(input: unknown, fieldName: string): number {
  if (!Number.isInteger(input) || Number(input) < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return input as number;
}

function normalizeFiniteNumber(input: unknown, fieldName: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return input;
}
