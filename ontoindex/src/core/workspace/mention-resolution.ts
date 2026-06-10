export type MentionResolutionKind =
  | 'symbol'
  | 'file'
  | 'process'
  | 'diagnostic'
  | 'adr'
  | 'retrieval-result'
  | 'note';

export interface MentionResolutionCandidate {
  kind: string;
  id: string;
  name?: string;
  path?: string;
  confidence?: number;
}

export interface MentionResolutionRequest {
  mentions: readonly string[];
  candidates: readonly MentionResolutionCandidate[];
  maxCandidates?: number;
  maxResults?: number;
}

export type MentionResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved' | 'unsupported' | 'invalid';

export interface MentionResolutionMatch {
  mention: string;
  status: MentionResolutionStatus;
  expectedKind: MentionResolutionKind | string | null;
  query: string;
  candidates: readonly MentionResolutionCandidate[];
}

export type MentionResolutionDiagnosticSeverity = 'error' | 'warning';

export type MentionResolutionDiagnosticCode =
  | 'invalid-mention'
  | 'unsupported-kind'
  | 'unresolved'
  | 'ambiguous'
  | 'truncated-candidates'
  | 'truncated-results';

export interface MentionResolutionDiagnostic {
  code: MentionResolutionDiagnosticCode;
  severity: MentionResolutionDiagnosticSeverity;
  message: string;
  mention: string;
  expectedKind?: string;
  query?: string;
  truncatedBy?: number;
}

export interface MentionResolutionResult {
  matches: readonly MentionResolutionMatch[];
  diagnostics: readonly MentionResolutionDiagnostic[];
  summary: {
    requestedMentions: number;
    consideredMentions: number;
    resolved: number;
    ambiguous: number;
    unresolved: number;
    unsupported: number;
    invalid: number;
    candidateTruncations: number;
    truncatedMentions: number;
  };
}

interface NormalizedCandidate {
  source: MentionResolutionCandidate;
  kind: string;
  stableId: string;
  confidence: number;
}

interface RankedCandidate {
  source: MentionResolutionCandidate;
  kindMatch: number;
  exactMatch: number;
  confidence: number;
  stableId: string;
}

const SUPPORTED_KINDS = new Set<MentionResolutionKind>([
  'symbol',
  'file',
  'process',
  'diagnostic',
  'adr',
  'retrieval-result',
  'note',
]);

const MENTION_PATTERN = /^@([^:]+):(.+)$/;

export function resolveMentions(request: MentionResolutionRequest): MentionResolutionResult {
  const mentions = Array.isArray(request.mentions) ? [...request.mentions] : [];
  const candidates = Array.isArray(request.candidates)
    ? request.candidates.map((candidate, index) => normalizeCandidate(candidate, index))
    : [];
  const requestedMentions = mentions.length;

  const maxCandidates = normalizeLimit(request.maxCandidates, 'maxCandidates');
  const maxResults = normalizeLimit(request.maxResults, 'maxResults');

  const matches: MentionResolutionMatch[] = [];
  const diagnostics: MentionResolutionDiagnostic[] = [];
  let candidateTruncations = 0;
  let truncatedMentions = 0;

  for (let mentionIndex = 0; mentionIndex < mentions.length; mentionIndex++) {
    const mention = String(mentions[mentionIndex]);
    if (maxResults !== undefined && matches.length >= maxResults) {
      truncatedMentions = requestedMentions - mentionIndex;
      diagnostics.push({
        code: 'truncated-results',
        severity: 'warning',
        message: `mention resolution truncated after ${matches.length} matches; ${truncatedMentions} mentions were skipped`,
        mention,
      });
      break;
    }

    const parsed = parseMention(mention);
    if (parsed === null) {
      matches.push({
        mention,
        status: 'invalid',
        expectedKind: null,
        query: '',
        candidates: [],
      });
      diagnostics.push({
        code: 'invalid-mention',
        severity: 'error',
        message: `invalid mention syntax: ${mention}`,
        mention,
      });
      continue;
    }

    const { kind, query } = parsed;
    if (!isMentionResolutionKind(kind)) {
      matches.push({
        mention,
        status: 'unsupported',
        expectedKind: kind,
        query,
        candidates: [],
      });
      diagnostics.push({
        code: 'unsupported-kind',
        severity: 'error',
        message: `unsupported mention kind: ${kind}`,
        mention,
        expectedKind: kind,
        query,
      });
      continue;
    }

    const ranked = rankCandidatesForMention(candidates, kind, query);
    if (maxCandidates !== undefined && ranked.length > maxCandidates) {
      const dropped = ranked.length - maxCandidates;
      candidateTruncations += dropped;
      diagnostics.push({
        code: 'truncated-candidates',
        severity: 'warning',
        message: `mention candidate list truncated from ${ranked.length} to ${maxCandidates}`,
        mention,
        expectedKind: kind,
        query,
        truncatedBy: dropped,
      });
    }
    const selected = maxCandidates === undefined ? ranked : ranked.slice(0, maxCandidates);

    if (selected.length === 0 || selected[0].kindMatch === 0 || selected[0].exactMatch === 0) {
      matches.push({
        mention,
        status: 'unresolved',
        expectedKind: kind,
        query,
        candidates: [],
      });
      diagnostics.push({
        code: 'unresolved',
        severity: 'error',
        message: `no exact ${kind} match for mention "${query}"`,
        mention,
        expectedKind: kind,
        query,
      });
      continue;
    }

    const [first] = selected;
    const topMatches = selected.filter(
      (candidate) =>
        candidate.kindMatch === first.kindMatch &&
        candidate.exactMatch === first.exactMatch &&
        candidate.confidence === first.confidence,
    );
    const matchedCandidates = topMatches.map((item) => item.source);
    if (matchedCandidates.length === 1) {
      matches.push({
        mention,
        status: 'resolved',
        expectedKind: kind,
        query,
        candidates: matchedCandidates,
      });
      continue;
    }

    matches.push({
      mention,
      status: 'ambiguous',
      expectedKind: kind,
      query,
      candidates: matchedCandidates,
    });
    diagnostics.push({
      code: 'ambiguous',
      severity: 'warning',
      message: `ambiguous ${kind} mention "${query}" with ${matchedCandidates.length} equally ranked candidates`,
      mention,
      expectedKind: kind,
      query,
      truncatedBy: undefined,
    });
  }

  const summary = buildSummary(matches, requestedMentions, candidateTruncations, truncatedMentions);

  return {
    matches,
    diagnostics,
    summary,
  };
}

function rankCandidatesForMention(
  candidates: readonly NormalizedCandidate[],
  kind: string,
  query: string,
): RankedCandidate[] {
  const normalizedQuery = normalizeToken(query);

  const ranked = candidates
    .map((candidate) => {
      const normalizedCandidateKind = normalizeKind(candidate.kind);
      const candidateMatch = getCandidateMatchValue(candidate, kind);
      const exactMatch = normalizeToken(candidateMatch) === normalizedQuery ? 1 : 0;
      const kindMatch = normalizedCandidateKind === kind ? 1 : 0;

      return {
        source: candidate.source,
        kindMatch,
        exactMatch,
        confidence: candidate.confidence,
        stableId: candidate.stableId,
      };
    })
    .sort(compareRankedCandidates);

  return ranked;
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (left.kindMatch !== right.kindMatch) {
    return right.kindMatch - left.kindMatch;
  }
  if (left.exactMatch !== right.exactMatch) {
    return right.exactMatch - left.exactMatch;
  }
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  if (left.stableId !== right.stableId) {
    return left.stableId.localeCompare(right.stableId);
  }
  return 0;
}

function normalizeCandidate(candidate: MentionResolutionCandidate, index: number): NormalizedCandidate {
  return {
    source: {
      kind: candidate.kind,
      id: candidate.id,
      name: candidate.name,
      path: candidate.path,
      confidence: candidate.confidence,
    },
    kind: normalizeKind(candidate.kind),
    stableId: candidate.id?.trim() || `candidate:${index}`,
    confidence: normalizeConfidence(candidate.confidence),
  };
}

function getCandidateMatchValue(candidate: NormalizedCandidate, mentionKind: string): string {
  if (mentionKind === 'file') {
    return candidate.source.path ?? candidate.source.name ?? candidate.source.id ?? '';
  }
  return candidate.source.name ?? candidate.source.id ?? '';
}

function parseMention(mention: string): { kind: string; query: string } | null {
  const match = MENTION_PATTERN.exec(mention);
  if (match === null) {
    return null;
  }

  const parsedKind = normalizeKind(match[1]);
  const query = normalizeToken(match[2]);
  if (!query) {
    return null;
  }
  return { kind: parsedKind, query };
}

function normalizeKind(value: string): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

function isMentionResolutionKind(value: string): value is MentionResolutionKind {
  return SUPPORTED_KINDS.has(value as MentionResolutionKind);
}

function normalizeToken(value: string): string {
  return value.trim();
}

function normalizeLimit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  return 0;
}

function buildSummary(
  matches: readonly MentionResolutionMatch[],
  requestedMentions: number,
  candidateTruncations: number,
  truncatedMentions: number,
): MentionResolutionResult['summary'] {
  const summary = {
    requestedMentions,
    consideredMentions: matches.length,
    resolved: 0,
    ambiguous: 0,
    unresolved: 0,
    unsupported: 0,
    invalid: 0,
    candidateTruncations,
    truncatedMentions,
  };

  for (const match of matches) {
    if (match.status === 'resolved') {
      summary.resolved += 1;
      continue;
    }
    if (match.status === 'ambiguous') {
      summary.ambiguous += 1;
      continue;
    }
    if (match.status === 'unresolved') {
      summary.unresolved += 1;
      continue;
    }
    if (match.status === 'unsupported') {
      summary.unsupported += 1;
      continue;
    }
    summary.invalid += 1;
  }

  return summary;
}
