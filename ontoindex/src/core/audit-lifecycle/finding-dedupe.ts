import type { AuditFinding } from './audit-session.js';

export type DedupeStrategy = 'exact' | 'symbol' | 'root-cause' | 'write-set' | 'test-surface';

export interface RootCause {
  id: string;
  title: string;
  summary?: string;
  files: string[];
  symbols: string[];
  writeSet: string[];
  testSurface: string[];
  findingIds: string[];
}

export interface DedupeGroup {
  id: string;
  strategy: DedupeStrategy;
  key: string;
  findingIds: string[];
  rootCause?: RootCause;
}

export interface FindingDedupeProjection {
  groups: DedupeGroup[];
  findingToGroups: Record<string, string[]>;
}

export function buildFindingDedupeProjection(
  findings: readonly AuditFinding[],
  strategies: readonly DedupeStrategy[] = [
    'exact',
    'symbol',
    'root-cause',
    'write-set',
    'test-surface',
  ],
): FindingDedupeProjection {
  const groups = strategies.flatMap((strategy) => dedupeFindings(findings, strategy));
  const findingToGroups: Record<string, string[]> = {};
  for (const group of groups) {
    for (const findingId of group.findingIds) {
      findingToGroups[findingId] = [...(findingToGroups[findingId] ?? []), group.id].sort();
    }
  }
  return { groups, findingToGroups };
}

export function dedupeFindings(
  findings: readonly AuditFinding[],
  strategy: DedupeStrategy,
): DedupeGroup[] {
  const grouped = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    const key = dedupeKey(finding, strategy);
    if (key === null) {
      continue;
    }
    grouped.set(key, [...(grouped.get(key) ?? []), finding]);
  }

  return [...grouped.entries()]
    .filter(([, groupFindings]) => groupFindings.length > 1 || strategy === 'root-cause')
    .map(([key, groupFindings]) => {
      const findingIds = groupFindings.map((finding) => finding.id).sort();
      const id = `${strategy}:${stableKey(key)}`;
      return {
        id,
        strategy,
        key,
        findingIds,
        ...(strategy === 'root-cause'
          ? { rootCause: buildRootCause(key, groupFindings, findingIds) }
          : {}),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getFindingFiles(finding: AuditFinding): string[] {
  return sortedStrings([
    ...metadataStrings(finding.metadata.files),
    ...metadataStrings(finding.metadata.file),
    ...metadataStrings(finding.metadata.path),
    ...evidenceDataStrings(finding, 'file'),
    ...evidenceDataStrings(finding, 'path'),
  ]);
}

export function getFindingSymbols(finding: AuditFinding): string[] {
  return sortedStrings([
    ...metadataStrings(finding.metadata.symbols),
    ...metadataStrings(finding.metadata.symbol),
    ...evidenceDataStrings(finding, 'symbol'),
  ]);
}

export function getFindingTests(finding: AuditFinding): string[] {
  return sortedStrings([
    ...metadataStrings(finding.metadata.tests),
    ...metadataStrings(finding.metadata.testSurface),
    ...evidenceDataStrings(finding, 'test'),
  ]);
}

export function getFindingWriteSet(finding: AuditFinding): string[] {
  const writeSet = sortedStrings([
    ...metadataStrings(finding.metadata.writeSet),
    ...metadataStrings(finding.metadata.write_set),
  ]);
  return writeSet.length > 0 ? writeSet : getFindingFiles(finding);
}

export function getFindingEstimatedLoc(finding: AuditFinding): number {
  const value = finding.metadata.estimatedLoc ?? finding.metadata.estimatedLOC;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

export function getFindingNonScope(finding: AuditFinding): string[] {
  return sortedStrings([
    ...metadataStrings(finding.metadata.nonScope),
    ...metadataStrings(finding.metadata.non_scope),
  ]);
}

export function getFindingStopConditions(finding: AuditFinding): string[] {
  return sortedStrings([
    ...metadataStrings(finding.metadata.stopConditions),
    ...metadataStrings(finding.metadata.stop_conditions),
  ]);
}

function dedupeKey(finding: AuditFinding, strategy: DedupeStrategy): string | null {
  switch (strategy) {
    case 'exact':
      return finding.fingerprint;
    case 'symbol':
      return keyFromParts(getFindingSymbols(finding));
    case 'root-cause':
      return rootCauseKey(finding);
    case 'write-set':
      return keyFromParts(getFindingWriteSet(finding));
    case 'test-surface':
      return keyFromParts(getFindingTests(finding));
  }
}

function rootCauseKey(finding: AuditFinding): string {
  const explicit = metadataStrings(finding.metadata.rootCauseId)[0];
  if (explicit !== undefined) {
    return explicit;
  }
  return keyFromParts([
    finding.fingerprint,
    ...getFindingSymbols(finding),
    ...getFindingWriteSet(finding),
    ...getFindingTests(finding),
  ]);
}

function buildRootCause(
  key: string,
  findings: readonly AuditFinding[],
  findingIds: string[],
): RootCause {
  const first = [...findings].sort((left, right) => left.id.localeCompare(right.id))[0];
  return {
    id: `root-cause:${stableKey(key)}`,
    title:
      metadataStrings(first?.metadata.rootCauseTitle)[0] ??
      first?.title ??
      `Root cause ${stableKey(key)}`,
    ...(metadataStrings(first?.metadata.rootCauseSummary)[0] !== undefined
      ? { summary: metadataStrings(first?.metadata.rootCauseSummary)[0] }
      : {}),
    files: sortedStrings(findings.flatMap(getFindingFiles)),
    symbols: sortedStrings(findings.flatMap(getFindingSymbols)),
    writeSet: sortedStrings(findings.flatMap(getFindingWriteSet)),
    testSurface: sortedStrings(findings.flatMap(getFindingTests)),
    findingIds,
  };
}

function evidenceDataStrings(finding: AuditFinding, key: string): string[] {
  return finding.evidence.flatMap((evidence) => metadataStrings(evidence.data?.[key]));
}

function metadataStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(metadataStrings);
  }
  return [];
}

function keyFromParts(parts: readonly string[]): string | null {
  const values = sortedStrings(parts);
  return values.length > 0 ? values.join('\0') : null;
}

function sortedStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
