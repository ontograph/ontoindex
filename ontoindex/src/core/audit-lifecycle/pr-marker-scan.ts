import { promises as fs } from 'node:fs';

export type AuditPrMarkerKind =
  | 'PR_REFERENCE'
  | 'TODO'
  | 'FIXME'
  | 'FOLLOW_UP'
  | 'KNOWN_LIMITATION'
  | 'DEFERRED';

export type AuditPrMarkerSuggestedTag = 'KNOWN-DEFERRED' | 'DECISION-GATED';

export interface AuditPrMarkerEvidenceLocation {
  file: string;
  line: number;
}

export interface AuditPrMarkerEvidenceWindow {
  file: string;
  evidenceLine: number;
  startLine: number;
  endLine: number;
  before: number;
  after: number;
  lineCount: number;
}

export interface AuditPrMarker {
  file: string;
  line: number;
  markerKind: AuditPrMarkerKind;
  matchedText: string;
  text: string;
  suggestedTag: AuditPrMarkerSuggestedTag;
  evidenceWindow: AuditPrMarkerEvidenceWindow;
}

export interface AuditPrMarkerScanInput {
  file: string;
  sourceText: string;
  evidenceLine: number;
  windowBefore?: number;
  windowAfter?: number;
}

export interface AuditPrMarkerPathScanInput {
  filePath: string;
  evidenceLine: number;
  displayFile?: string;
  windowBefore?: number;
  windowAfter?: number;
}

export interface AuditPrMarkerScanResult {
  file: string;
  evidenceLine: number;
  evidenceWindow: AuditPrMarkerEvidenceWindow;
  markers: AuditPrMarker[];
}

interface MarkerDefinition {
  kind: AuditPrMarkerKind;
  pattern: RegExp;
  suggestedTag: AuditPrMarkerSuggestedTag;
}

const DEFAULT_WINDOW_BEFORE = 3;
const DEFAULT_WINDOW_AFTER = 3;

const MARKER_DEFINITIONS: readonly MarkerDefinition[] = [
  { kind: 'PR_REFERENCE', pattern: /\bPR-\d+\b/i, suggestedTag: 'DECISION-GATED' },
  { kind: 'TODO', pattern: /\bTODO\b/i, suggestedTag: 'KNOWN-DEFERRED' },
  { kind: 'FIXME', pattern: /\bFIXME\b/i, suggestedTag: 'KNOWN-DEFERRED' },
  { kind: 'FOLLOW_UP', pattern: /\bfollow[-\s]?up\b/i, suggestedTag: 'KNOWN-DEFERRED' },
  {
    kind: 'KNOWN_LIMITATION',
    pattern: /\bknown\s+limitation\b/i,
    suggestedTag: 'KNOWN-DEFERRED',
  },
  { kind: 'DEFERRED', pattern: /\bdeferred\b/i, suggestedTag: 'KNOWN-DEFERRED' },
];

export function scanPrMarkersInSource(input: AuditPrMarkerScanInput): AuditPrMarkerScanResult {
  const evidenceLine = normalizeEvidenceLine(input.evidenceLine);
  const lines = input.sourceText.split(/\r?\n/);
  const before = normalizeWindowSize(input.windowBefore, DEFAULT_WINDOW_BEFORE);
  const after = normalizeWindowSize(input.windowAfter, DEFAULT_WINDOW_AFTER);
  const lineCount = lines.length;
  const anchorLine = Math.min(evidenceLine, lineCount);
  const startLine = Math.max(1, anchorLine - before);
  const endLine = Math.min(lineCount, evidenceLine + after);
  const evidenceWindow: AuditPrMarkerEvidenceWindow = {
    file: input.file,
    evidenceLine,
    startLine,
    endLine,
    before,
    after,
    lineCount,
  };
  const markers: AuditPrMarker[] = [];

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const commentText = extractCommentText(lines[lineNumber - 1]);
    if (!commentText) continue;

    for (const definition of MARKER_DEFINITIONS) {
      const match = definition.pattern.exec(commentText);
      if (!match) continue;
      markers.push({
        file: input.file,
        line: lineNumber,
        markerKind: definition.kind,
        matchedText: match[0],
        text: commentText,
        suggestedTag: definition.suggestedTag,
        evidenceWindow,
      });
    }
  }

  return {
    file: input.file,
    evidenceLine,
    evidenceWindow,
    markers,
  };
}

export async function scanPrMarkersNearPath(
  input: AuditPrMarkerPathScanInput,
): Promise<AuditPrMarkerScanResult> {
  const sourceText = await fs.readFile(input.filePath, 'utf8');
  return scanPrMarkersInSource({
    file: input.displayFile ?? input.filePath,
    sourceText,
    evidenceLine: input.evidenceLine,
    windowBefore: input.windowBefore,
    windowAfter: input.windowAfter,
  });
}

function normalizeEvidenceLine(line: number): number {
  if (!Number.isInteger(line) || line < 1) {
    throw new Error('evidenceLine must be a positive integer');
  }
  return line;
}

function normalizeWindowSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('window size must be a non-negative integer');
  }
  return value;
}

function extractCommentText(line: string): string | null {
  const commentStart = findCommentStart(line);
  if (commentStart === -1) return null;
  return stripCommentDelimiters(line.slice(commentStart)).trim();
}

function findCommentStart(line: string): number {
  const starts = [
    line.indexOf('//'),
    line.indexOf('/*'),
    line.indexOf('<!--'),
    leadingCommentIndex(line, '#'),
    leadingCommentIndex(line, '*'),
  ].filter((index) => index >= 0);

  return starts.length > 0 ? Math.min(...starts) : -1;
}

function leadingCommentIndex(line: string, marker: string): number {
  const trimmedStart = line.search(/\S/);
  if (trimmedStart === -1) return -1;
  return line.startsWith(marker, trimmedStart) ? trimmedStart : -1;
}

function stripCommentDelimiters(text: string): string {
  return text
    .replace(/^\/\/\s?/, '')
    .replace(/^\/\*\*?\s?/, '')
    .replace(/\s?\*\/$/, '')
    .replace(/^<!--\s?/, '')
    .replace(/\s?-->$/, '')
    .replace(/^#\s?/, '')
    .replace(/^\*\s?/, '');
}
