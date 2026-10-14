import { mentionLookupName } from './markdown-mention-resolution.js';

export const ANSWER_GROUNDING_MAX_ANSWER_BYTES = 65536;
export const ANSWER_GROUNDING_MAX_CITATIONS = 200;

export interface GroundingEvidence {
  docPaths: readonly string[];
  mentionTargets: Readonly<
    Record<
      string,
      {
        status: 'resolved' | 'ambiguous' | 'unresolved';
        targets: readonly { name?: string; filePath?: string }[];
      }
    >
  >;
}
export interface AnswerCitation {
  kind: 'path' | 'symbol';
  text: string;
  line?: number;
}
export interface AnswerGroundingResult {
  status: 'grounded' | 'ungrounded' | 'no-citations';
  grounded: AnswerCitation[];
  ungrounded: AnswerCitation[];
  unverifiable: AnswerCitation[];
  truncated: boolean;
}

const EXT = '(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|rs|py|go|java|sh|css|html)';
const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const SPAN_RE = /`([^`\n]+)`/g;
const PATH_IN_SPAN_RE = new RegExp(
  `^(?:\\./)?(?:[\\w-][\\w.-]*/)*[\\w-][\\w.-]*\\.${EXT}(?::(\\d+))?$`,
);
const PATH_IN_PROSE_RE = new RegExp(
  `(?:\\./)?(?:[\\w-][\\w.-]*/)+[\\w-][\\w.-]*\\.${EXT}(?::(\\d+))?\\b`,
  'g',
);

function normalizePath(text: string): string {
  return text.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathCitation(raw: string, line: string | undefined): AnswerCitation {
  const text = normalizePath(line === undefined ? raw : raw.slice(0, -(line.length + 1)));
  return line === undefined ? { kind: 'path', text } : { kind: 'path', text, line: Number(line) };
}

function isCodeLike(text: string): boolean {
  return /[A-Z.]/.test(text);
}

export function extractAnswerCitations(answer: string): AnswerCitation[] {
  const bounded = Buffer.from(answer, 'utf8')
    .subarray(0, ANSWER_GROUNDING_MAX_ANSWER_BYTES)
    .toString('utf8');
  const text = bounded.replace(FENCE_RE, '').replace(URL_RE, ' ');
  const found: AnswerCitation[] = [];
  const prose = text.replace(SPAN_RE, (_match, inner: string) => {
    const span = inner.trim();
    const pathMatch = PATH_IN_SPAN_RE.exec(span);
    if (pathMatch) {
      found.push(pathCitation(span, pathMatch[1]));
    } else {
      const symbol = span.replace(/\(\)$/, '');
      if (mentionLookupName(symbol) !== undefined && isCodeLike(symbol)) {
        found.push({ kind: 'symbol', text: symbol });
      }
    }
    return ' ';
  });
  for (const match of prose.matchAll(PATH_IN_PROSE_RE)) {
    found.push(pathCitation(match[0], match[1]));
  }
  const seen = new Set<string>();
  return found.filter((citation) => {
    const key = `${citation.kind}\0${citation.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function checkAnswerGrounding(
  answer: string,
  evidence: GroundingEvidence,
): AnswerGroundingResult {
  const all = extractAnswerCitations(answer);
  const citations = all.slice(0, ANSWER_GROUNDING_MAX_CITATIONS);
  const entries = Object.entries(evidence.mentionTargets);
  const knownPaths = [
    ...evidence.docPaths,
    ...entries.flatMap(([, entry]) => entry.targets.map((target) => target.filePath ?? '')),
  ]
    .filter((path) => path.length > 0)
    .map(normalizePath);
  const resolvedNames = new Set(
    entries
      .filter(([, entry]) => entry.status === 'resolved')
      .flatMap(([, entry]) => entry.targets.map((target) => target.name ?? '')),
  );
  const ambiguousNames = new Set(
    entries
      .filter(([, entry]) => entry.status === 'ambiguous')
      .map(([key]) => mentionLookupName(key) ?? key),
  );
  const result: AnswerGroundingResult = {
    status: 'no-citations',
    grounded: [],
    ungrounded: [],
    unverifiable: [],
    truncated: all.length > citations.length,
  };
  for (const citation of citations) {
    if (citation.kind === 'path') {
      const ok = knownPaths.some(
        (path) => path === citation.text || path.endsWith(`/${citation.text}`),
      );
      (ok ? result.grounded : result.ungrounded).push(citation);
      continue;
    }
    const entry = evidence.mentionTargets[citation.text];
    const name = mentionLookupName(citation.text) ?? citation.text;
    if (entry?.status === 'resolved' || resolvedNames.has(name)) result.grounded.push(citation);
    else if (entry?.status === 'ambiguous' || ambiguousNames.has(name))
      result.unverifiable.push(citation);
    else result.ungrounded.push(citation);
  }
  if (citations.length > 0)
    result.status = result.ungrounded.length > 0 ? 'ungrounded' : 'grounded';
  return result;
}
