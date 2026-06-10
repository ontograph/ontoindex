export type ExtractionScalarType = 'string' | 'number' | 'boolean' | 'object';

export interface ExtractionSlotSchema {
  name: string;
  range: ExtractionScalarType | string;
  required?: boolean;
  repeated?: boolean;
  enum?: readonly unknown[];
  sensitive?: boolean;
}

export interface ExtractionClassSchema {
  name: string;
  slots: readonly ExtractionSlotSchema[];
}

export interface ExtractionSchemaDocument {
  id: string;
  version: string;
  rootClass: string;
  classes: readonly ExtractionClassSchema[];
}

export interface ExtractionCandidate {
  id: string;
  className: string;
  fields: Record<string, unknown>;
  sourceSpan?: unknown;
  confidence?: unknown;
  metadata?: unknown;
}

export interface ExtractionBundleInput {
  schema: ExtractionSchemaDocument;
  candidates: readonly unknown[];
  maxCandidates?: unknown;
  maxIssues?: unknown;
}

export interface ExtractionValidationIssue {
  candidateId: string;
  path: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ExtractionBundleReportCounts {
  candidatesInInput: number;
  normalizedCandidatesInInput: number;
  issues: number;
  errors: number;
  warnings: number;
}

export interface ExtractionBundleTruncation {
  candidatesOmitted: number;
  issuesOmitted: number;
}

export interface ExtractionRedactionManifest {
  sensitivePaths: readonly string[];
}

export interface ExtractionBundleReport {
  schemaId: string;
  schemaVersion: string;
  rootClass: string;
  normalizedCandidates: readonly ExtractionCandidate[];
  issues: readonly ExtractionValidationIssue[];
  counts: ExtractionBundleReportCounts;
  redactionManifest: ExtractionRedactionManifest;
  truncation: ExtractionBundleTruncation;
}

interface InternalExtractionSlotSchema extends Omit<ExtractionSlotSchema, 'required' | 'repeated' | 'sensitive'> {
  required: boolean;
  repeated: boolean;
  sensitive: boolean;
}

interface InternalExtractionClassSchema {
  name: string;
  slots: readonly InternalExtractionSlotSchema[];
  slotByName: Map<string, InternalExtractionSlotSchema>;
}

interface InternalExtractionSchema {
  id: string;
  version: string;
  rootClass: string;
  classesByName: Map<string, InternalExtractionClassSchema>;
}

const SCALAR_TYPES = new Set<ExtractionScalarType>(['string', 'number', 'boolean', 'object']);

const ISSUE_SEVERITY_RANK: Record<ExtractionValidationIssue['severity'], number> = {
  error: 0,
  warning: 1,
};

export function buildSchemaGuidedExtractionReport(
  input: ExtractionBundleInput,
): ExtractionBundleReport {
  const schema = normalizeSchema(input.schema);
  const candidatesInput = Array.isArray(input.candidates) ? input.candidates : [];
  const maxCandidates = resolveLimit(input.maxCandidates);
  const maxIssues = resolveLimit(input.maxIssues);

  const issues: ExtractionValidationIssue[] = [];
  const redactionPaths = new Set<string>();
  const normalizedCandidates: ExtractionCandidate[] = [];

  for (let index = 0; index < candidatesInput.length; index++) {
    const rawCandidate = candidatesInput[index];
    const defaultCandidateId = `candidate-${index}`;

    const candidate = normalizeCandidate(rawCandidate, defaultCandidateId, schema, issues);
    if (!candidate) {
      continue;
    }

    normalizedCandidates.push(candidate);
    const classSchema = schema.classesByName.get(candidate.className)!;
    const candidatePath = `candidate[${candidate.id}]`;
    validateCandidateFields(
      candidate.fields,
      classSchema,
      schema.classesByName,
      candidate.id,
      issues,
      redactionPaths,
      candidatePath,
    );
  }

  const normalizedCandidatesSorted = [...normalizedCandidates].sort((left, right) => {
    const byClass = left.className.localeCompare(right.className);
    if (byClass !== 0) {
      return byClass;
    }
    return left.id.localeCompare(right.id);
  });

  const issuesSorted = [...issues].sort((left, right) => {
    const bySeverity = ISSUE_SEVERITY_RANK[left.severity] - ISSUE_SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const byCandidate = left.candidateId.localeCompare(right.candidateId);
    if (byCandidate !== 0) {
      return byCandidate;
    }
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) {
      return byPath;
    }
    const byCode = left.code.localeCompare(right.code);
    if (byCode !== 0) {
      return byCode;
    }
    return left.message.localeCompare(right.message);
  });

  const emittedCandidates =
    maxCandidates === undefined ? normalizedCandidatesSorted : normalizedCandidatesSorted.slice(0, maxCandidates);
  const emittedIssues = maxIssues === undefined ? issuesSorted : issuesSorted.slice(0, maxIssues);

  const counts = issues.reduce(
    (acc, issue) => {
      acc.issues += 1;
      if (issue.severity === 'error') {
        acc.errors += 1;
      } else {
        acc.warnings += 1;
      }
      return acc;
    },
    { issues: 0, errors: 0, warnings: 0 },
  );

  return {
    schemaId: schema.id,
    schemaVersion: schema.version,
    rootClass: schema.rootClass,
    normalizedCandidates: emittedCandidates,
    issues: emittedIssues,
    counts: {
      candidatesInInput: candidatesInput.length,
      normalizedCandidatesInInput: normalizedCandidatesSorted.length,
      issues: counts.issues,
      errors: counts.errors,
      warnings: counts.warnings,
    },
    redactionManifest: {
      sensitivePaths: [...redactionPaths].sort((left, right) => left.localeCompare(right)),
    },
    truncation: {
      candidatesOmitted: normalizedCandidatesSorted.length - emittedCandidates.length,
      issuesOmitted: issuesSorted.length - emittedIssues.length,
    },
  };
}

function normalizeSchema(rawSchema: unknown): InternalExtractionSchema {
  if (!isRecord(rawSchema)) {
    throw new Error('schema must be an object');
  }

  const schemaRecord = rawSchema as Record<string, unknown>;
  const id = requiredString(schemaRecord.id, 'schema.id');
  const version = requiredString(schemaRecord.version, 'schema.version');
  const rootClass = requiredString(schemaRecord.rootClass, 'schema.rootClass');
  const classes = requiredList(schemaRecord.classes, 'schema.classes');

  const classesByName = new Map<string, InternalExtractionClassSchema>();

  for (const rawClass of classes) {
    if (!isRecord(rawClass)) {
      throw new Error('schema class entry must be an object');
    }

    const classRecord = rawClass as Record<string, unknown>;
    const className = requiredString(classRecord.name, 'schema class name');
    if (classesByName.has(className)) {
      throw new Error(`schema class name must be unique: ${className}`);
    }

    const slots = requiredList(classRecord.slots, `schema class ${className} slots`);
    const slotByName = new Map<string, InternalExtractionSlotSchema>();
    const normalizedSlots: InternalExtractionSlotSchema[] = [];

    for (const rawSlot of slots) {
      if (!isRecord(rawSlot)) {
        throw new Error(`schema class ${className} slot must be an object`);
      }

      const slotRecord = rawSlot as Record<string, unknown>;
      const slotName = requiredString(slotRecord.name, `schema class ${className} slot name`);
      if (slotByName.has(slotName)) {
        throw new Error(`schema class ${className} has duplicate slot name: ${slotName}`);
      }
      if (slotRecord.enum !== undefined && !Array.isArray(slotRecord.enum)) {
        throw new Error(`schema class ${className} slot ${slotName} enum must be an array`);
      }

      const range = requiredString(slotRecord.range, `schema class ${className} slot ${slotName} range`);
      const slot: InternalExtractionSlotSchema = {
        name: slotName,
        range,
        required: slotRecord.required === true,
        repeated: slotRecord.repeated === true,
        enum: Array.isArray(slotRecord.enum) ? slotRecord.enum : undefined,
        sensitive: slotRecord.sensitive === true,
      };

      slotByName.set(slotName, slot);
      normalizedSlots.push(slot);
    }

    classesByName.set(className, {
      name: className,
      slots: normalizedSlots,
      slotByName,
    });
  }

  if (!classesByName.has(rootClass)) {
    throw new Error(`schema root class ${rootClass} must exist in classes`);
  }

  for (const classSchema of classesByName.values()) {
    for (const slot of classSchema.slots) {
      if (!SCALAR_TYPES.has(slot.range as ExtractionScalarType) && !classesByName.has(slot.range)) {
        throw new Error(
          `schema slot ${classSchema.name}.${slot.name} has unknown range: ${slot.range}`,
        );
      }
    }
  }

  return { id, version, rootClass, classesByName };
}

function normalizeCandidate(
  rawCandidate: unknown,
  defaultCandidateId: string,
  schema: InternalExtractionSchema,
  issues: ExtractionValidationIssue[],
): ExtractionCandidate | undefined {
  if (!isRecord(rawCandidate)) {
    issues.push({
      candidateId: defaultCandidateId,
      path: '',
      code: 'candidate-invalid',
      severity: 'error',
      message: 'candidate must be an object',
    });
    return undefined;
  }

  const candidateRecord = rawCandidate as Record<string, unknown>;
  const rawId = candidateRecord.id;
  const rawClassName = candidateRecord.className;
  const trimmedId = typeof rawId === 'string' ? rawId.trim() : '';
  const trimmedClassName = typeof rawClassName === 'string' ? rawClassName.trim() : '';
  const candidateId = trimmedId || defaultCandidateId;

  if (!trimmedId) {
    issues.push({
      candidateId,
      path: '',
      code: 'candidate-id-empty',
      severity: 'warning',
      message: 'candidate id should be a non-empty string',
    });
  }
  if (!trimmedClassName) {
    issues.push({
      candidateId,
      path: '',
      code: 'candidate-class-empty',
      severity: 'error',
      message: 'candidate class must be a non-empty string',
    });
    return undefined;
  }

  const classSchema = schema.classesByName.get(trimmedClassName);
  if (!classSchema) {
    issues.push({
      candidateId,
      path: '',
      code: 'candidate-class-unknown',
      severity: 'error',
      message: `unknown candidate class: ${trimmedClassName}`,
    });
    return undefined;
  }

  const fieldsValue = candidateRecord.fields;
  const fields =
    isRecord(fieldsValue) ? { ...fieldsValue } : fieldsValue === undefined ? {} : {};
  if (fieldsValue !== undefined && !isRecord(fieldsValue)) {
    issues.push({
      candidateId,
      path: '',
      code: 'candidate-fields-not-object',
      severity: 'error',
      message: 'candidate fields must be an object when provided',
    });
  }

  const candidate: ExtractionCandidate = {
    id: candidateId,
    className: trimmedClassName,
    fields,
  };

  if (Object.prototype.hasOwnProperty.call(candidateRecord, 'sourceSpan')) {
    candidate.sourceSpan = candidateRecord.sourceSpan;
  }
  if (Object.prototype.hasOwnProperty.call(candidateRecord, 'confidence')) {
    candidate.confidence = candidateRecord.confidence;
  }
  if (Object.prototype.hasOwnProperty.call(candidateRecord, 'metadata')) {
    candidate.metadata = candidateRecord.metadata;
  }

  return candidate;
}

function validateCandidateFields(
  fields: Record<string, unknown>,
  classSchema: InternalExtractionClassSchema,
  classesByName: Map<string, InternalExtractionClassSchema>,
  candidateId: string,
  issues: ExtractionValidationIssue[],
  redactionPaths: Set<string>,
  candidatePath: string,
): void {
  const knownFieldNames = new Set(classSchema.slotByName.keys());
  const providedFieldNames = Object.keys(fields);

  for (const slot of classSchema.slots) {
    const slotPath = `${candidatePath}.${slot.name}`;

    if (!Object.prototype.hasOwnProperty.call(fields, slot.name)) {
      if (slot.required) {
        issues.push({
          candidateId,
          path: slotPath,
          code: 'field-required',
          severity: 'error',
          message: `required field '${slot.name}' is missing`,
        });
      }
      continue;
    }

    const value = fields[slot.name];
    validateField(
      value,
      slot,
      slotPath,
      candidateId,
      issues,
      redactionPaths,
      classesByName,
    );
  }

  const unknownFields = providedFieldNames.filter((field) => !knownFieldNames.has(field)).sort();
  for (const fieldName of unknownFields) {
    issues.push({
      candidateId,
      path: `${candidatePath}.${fieldName}`,
      code: 'field-unknown',
      severity: 'warning',
      message: `unknown field '${fieldName}' for class '${classSchema.name}'`,
    });
  }
}

function validateField(
  value: unknown,
  slot: InternalExtractionSlotSchema,
  path: string,
  candidateId: string,
  issues: ExtractionValidationIssue[],
  redactionPaths: Set<string>,
  classesByName: Map<string, InternalExtractionClassSchema>,
): void {
  const rangeIsScalar = SCALAR_TYPES.has(slot.range as ExtractionScalarType);
  const values = slot.repeated ? toArray(value) : [value];
  const rawArray = value;

  if (slot.sensitive) {
    if (slot.repeated && Array.isArray(rawArray)) {
      for (let index = 0; index < rawArray.length; index++) {
        redactionPaths.add(`${path}[${index}]`);
      }
    } else {
      redactionPaths.add(path);
    }
  }

  if (slot.repeated && !Array.isArray(value)) {
    issues.push({
      candidateId,
      path,
      code: 'field-repeated-non-array',
      severity: 'error',
      message: `field '${slot.name}' must be an array`,
    });
    return;
  }

  for (let index = 0; index < values.length; index++) {
    const entry = values[index];
    const entryPath = slot.repeated ? `${path}[${index}]` : path;
    if (entry === undefined) {
      if (slot.required) {
        issues.push({
          candidateId,
          path: entryPath,
          code: 'field-required',
          severity: 'error',
          message: `required field '${slot.name}' is empty`,
        });
      }
      continue;
    }

    if (rangeIsScalar) {
      validateScalar(entry, slot, entryPath, candidateId, issues);
      continue;
    }

    if (!isRecord(entry)) {
      issues.push({
        candidateId,
        path: entryPath,
        code: 'field-object-expected',
        severity: 'error',
        message: `field '${slot.name}' must be an object`,
      });
      continue;
    }

    const nestedClassSchema = classesByName.get(slot.range);
    if (!nestedClassSchema) {
      issues.push({
        candidateId,
        path: entryPath,
        code: 'field-unknown-range',
        severity: 'error',
        message: `field '${slot.name}' has unknown object range '${slot.range}'`,
      });
      continue;
    }

    validateCandidateFields(
      entry as Record<string, unknown>,
      nestedClassSchema,
      classesByName,
      candidateId,
      issues,
      redactionPaths,
      entryPath,
    );
  }
}

function validateScalar(
  value: unknown,
  slot: InternalExtractionSlotSchema,
  path: string,
  candidateId: string,
  issues: ExtractionValidationIssue[],
): void {
  const scalarType = slot.range as ExtractionScalarType;
  if (!isScalarTypeMatch(value, scalarType)) {
    issues.push({
      candidateId,
      path,
      code: 'field-type-mismatch',
      severity: 'error',
      message: `field '${path}' expects ${scalarType}`,
    });
    return;
  }

  if (slot.enum !== undefined && !slot.enum.includes(value)) {
    issues.push({
      candidateId,
      path,
      code: 'field-enum-mismatch',
      severity: 'error',
      message: `field '${path}' has value outside enum`,
    });
  }
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isScalarTypeMatch(value: unknown, scalarType: ExtractionScalarType): boolean {
  if (scalarType === 'string') {
    return typeof value === 'string';
  }
  if (scalarType === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (scalarType === 'boolean') {
    return typeof value === 'boolean';
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredList(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function resolveLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    throw new Error('limits must be finite non-negative integers');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
