import type { AuditImplementationBundle } from './audit-bundle.js';

export type AuditScopeGuardIssueKind =
  | 'unexpected-file'
  | 'unexpected-symbol'
  | 'missing-required-test'
  | 'cross-bundle-edit';

export interface AuditScopeGuardIssue {
  kind: AuditScopeGuardIssueKind;
  value: string;
  message: string;
  bundleIds?: string[];
}

export interface AuditScopeGuardInput {
  bundle: AuditImplementationBundle;
  allBundles?: readonly AuditImplementationBundle[];
  changedFiles?: readonly string[];
  changedSymbols?: readonly string[];
  executedTests?: readonly string[];
  requiredTests?: readonly string[];
}

export interface AuditScopeGuardResult {
  status: 'PASS' | 'FAIL';
  bundleId: string;
  issues: AuditScopeGuardIssue[];
}

export function evaluateAuditScopeGuard(input: AuditScopeGuardInput): AuditScopeGuardResult {
  const changedFiles = normalizeSet(input.changedFiles ?? []);
  const changedSymbols = normalizeSet(input.changedSymbols ?? []);
  const executedTests = normalizeSet(input.executedTests ?? []);
  const requiredTests = normalizeSet(input.requiredTests ?? input.bundle.tests);
  const allowedFiles = normalizeSet([
    ...input.bundle.files,
    ...input.bundle.writeSet,
    ...input.bundle.tests,
  ]);
  const allowedSymbols = normalizeSet(input.bundle.symbols);
  const issues: AuditScopeGuardIssue[] = [];

  for (const file of changedFiles) {
    if (!allowedFiles.has(file)) {
      issues.push({
        kind: 'unexpected-file',
        value: file,
        message: `Changed file is outside bundle scope: ${file}`,
      });
    }
  }

  for (const symbol of changedSymbols) {
    if (!allowedSymbols.has(symbol)) {
      issues.push({
        kind: 'unexpected-symbol',
        value: symbol,
        message: `Changed symbol is outside bundle scope: ${symbol}`,
      });
    }
  }

  for (const test of requiredTests) {
    if (!executedTests.has(test)) {
      issues.push({
        kind: 'missing-required-test',
        value: test,
        message: `Required test was not executed: ${test}`,
      });
    }
  }

  issues.push(
    ...detectCrossBundleEdits(input.bundle, input.allBundles ?? [], changedFiles, changedSymbols),
  );

  return {
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    bundleId: input.bundle.id,
    issues: issues.sort((left, right) =>
      `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`),
    ),
  };
}

function detectCrossBundleEdits(
  bundle: AuditImplementationBundle,
  allBundles: readonly AuditImplementationBundle[],
  changedFiles: ReadonlySet<string>,
  changedSymbols: ReadonlySet<string>,
): AuditScopeGuardIssue[] {
  const issues: AuditScopeGuardIssue[] = [];
  for (const other of allBundles) {
    if (other.id === bundle.id) {
      continue;
    }
    const otherFiles = normalizeSet([...other.files, ...other.writeSet, ...other.tests]);
    const otherSymbols = normalizeSet(other.symbols);
    for (const file of changedFiles) {
      if (otherFiles.has(file)) {
        issues.push({
          kind: 'cross-bundle-edit',
          value: file,
          bundleIds: [bundle.id, other.id].sort(),
          message: `Changed file overlaps another bundle: ${file}`,
        });
      }
    }
    for (const symbol of changedSymbols) {
      if (otherSymbols.has(symbol)) {
        issues.push({
          kind: 'cross-bundle-edit',
          value: symbol,
          bundleIds: [bundle.id, other.id].sort(),
          message: `Changed symbol overlaps another bundle: ${symbol}`,
        });
      }
    }
  }
  return issues;
}

function normalizeSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}
