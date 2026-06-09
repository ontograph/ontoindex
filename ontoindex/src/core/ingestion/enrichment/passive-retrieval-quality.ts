export type PassiveRetrievalQualityScope = 'default' | 'opt-in-passive';

export interface PassiveRetrievalQualityCase {
  name: string;
  topK: number;
  expectedResultIds: readonly string[];
  actualResultIds: readonly string[];
  expectedCitations?: readonly PassiveRetrievalCitation[];
  actualCitations?: readonly PassiveRetrievalCitation[];
  expectedIntermediateEvidenceIds?: readonly string[];
  actualIntermediateEvidenceIds?: readonly string[];
}

export interface PassiveRetrievalCitation {
  resultId: string;
  docPath: string;
  headingPath: readonly string[];
  lineSpan: { start: number; end: number };
  contentHash: string;
}

export interface PassiveRetrievalQualityFixture {
  name: string;
  defaultCases: readonly PassiveRetrievalQualityCase[];
  optInPassiveCases: readonly PassiveRetrievalQualityCase[];
}

export interface PassiveRetrievalQualityCaseResult {
  name: string;
  topK: number;
  expectedResultIds: readonly string[];
  actualTopKResultIds: readonly string[];
  hitResultIds: readonly string[];
  missingResultIds: readonly string[];
  hitCitations: readonly PassiveRetrievalCitation[];
  missingCitations: readonly PassiveRetrievalCitation[];
  citationHitRate: number;
  hitIntermediateEvidenceIds: readonly string[];
  missingIntermediateEvidenceIds: readonly string[];
  recall: number;
  passed: boolean;
}

export interface PassiveRetrievalQualityScopeResult {
  scope: PassiveRetrievalQualityScope;
  caseCount: number;
  passedCaseCount: number;
  recallAtK: number;
  cases: PassiveRetrievalQualityCaseResult[];
}

export interface PassiveRetrievalQualityResult {
  fixtureName: string;
  defaultRetrieval: PassiveRetrievalQualityScopeResult;
  optInPassiveRetrieval: PassiveRetrievalQualityScopeResult;
  passed: boolean;
}

export function evaluatePassiveRetrievalQuality(
  fixture: PassiveRetrievalQualityFixture,
): PassiveRetrievalQualityResult {
  const defaultRetrieval = evaluateScope('default', fixture.defaultCases);
  const optInPassiveRetrieval = evaluateScope('opt-in-passive', fixture.optInPassiveCases);

  return {
    fixtureName: fixture.name,
    defaultRetrieval,
    optInPassiveRetrieval,
    passed:
      defaultRetrieval.passedCaseCount === defaultRetrieval.caseCount &&
      optInPassiveRetrieval.passedCaseCount === optInPassiveRetrieval.caseCount,
  };
}

function evaluateScope(
  scope: PassiveRetrievalQualityScope,
  cases: readonly PassiveRetrievalQualityCase[],
): PassiveRetrievalQualityScopeResult {
  const results = cases.map(evaluateCase);
  const recallAtK =
    results.length === 0
      ? 1
      : results.reduce((sum, result) => sum + result.recall, 0) / results.length;

  return {
    scope,
    caseCount: results.length,
    passedCaseCount: results.filter((result) => result.passed).length,
    recallAtK,
    cases: results,
  };
}

function evaluateCase(testCase: PassiveRetrievalQualityCase): PassiveRetrievalQualityCaseResult {
  const topK = normalizePositiveInteger(testCase.topK, 'topK');
  const actualTopKResultIds = unique(testCase.actualResultIds).slice(0, topK);
  const actualTopKSet = new Set(actualTopKResultIds);
  const expectedResultIds = unique(testCase.expectedResultIds);
  const hitResultIds = expectedResultIds.filter((id) => actualTopKSet.has(id));
  const missingResultIds = expectedResultIds.filter((id) => !actualTopKSet.has(id));
  const recall =
    expectedResultIds.length === 0 ? 1 : hitResultIds.length / expectedResultIds.length;
  const expectedCitations = uniqueCitations(testCase.expectedCitations ?? []);
  const actualCitationKeys = new Set(
    uniqueCitations(testCase.actualCitations ?? []).map(citationKey),
  );
  const hitCitations = expectedCitations.filter((citation) =>
    actualCitationKeys.has(citationKey(citation)),
  );
  const missingCitations = expectedCitations.filter(
    (citation) => !actualCitationKeys.has(citationKey(citation)),
  );
  const citationHitRate =
    expectedCitations.length === 0 ? 1 : hitCitations.length / expectedCitations.length;
  const expectedIntermediateEvidenceIds = unique(testCase.expectedIntermediateEvidenceIds ?? []);
  const actualIntermediateEvidenceIds = new Set(
    unique(testCase.actualIntermediateEvidenceIds ?? []),
  );
  const hitIntermediateEvidenceIds = expectedIntermediateEvidenceIds.filter((id) =>
    actualIntermediateEvidenceIds.has(id),
  );
  const missingIntermediateEvidenceIds = expectedIntermediateEvidenceIds.filter(
    (id) => !actualIntermediateEvidenceIds.has(id),
  );

  return {
    name: testCase.name,
    topK,
    expectedResultIds,
    actualTopKResultIds,
    hitResultIds,
    missingResultIds,
    hitCitations,
    missingCitations,
    citationHitRate,
    hitIntermediateEvidenceIds,
    missingIntermediateEvidenceIds,
    recall,
    passed:
      missingResultIds.length === 0 &&
      missingCitations.length === 0 &&
      missingIntermediateEvidenceIds.length === 0,
  };
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function uniqueCitations(values: readonly PassiveRetrievalCitation[]): PassiveRetrievalCitation[] {
  const seen = new Set<string>();
  const result: PassiveRetrievalCitation[] = [];
  for (const value of values) {
    const key = citationKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function citationKey(citation: PassiveRetrievalCitation): string {
  return [
    citation.resultId,
    citation.docPath,
    citation.headingPath.join('/'),
    citation.lineSpan.start,
    citation.lineSpan.end,
    citation.contentHash,
  ].join('\0');
}
