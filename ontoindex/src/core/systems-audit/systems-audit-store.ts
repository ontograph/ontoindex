import {
  assertFreshSystemsAuditRecord,
  createSystemsAuditRecord,
  decideSystemsAuditRecordFreshness,
  type SystemsAuditCurrentSnapshot,
  type SystemsAuditRecord,
  type SystemsAuditRecordInput,
} from './systems-audit-contracts.js';

export interface SystemsAuditStoreState {
  records: SystemsAuditRecord[];
}

export function createEmptySystemsAuditStoreState(): SystemsAuditStoreState {
  return { records: [] };
}

export function upsertSystemsAuditRecord(
  state: SystemsAuditStoreState,
  input: SystemsAuditRecordInput,
): SystemsAuditRecord {
  const record = createSystemsAuditRecord(input);
  const key = createSystemsAuditRecordKey(record);
  state.records = state.records.filter((existing) => createSystemsAuditRecordKey(existing) !== key);
  state.records.push(record);
  return record;
}

export function createSystemsAuditRecordKey(
  record: Pick<SystemsAuditRecord, 'sourceIndexId' | 'analyzerId' | 'analyzerVersion' | 'filePath'>,
): string {
  return [record.sourceIndexId, record.analyzerId, record.analyzerVersion, record.filePath]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

export function selectFreshSystemsAuditRecords(
  records: readonly SystemsAuditRecord[],
  snapshot: SystemsAuditCurrentSnapshot,
): SystemsAuditRecord[] {
  return records.filter((record) => decideSystemsAuditRecordFreshness(record, snapshot).usable);
}

export function requireFreshSystemsAuditRecords(
  records: readonly SystemsAuditRecord[],
  snapshot: SystemsAuditCurrentSnapshot,
): SystemsAuditRecord[] {
  return records.map((record) => assertFreshSystemsAuditRecord(record, snapshot));
}
