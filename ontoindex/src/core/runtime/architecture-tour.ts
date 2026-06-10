import type { EvidenceDiagnosticAuthority, EvidenceDiagnosticRecord } from './evidence-diagnostics.js';
import {
  renderEvidenceDiagnosticGroup,
  renderEvidenceDiagnosticSummaryLine,
  summarizeEvidenceDiagnostics,
} from './evidence-diagnostics.js';

export type ArchitectureTourEvidenceKind =
  | 'graph-node'
  | 'symbol'
  | 'process'
  | 'file'
  | 'diff-review'
  | 'docs-sidecar'
  | 'diagnostic';

export interface ArchitectureTourSubject {
  key: string;
  label: string;
  kind: ArchitectureTourEvidenceKind;
  repoPath?: string;
  filePath?: string;
  symbolName?: string;
  processId?: string;
  nodeId?: string;
}

export interface ArchitectureTourCitation {
  repoPath?: string;
  filePath?: string;
  symbolName?: string;
  processId?: string;
  nodeId?: string;
  diagnosticId?: string;
  excerpt?: string;
  authority?: EvidenceDiagnosticAuthority;
  advisory?: boolean;
}

export interface ArchitectureTourEvidence {
  kind: ArchitectureTourEvidenceKind;
  subject: ArchitectureTourSubject;
  id?: string;
  title: string;
  summary: string;
  citations: readonly ArchitectureTourCitation[];
  authority?: EvidenceDiagnosticAuthority;
  freshness?: string;
  advisory?: boolean;
}

export interface ArchitectureTourInput {
  subject?: ArchitectureTourSubject;
  evidence: readonly ArchitectureTourEvidence[];
  maxSteps?: number;
  maxCitationsPerStep?: number;
}

export interface ArchitectureTourStep {
  id: string;
  title: string;
  summary: string;
  evidenceKind: ArchitectureTourEvidenceKind;
  citations: readonly ArchitectureTourCitation[];
  diagnostics: readonly EvidenceDiagnosticRecord[];
}

export interface ArchitectureTour {
  subject?: ArchitectureTourSubject;
  steps: readonly ArchitectureTourStep[];
  diagnostics: readonly EvidenceDiagnosticRecord[];
  truncated: boolean;
}

export type ArchitectureTourDiagnostic = EvidenceDiagnosticRecord;

type GroupedEvidence = {
  subject: ArchitectureTourSubject;
  items: IndexedEvidence[];
  subjectKey: string;
};

type IndexedEvidence = {
  evidence: ArchitectureTourEvidence;
  citations: ArchitectureTourCitation[];
};

const EVIDENCE_KIND_PRIORITY: Record<ArchitectureTourEvidenceKind, number> = {
  'graph-node': 0,
  symbol: 1,
  process: 2,
  file: 3,
  'diff-review': 4,
  diagnostic: 5,
  'docs-sidecar': 6,
};

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_CITATIONS_PER_STEP = 5;

export function buildArchitectureTour(input: ArchitectureTourInput): ArchitectureTour {
  const maxSteps = coercePositiveInt(input.maxSteps) ?? DEFAULT_MAX_STEPS;
  const maxCitationsPerStep =
    coercePositiveInt(input.maxCitationsPerStep) ?? DEFAULT_MAX_CITATIONS_PER_STEP;
  const diagnostics: EvidenceDiagnosticRecord[] = [];

  const groupedEvidence = new Map<string, GroupedEvidence>();
  for (const evidence of input.evidence) {
    const indexed = indexEvidence(evidence, diagnostics);
    if (!indexed) {
      continue;
    }

    const subjectKey = normalizeSubjectKey(indexed.evidence.subject);
    const existing = groupedEvidence.get(subjectKey);
    if (existing) {
      existing.items.push(indexed);
    } else {
      groupedEvidence.set(subjectKey, {
        subject: indexed.evidence.subject,
        subjectKey,
        items: [indexed],
      });
    }
  }

  const groups = [...groupedEvidence.values()].map((group) => ({
    ...group,
    kindPriority: Math.min(...group.items.map((item) => EVIDENCE_KIND_PRIORITY[item.evidence.kind])),
  }));

  groups.sort((a, b) => {
    if (a.kindPriority !== b.kindPriority) {
      return a.kindPriority - b.kindPriority;
    }
    if (a.subject.kind !== b.subject.kind) {
      return a.subject.kind.localeCompare(b.subject.kind);
    }
    if (a.subject.label !== b.subject.label) {
      return a.subject.label.localeCompare(b.subject.label);
    }
    return a.subjectKey.localeCompare(b.subjectKey);
  });

  const emittedGroups = groups.slice(0, maxSteps);
  const truncatedGroupsCount = groups.length - emittedGroups.length;
  const steps: ArchitectureTourStep[] = [];
  let truncated = false;

  for (const group of emittedGroups) {
    const orderedItems = [...group.items].sort((a, b) => a.evidence.title.localeCompare(b.evidence.title));
    const hasNonDocsEvidence = orderedItems.some((item) => item.evidence.kind !== 'docs-sidecar');
    const groupDiagnostics: EvidenceDiagnosticRecord[] = [];
    if (!hasNonDocsEvidence) {
      for (const item of orderedItems) {
        if (item.evidence.kind === 'docs-sidecar') {
          const diagnostic: EvidenceDiagnosticRecord = {
            category: 'runtime',
            kind: 'degraded',
            source: 'architecture-tour',
            authority: 'advisory',
            subject: group.subject.label,
            reason: `docs-sidecar claim for ${group.subject.label} is advisory without code/graph links`,
            advisory: true,
            degraded: true,
          };
          diagnostics.push(diagnostic);
          groupDiagnostics.push(diagnostic);
        }
      }
    }

    const citations = sortAndDedupeCitations(orderedItems.flatMap((item) => item.citations));
    const omittedCitations = Math.max(0, citations.length - maxCitationsPerStep);
    const visibleCitations = citations.slice(0, maxCitationsPerStep);

    if (omittedCitations > 0) {
      truncated = true;
      diagnostics.push({
        category: 'runtime',
        kind: 'truncated',
        source: 'architecture-tour',
        authority: 'advisory',
        subject: group.subject.label,
        reason: `step citations capped at ${maxCitationsPerStep}; ${omittedCitations} omitted`,
        count: omittedCitations,
        advisory: true,
        degraded: true,
        truncated: true,
      });
    }

    const evidenceKind = lowestPriorityKind(orderedItems.map((item) => item.evidence.kind));
    steps.push({
      id: `step:${normalizeStepId(group.subjectKey)}`,
      title: group.subject.label,
      summary: buildStepSummary(orderedItems),
      evidenceKind,
      citations: visibleCitations,
      diagnostics: groupDiagnostics,
    });
  }

  if (truncatedGroupsCount > 0) {
    truncated = true;
    diagnostics.push({
      category: 'runtime',
      kind: 'truncated',
      source: 'architecture-tour',
      authority: 'advisory',
      subject: 'architecture-tour',
      reason: `steps capped at ${maxSteps}; ${truncatedGroupsCount} omitted`,
      count: truncatedGroupsCount,
      advisory: true,
      degraded: true,
      truncated: true,
    });
  }

  return {
    subject: input.subject,
    steps,
    diagnostics,
    truncated,
  };
}

export function formatArchitectureTourMarkdown(tour: ArchitectureTour): string {
  const lines: string[] = [];

  lines.push('# Architecture Tour');
  lines.push('');

  if (tour.subject) {
    lines.push(`## Subject`);
    lines.push('');
    lines.push(`- label: ${tour.subject.label}`);
    lines.push(`- kind: ${tour.subject.kind}`);
    if (tour.subject.repoPath) lines.push(`- repo: ${tour.subject.repoPath}`);
    if (tour.subject.filePath) lines.push(`- file: ${tour.subject.filePath}`);
    if (tour.subject.symbolName) lines.push(`- symbol: ${tour.subject.symbolName}`);
    if (tour.subject.processId) lines.push(`- process: ${tour.subject.processId}`);
    if (tour.subject.nodeId) lines.push(`- node: ${tour.subject.nodeId}`);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');

  if (tour.steps.length === 0) {
    lines.push('No steps were produced from the supplied tour evidence.');
    lines.push('');
  } else {
    for (const step of tour.steps) {
      lines.push(`### ${step.id} - ${step.title}`);
      lines.push(`- **Kind:** ${step.evidenceKind}`);
      lines.push(
        `- **Summary:** ${step.summary || 'No summary provided.'} ${formatCitationCallout(step.citations)}`,
      );

      const orderedCitations = sortAndDedupeCitations(step.citations);
      lines.push(`- **Citations:**`);
      if (orderedCitations.length === 0) {
        lines.push('  - [missing] no usable citation on step');
      } else {
        for (const citation of orderedCitations) {
          lines.push(`  - ${renderCitation(citation)}`);
        }
      }

      if (step.diagnostics.length > 0) {
        lines.push('');
        lines.push(...renderEvidenceDiagnosticGroup(`Step Diagnostics: ${step.title}`, step.diagnostics));
      }

      lines.push('');
    }
  }

  const renderedDiagnostics = summarizeEvidenceDiagnostics(tour.diagnostics);
  const allDiagnostics = renderedDiagnostics.records;
  if (allDiagnostics.length > 0) {
    lines.push('## Diagnostics');
    lines.push('');
    lines.push(renderEvidenceDiagnosticSummaryLine(renderedDiagnostics.summary));
    lines.push('');
    lines.push(...renderEvidenceDiagnosticGroup('Tour Diagnostics', allDiagnostics));
  }

  return lines.join('\n');
}

function indexEvidence(
  evidence: ArchitectureTourEvidence,
  diagnostics: EvidenceDiagnosticRecord[],
): { evidence: ArchitectureTourEvidence; citations: ArchitectureTourCitation[] } | undefined {
  const normalizedCitations = dedupeCitations(
    evidence.citations
      .filter(isUsableCitation)
      .map((citation) => ({
        ...citation,
        advisory: citation.advisory ?? evidence.advisory,
        authority: citation.authority ?? evidence.authority ?? 'authoritative',
      })),
  );

  if (normalizedCitations.length === 0) {
    diagnostics.push({
      category: 'runtime',
      kind: 'ambiguous',
      source: 'architecture-tour',
      authority: evidence.authority ?? 'advisory',
      subject: evidence.subject.label,
      reason: `architecture tour evidence "${evidence.title}" has no usable citations`,
      advisory: true,
      ambiguous: true,
    });
    return undefined;
  }

  return {
    evidence: {
      ...evidence,
      title: evidence.title.trim(),
      summary: evidence.summary.trim(),
      citations: normalizedCitations,
      authority: evidence.authority ?? 'authoritative',
    },
    citations: normalizedCitations,
  };
}

function isUsableCitation(citation: ArchitectureTourCitation): boolean {
  return (
    hasText(citation.repoPath) ||
    hasText(citation.filePath) ||
    hasText(citation.symbolName) ||
    hasText(citation.processId) ||
    hasText(citation.nodeId) ||
    hasText(citation.diagnosticId)
  );
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function dedupeCitations(
  citations: readonly ArchitectureTourCitation[],
): ArchitectureTourCitation[] {
  const seen = new Set<string>();
  const out: ArchitectureTourCitation[] = [];
  for (const citation of citations) {
    const key = citationDedupKey(citation);
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        ...citation,
        repoPath: citation.repoPath?.trim(),
        filePath: citation.filePath?.trim(),
        symbolName: citation.symbolName?.trim(),
        processId: citation.processId?.trim(),
        nodeId: citation.nodeId?.trim(),
        diagnosticId: citation.diagnosticId?.trim(),
        excerpt: citation.excerpt?.trim(),
      });
    }
  }
  return out;
}

function citationDedupKey(citation: ArchitectureTourCitation): string {
  return [
    citation.repoPath?.trim() ?? '',
    citation.filePath?.trim() ?? '',
    citation.symbolName?.trim() ?? '',
    citation.processId?.trim() ?? '',
    citation.nodeId?.trim() ?? '',
    citation.diagnosticId?.trim() ?? '',
  ].join('|');
}

function sortAndDedupeCitations(
  citations: readonly ArchitectureTourCitation[],
): ArchitectureTourCitation[] {
  return dedupeCitations(
    [...citations].sort((a, b) => {
      const aSort = citationSortKey(a);
      const bSort = citationSortKey(b);
      if (aSort !== bSort) {
        return aSort.localeCompare(bSort);
      }
      return aSort.localeCompare(bSort);
    }),
  );
}

function citationSortKey(citation: ArchitectureTourCitation): string {
  return JSON.stringify({
    repoPath: citation.repoPath ?? '',
    filePath: citation.filePath ?? '',
    symbolName: citation.symbolName ?? '',
    processId: citation.processId ?? '',
    nodeId: citation.nodeId ?? '',
    diagnosticId: citation.diagnosticId ?? '',
  });
}

function buildStepSummary(items: IndexedEvidence[]): string {
  const uniqueSummaries = [...new Set(items.map((item) => item.evidence.summary).filter(Boolean))];
  if (uniqueSummaries.length === 0) {
    return 'No summary provided.';
  }
  return uniqueSummaries.length === 1 ? uniqueSummaries[0]! : `${uniqueSummaries[0]} (+${uniqueSummaries.length - 1} more)`;
}

function lowestPriorityKind(kinds: readonly ArchitectureTourEvidenceKind[]): ArchitectureTourEvidenceKind {
  let best: ArchitectureTourEvidenceKind = kinds[0] ?? 'diagnostic';
  let bestRank = EVIDENCE_KIND_PRIORITY[best];
  for (const kind of kinds) {
    const rank = EVIDENCE_KIND_PRIORITY[kind];
    if (rank < bestRank) {
      bestRank = rank;
      best = kind;
    }
  }
  return best;
}

function normalizeSubjectKey(subject: ArchitectureTourSubject): string {
  return [
    subject.key.trim(),
    subject.repoPath?.trim() ?? '',
    subject.filePath?.trim() ?? '',
    subject.symbolName?.trim() ?? '',
    subject.processId?.trim() ?? '',
    subject.nodeId?.trim() ?? '',
  ]
    .map((value) => value.toLowerCase())
    .join('|');
}

function normalizeStepId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function coercePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function formatCitationCallout(citations: readonly ArchitectureTourCitation[]): string {
  if (citations.length === 0) {
    return '(citations: [missing] unavailable)';
  }

  const labels = citations.map((citation, index) => `[${index + 1}] ${citationLabel(citation)}`);
  return `(citations: ${labels.join(', ')})`;
}

function renderCitation(citation: ArchitectureTourCitation): string {
  const advisorySuffix = citation.advisory === true ? ' [advisory]' : '';
  return `${citationLabel(citation)}${advisorySuffix}`;
}

function citationLabel(citation: ArchitectureTourCitation): string {
  const parts: string[] = [];
  if (citation.repoPath) {
    parts.push(`repo ${citation.repoPath}`);
  }
  if (citation.filePath) {
    parts.push(`file ${citation.filePath}`);
  }
  if (citation.symbolName) {
    parts.push(`symbol ${citation.symbolName}`);
  }
  if (citation.processId) {
    parts.push(`process ${citation.processId}`);
  }
  if (citation.nodeId) {
    parts.push(`node ${citation.nodeId}`);
  }
  if (citation.diagnosticId) {
    parts.push(`diagnostic ${citation.diagnosticId}`);
  }
  if (citation.excerpt) {
    parts.push(`excerpt ${truncateCitationText(citation.excerpt)}`);
  }
  if (parts.length === 0) {
    parts.push('unknown citation');
  }
  if (citation.authority) {
    parts.push(`authority ${citation.authority}`);
  }

  return parts.join(' | ');
}

function truncateCitationText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}
