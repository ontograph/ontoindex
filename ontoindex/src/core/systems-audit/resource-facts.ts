export type SystemsAuditConfidence = number;

export interface SourceLineSpan {
  startLine: number;
  endLine: number;
}

export interface SystemsAuditEvidence {
  kind: 'source-call' | 'source-pattern' | 'derived-state';
  filePath: string;
  lineSpan?: SourceLineSpan;
  snippet?: string;
  message?: string;
}

export type ResourceKind = 'file' | 'pipe' | 'socket' | 'process' | 'pidfd' | 'unknown';

export type ResourceHandleKind = 'fd' | 'pid' | 'pidfd' | 'variable';
export type ResourceOwnershipState = 'owned' | 'borrowed' | 'transferred' | 'unresolved';

export interface ResourceInstance {
  kind: 'systems-audit-resource-instance';
  resourceInstanceId: string;
  resourceKind: ResourceKind;
  processIdentity: string;
  filePath: string;
  lineSpan: SourceLineSpan;
  mechanism: string;
  identity?: {
    descriptor?: string;
    path?: string;
    domain?: string;
  };
  unresolved: string[];
  confidence: SystemsAuditConfidence;
  evidence: SystemsAuditEvidence[];
}

export interface ResourceHandle {
  kind: 'systems-audit-resource-handle';
  handleId: string;
  resourceInstanceId?: string;
  processIdentity: string;
  handleKind: ResourceHandleKind;
  localName: string;
  fdNumber?: number;
  ownership: ResourceOwnershipState;
  closeOnExec: 'yes' | 'no' | 'unknown';
  filePath: string;
  lineSpan: SourceLineSpan;
  unresolved: string[];
  confidence: SystemsAuditConfidence;
  evidence: SystemsAuditEvidence[];
}

export type ResourceEventKind =
  | 'allocate'
  | 'release'
  | 'duplicate'
  | 'set-cloexec'
  | 'fork'
  | 'exec'
  | 'wait'
  | 'inherit'
  | 'pidfd'
  | 'unsupported'
  | 'unresolved';

export interface ResourceEvent {
  kind: 'systems-audit-resource-event';
  eventId: string;
  eventKind: ResourceEventKind;
  mechanism: string;
  processIdentity: string;
  resourceInstanceId?: string;
  handleIds: string[];
  filePath: string;
  lineSpan: SourceLineSpan;
  status: 'complete' | 'partial' | 'unresolved' | 'unsupported';
  unresolved: string[];
  confidence: SystemsAuditConfidence;
  evidence: SystemsAuditEvidence[];
}

export type ResourceFact = ResourceInstance | ResourceHandle | ResourceEvent;

export function createSourceEvidence(input: {
  filePath: string;
  line: number;
  snippet: string;
  message?: string;
}): SystemsAuditEvidence {
  return {
    kind: 'source-call',
    filePath: input.filePath,
    lineSpan: { startLine: input.line, endLine: input.line },
    snippet: input.snippet.trim(),
    message: input.message,
  };
}

export function normalizeConfidence(
  value: number,
  fieldName = 'confidence',
): SystemsAuditConfidence {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${fieldName} must be a finite number from 0 to 1`);
  }
  return value;
}

export function requireNonEmptyString(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}
