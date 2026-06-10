import {
  decideSystemsAuditRecordFreshness,
  type SystemsAuditCurrentSnapshot,
  type SystemsAuditRecord,
  type SystemsAuditRecordStatus,
} from './systems-audit-contracts.js';

export interface SystemsAuditCoverageInput {
  snapshot: SystemsAuditCurrentSnapshot;
  analyzerDeclarations: readonly SystemsAuditCoverageAnalyzerDeclaration[];
  scopes: readonly SystemsAuditCoverageScope[];
  records: readonly SystemsAuditRecord[];
}

export interface SystemsAuditCoverageAnalyzerDeclaration {
  analyzerId: string;
  sidecarRecordKind?: string;
  available?: boolean;
  requiredGates?: readonly string[];
  completedGates?: readonly string[];
}

export type SystemsAuditCoverageStatus =
  | 'covered'
  | 'partial'
  | 'missing'
  | 'stale'
  | 'unsupported'
  | 'blocked';

export interface SystemsAuditCoverageScope {
  id: string;
  analyzerId: string;
  filePath?: string;
  symbolName?: string;
  resourceKind?: string;
  category?: string;
  required?: boolean;
}

export interface SystemsAuditCoverageResult {
  scopeId: string;
  analyzerId: string;
  required: boolean;
  status: SystemsAuditCoverageStatus;
  matchedRecordIds: readonly string[];
  reason?: string;
}

export type SystemsAuditCoverageGapKind =
  | 'missing-required-scope'
  | 'stale-record'
  | 'partial-record'
  | 'unsupported-analyzer'
  | 'blocked-analyzer-gate';

export interface SystemsAuditCoverageGap {
  scopeId: string;
  analyzerId: string;
  kind: SystemsAuditCoverageGapKind;
  reason: string;
  relatedRecordIds?: readonly string[];
}

export interface SystemsAuditCoverageSummary {
  scopeCount: number;
  requiredScopeCount: number;
  optionalScopeCount: number;
  coveredScopeCount: number;
  partialScopeCount: number;
  missingScopeCount: number;
  staleScopeCount: number;
  unsupportedScopeCount: number;
  blockedScopeCount: number;
  requiredCoverageComplete: boolean;
}

export interface SystemsAuditCoverageManifest {
  snapshot: SystemsAuditCurrentSnapshot;
  scopes: readonly SystemsAuditCoverageResult[];
  gaps: readonly SystemsAuditCoverageGap[];
  summary: SystemsAuditCoverageSummary;
}

interface MatchedRecord {
  record: SystemsAuditRecord;
  index: number;
  freshnessReason: ReturnType<typeof decideSystemsAuditRecordFreshness>;
  reference: string;
}

interface NormalizedScope extends SystemsAuditCoverageScope {
  id: string;
  analyzerId: string;
  required: boolean;
  filePath: string;
  symbolName: string;
  resourceKind: string;
  category: string;
}

export function buildSystemsAuditCoverageManifest(
  input: SystemsAuditCoverageInput,
): SystemsAuditCoverageManifest {
  const declarations = new Map(
    input.analyzerDeclarations.map((declaration) => [declaration.analyzerId, declaration]),
  );
  const normalizedScopes = input.scopes.map(normalizeScope);
  const sortedScopes = [...normalizedScopes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : left.analyzerId.localeCompare(right.analyzerId),
  );

  const scopeResults: SystemsAuditCoverageResult[] = [];
  const gaps: SystemsAuditCoverageGap[] = [];

  for (const scope of sortedScopes) {
    const analyzerDeclaration = declarations.get(scope.analyzerId);

    if (!analyzerDeclaration) {
      const gap = makeUnsupportedManifestGap({
        scopeId: scope.id,
        analyzerId: scope.analyzerId,
        reason: `Analyzer ${scope.analyzerId} is not declared for coverage evaluation.`,
      });
      scopeResults.push({
        scopeId: scope.id,
        analyzerId: scope.analyzerId,
        required: scope.required,
        status: 'unsupported',
        matchedRecordIds: [],
        reason: gap.reason,
      });
      gaps.push(gap);
      continue;
    }

    if (analyzerDeclaration.available === false) {
      const reason = `Analyzer ${scope.analyzerId} is unavailable in this environment.`;
      const gap = makeUnsupportedManifestGap({
        scopeId: scope.id,
        analyzerId: scope.analyzerId,
        reason,
      });
      scopeResults.push({
        scopeId: scope.id,
        analyzerId: scope.analyzerId,
        required: scope.required,
        status: 'unsupported',
        matchedRecordIds: [],
        reason,
      });
      gaps.push(gap);
      continue;
    }

    const completedGateSet = new Set(analyzerDeclaration.completedGates ?? []);
    const missingGates = (analyzerDeclaration.requiredGates ?? []).filter(
      (gate) => !completedGateSet.has(gate),
    );
    if (missingGates.length > 0) {
      const gap = makeBlockedManifestGap({
        scopeId: scope.id,
        analyzerId: scope.analyzerId,
        missingGates,
        completedGates: analyzerDeclaration.completedGates ?? [],
      });
      scopeResults.push({
        scopeId: scope.id,
        analyzerId: scope.analyzerId,
        required: scope.required,
        status: 'blocked',
        matchedRecordIds: [],
        reason: gap.reason,
      });
      gaps.push(gap);
      continue;
    }

    const matchingRecords = input.records
      .map((record, index) => ({
        record,
        index,
        freshnessReason: decideSystemsAuditRecordFreshness(record, input.snapshot),
        reference: makeRecordReference(record, index),
      }))
      .filter((candidate) => matchesScope(scope, candidate.record));

    if (matchingRecords.length === 0) {
      const missingReason = scope.required
        ? `No matching record found for ${scope.id}.`
        : `No matching record found for optional scope ${scope.id}.`;
      const result: SystemsAuditCoverageResult = {
        scopeId: scope.id,
        analyzerId: scope.analyzerId,
        required: scope.required,
        status: 'missing',
        matchedRecordIds: [],
        reason: missingReason,
      };
      scopeResults.push(result);
      if (scope.required) {
        gaps.push(makeMissingRequiredScopeGap(scope.id, scope.analyzerId, missingReason));
      }
      continue;
    }

    const usableMatches = matchingRecords.filter((match) => match.freshnessReason.usable);
    const unusableMatches = matchingRecords.filter((match) => !match.freshnessReason.usable);

    const classification = classifyMatches({
      scopeId: scope.id,
      analyzerId: scope.analyzerId,
      usableMatches,
      unusableMatches,
    });

    scopeResults.push({
      scopeId: scope.id,
      analyzerId: scope.analyzerId,
      required: scope.required,
      status: classification.status,
      matchedRecordIds: classification.recordReferences,
      reason: classification.reason,
    });
    if (classification.gap) {
      gaps.push(classification.gap);
    }
  }

  const summary = summarizeCoverage({
    scopeResults,
    requiredScopeCount: sortedScopes.filter((scope) => scope.required).length,
  });

  return {
    snapshot: { ...input.snapshot },
    scopes: scopeResults,
    gaps,
    summary,
  };
}

function normalizeScope(scope: SystemsAuditCoverageScope): NormalizedScope {
  return {
    ...scope,
    id: scope.id.trim(),
    analyzerId: scope.analyzerId.trim(),
    required: scope.required !== false,
    filePath: scope.filePath?.trim() ?? '',
    symbolName: scope.symbolName?.trim() ?? '',
    resourceKind: scope.resourceKind?.trim() ?? '',
    category: scope.category?.trim() ?? '',
  };
}

function summarizeCoverage(input: {
  scopeResults: readonly SystemsAuditCoverageResult[];
  requiredScopeCount: number;
}): SystemsAuditCoverageSummary {
  let coveredScopeCount = 0;
  let partialScopeCount = 0;
  let missingScopeCount = 0;
  let staleScopeCount = 0;
  let unsupportedScopeCount = 0;
  let blockedScopeCount = 0;

  for (const result of input.scopeResults) {
    if (result.status === 'covered') coveredScopeCount += 1;
    else if (result.status === 'partial') partialScopeCount += 1;
    else if (result.status === 'missing') missingScopeCount += 1;
    else if (result.status === 'stale') staleScopeCount += 1;
    else if (result.status === 'unsupported') unsupportedScopeCount += 1;
    else blockedScopeCount += 1;
  }

  const requiredCoveredCount = input.scopeResults.filter(
    (result) => result.required && result.status === 'covered',
  ).length;

  return {
    scopeCount: input.scopeResults.length,
    requiredScopeCount: input.requiredScopeCount,
    optionalScopeCount: Math.max(0, input.scopeResults.length - input.requiredScopeCount),
    coveredScopeCount,
    partialScopeCount,
    missingScopeCount,
    staleScopeCount,
    unsupportedScopeCount,
    blockedScopeCount,
    requiredCoverageComplete: requiredCoveredCount === input.requiredScopeCount,
  };
}

function classifyMatches(input: {
  scopeId: string;
  analyzerId: string;
  usableMatches: readonly MatchedRecord[];
  unusableMatches: readonly MatchedRecord[];
}): {
  status: SystemsAuditCoverageStatus;
  reason?: string;
  recordReferences: readonly string[];
  gap?: SystemsAuditCoverageGap;
} {
  const usable = [...input.usableMatches].sort((left, right) =>
    left.reference.localeCompare(right.reference),
  );
  if (usable.length > 0) {
    const unsupportedRecord = usable.find((match) => match.record.status === 'unsupported');
    if (unsupportedRecord) {
      const reason = `Analyzer ${input.analyzerId} returned an unsupported record for scope ${input.scopeId}.`;
      return {
        status: 'unsupported',
        reason,
        recordReferences: usable.map((match) => match.reference),
        gap: makeUnsupportedManifestGap({
          scopeId: input.scopeId,
          analyzerId: input.analyzerId,
          reason,
          relatedRecordIds: [unsupportedRecord.reference],
        }),
      };
    }

    const partialRecord = usable.find((match) => isPartialRecordStatus(match.record.status));
    if (partialRecord) {
      const reason =
        `Analyzer ${input.analyzerId} produced ${partialRecord.record.status} coverage for scope ${input.scopeId}.`;
      return {
        status: 'partial',
        reason,
        recordReferences: usable.map((match) => match.reference),
        gap: makePartialRecordGap({
          scopeId: input.scopeId,
          analyzerId: input.analyzerId,
          reason,
          relatedRecordIds: [partialRecord.reference],
        }),
      };
    }

    const failedRecord = usable.find((match) => match.record.status === 'failed');
    if (failedRecord) {
      const reason =
        `Analyzer ${input.analyzerId} produced failed coverage for scope ${input.scopeId}.`;
      return {
        status: 'partial',
        reason,
        recordReferences: usable.map((match) => match.reference),
        gap: makePartialRecordGap({
          scopeId: input.scopeId,
          analyzerId: input.analyzerId,
          reason,
          relatedRecordIds: [failedRecord.reference],
        }),
      };
    }

    return {
      status: 'covered',
      reason: undefined,
      recordReferences: usable.map((match) => match.reference),
    };
  }

  if (input.unusableMatches.length === 0) {
    return {
      status: 'stale',
      reason: `No usable matching record was found for scope ${input.scopeId}.`,
      recordReferences: [],
    };
  }

  const staleMatch = input.unusableMatches.find(
    (match) =>
      match.record.status === 'stale' || match.freshnessReason.reason !== 'status-unusable',
  );
  if (staleMatch) {
    const reason = `Matching record for scope ${input.scopeId} is stale relative to the provided snapshot.`;
    return {
      status: 'stale',
      reason,
      recordReferences: input.unusableMatches.map((match) => match.reference),
      gap: makeStaleRecordGap({
        scopeId: input.scopeId,
        analyzerId: input.analyzerId,
        reason,
        relatedRecordIds: [staleMatch.reference],
      }),
    };
  }

  const unsupportedRecord = input.unusableMatches.find((match) => match.record.status === 'unsupported');
  if (unsupportedRecord) {
    const reason = `Analyzer ${input.analyzerId} returned an unsupported record for scope ${input.scopeId}.`;
    return {
      status: 'unsupported',
      reason,
      recordReferences: input.unusableMatches.map((match) => match.reference),
      gap: makeUnsupportedManifestGap({
        scopeId: input.scopeId,
        analyzerId: input.analyzerId,
        reason,
        relatedRecordIds: [unsupportedRecord.reference],
      }),
    };
  }

  const failedRecord = input.unusableMatches.find(
    (match) =>
      match.record.status === 'failed' ||
      match.record.status === 'partial' ||
      match.record.status === 'unresolved',
  );
  if (failedRecord) {
    const reason = `Analyzer ${input.analyzerId} produced ${failedRecord.record.status} coverage for scope ${input.scopeId}.`;
    return {
      status: 'partial',
      reason,
      recordReferences: input.unusableMatches.map((match) => match.reference),
      gap: makePartialRecordGap({
        scopeId: input.scopeId,
        analyzerId: input.analyzerId,
        reason,
        relatedRecordIds: [failedRecord.reference],
      }),
    };
  }

  return {
    status: 'stale',
    reason: `No usable matching record was found for scope ${input.scopeId}.`,
    recordReferences: input.unusableMatches.map((match) => match.reference),
  };
}

function matchesScope(scope: NormalizedScope, record: SystemsAuditRecord): boolean {
  if (record.analyzerId !== scope.analyzerId) return false;
  if (scope.filePath.length > 0 && record.filePath !== scope.filePath) return false;
  if (scope.category.length > 0 && !matchesFindingCategory(record, scope.category)) return false;
  if (scope.resourceKind.length > 0 && !matchesRecordResourceKind(record, scope.resourceKind)) return false;
  if (scope.symbolName.length > 0 && !matchesRecordSymbolName(record, scope.symbolName)) return false;
  return true;
}

function matchesFindingCategory(record: SystemsAuditRecord, category: string): boolean {
  return record.findings.some((finding) => finding.category === category);
}

function matchesRecordResourceKind(record: SystemsAuditRecord, resourceKind: string): boolean {
  if (extractMetadataString(record, 'resourceKind') === resourceKind) return true;
  return record.records.some((fact) => {
    const candidate = fact as { resourceKind?: unknown };
    return typeof candidate.resourceKind === 'string' && candidate.resourceKind === resourceKind;
  });
}

function matchesRecordSymbolName(record: SystemsAuditRecord, symbolName: string): boolean {
  if (extractMetadataString(record, 'symbolName') === symbolName) return true;
  for (const finding of record.findings) {
    if (extractMetadataString(finding, 'symbolName') === symbolName) return true;
  }
  for (const fact of record.records) {
    if (extractMetadataString(fact, 'symbolName') === symbolName) return true;
  }
  return false;
}

function extractMetadataString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as Record<string, unknown>)[key];
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  return text.trim();
}

function isPartialRecordStatus(status: SystemsAuditRecordStatus): boolean {
  return status === 'partial' || status === 'unresolved';
}

function makeRecordReference(record: SystemsAuditRecord, index: number): string {
  return `${record.analyzerId}:${record.filePath}:${record.sourceIndexId}:${index}`;
}

function makeMissingRequiredScopeGap(
  scopeId: string,
  analyzerId: string,
  reason: string,
): SystemsAuditCoverageGap {
  return {
    scopeId,
    analyzerId,
    kind: 'missing-required-scope',
    reason,
  };
}

function makeStaleRecordGap(input: {
  scopeId: string;
  analyzerId: string;
  reason: string;
  relatedRecordIds: readonly string[];
}): SystemsAuditCoverageGap {
  return {
    scopeId: input.scopeId,
    analyzerId: input.analyzerId,
    kind: 'stale-record',
    reason: input.reason,
    relatedRecordIds: [...input.relatedRecordIds],
  };
}

function makePartialRecordGap(input: {
  scopeId: string;
  analyzerId: string;
  reason: string;
  relatedRecordIds: readonly string[];
}): SystemsAuditCoverageGap {
  return {
    scopeId: input.scopeId,
    analyzerId: input.analyzerId,
    kind: 'partial-record',
    reason: input.reason,
    relatedRecordIds: [...input.relatedRecordIds],
  };
}

function makeUnsupportedManifestGap(input: {
  scopeId: string;
  analyzerId: string;
  reason: string;
  relatedRecordIds?: readonly string[];
}): SystemsAuditCoverageGap {
  return {
    scopeId: input.scopeId,
    analyzerId: input.analyzerId,
    kind: 'unsupported-analyzer',
    reason: input.reason,
    ...(input.relatedRecordIds && input.relatedRecordIds.length > 0
      ? { relatedRecordIds: [...input.relatedRecordIds] }
      : {}),
  };
}

function makeBlockedManifestGap(input: {
  scopeId: string;
  analyzerId: string;
  missingGates: readonly string[];
  completedGates: readonly string[];
}): SystemsAuditCoverageGap {
  return {
    scopeId: input.scopeId,
    analyzerId: input.analyzerId,
    kind: 'blocked-analyzer-gate',
    reason: `Analyzer ${input.analyzerId} has unmet gates: ${input.missingGates.join(', ')}; completed: ${input.completedGates.join(', ')}`,
  };
}
