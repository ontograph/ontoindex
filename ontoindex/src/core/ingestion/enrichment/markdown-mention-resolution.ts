import type { GraphIdentityProvider } from './markdown-graph-identity-provider.js';

export const MARKDOWN_MENTION_MAX_DISTINCT = 40;
export const MARKDOWN_MENTION_MAX_CANDIDATES = 3;
export const MARKDOWN_MENTION_TIMEOUT_MS = 1500;

export interface ResolvedMentionTarget {
  id: string;
  name?: string;
  filePath?: string;
  startLine?: number;
}
export interface MentionResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  targets: ResolvedMentionTarget[];
  candidateCount?: number;
}
export interface MentionResolutionSummary {
  status: 'ok' | 'partial' | 'skipped';
  lookups: number;
  reason?: string;
}

export function mentionLookupName(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length > 80 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.split('.').pop();
}

export async function resolveMentionTexts(
  texts: readonly string[],
  provider: Pick<GraphIdentityProvider, 'findSymbols'>,
  options?: { timeoutMs?: number },
): Promise<{ resolutions: Map<string, MentionResolution>; summary: MentionResolutionSummary }> {
  const deadline = performance.now() + (options?.timeoutMs ?? MARKDOWN_MENTION_TIMEOUT_MS);
  const originals = new Map<string, Set<string>>();
  for (const text of texts) {
    const name = mentionLookupName(text);
    if (name === undefined) continue;
    if (!originals.has(name)) {
      if (originals.size >= MARKDOWN_MENTION_MAX_DISTINCT) continue;
      originals.set(name, new Set());
    }
    originals.get(name)!.add(text);
  }

  const resolutions = new Map<string, MentionResolution>();
  const summary: MentionResolutionSummary = { status: 'ok', lookups: 0 };
  const timeout = Symbol('timeout');
  for (const [name, originalTexts] of originals) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      summary.status = 'partial';
      summary.reason = 'timeout';
      break;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      summary.lookups++;
      const candidates = await Promise.race([
        provider.findSymbols({ mention: name, maxCandidates: MARKDOWN_MENTION_MAX_CANDIDATES + 1 }),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), remaining);
        }),
      ]);
      if (candidates === timeout || performance.now() >= deadline) {
        summary.status = 'partial';
        summary.reason = 'timeout';
        break;
      }
      const codeCandidates = candidates.filter(
        (candidate) => typeof candidate.startLine === 'number',
      );
      const resolution: MentionResolution = {
        status:
          candidates.length > MARKDOWN_MENTION_MAX_CANDIDATES || codeCandidates.length > 1
            ? 'ambiguous'
            : codeCandidates.length === 1
              ? 'resolved'
              : 'unresolved',
        targets: [],
      };
      if (resolution.status === 'ambiguous') {
        resolution.candidateCount = Math.min(
          codeCandidates.length,
          MARKDOWN_MENTION_MAX_CANDIDATES + 1,
        );
      } else if (resolution.status === 'resolved') {
        const { id, name, filePath, startLine } = codeCandidates[0]!;
        resolution.targets = [{ id, name, filePath, startLine }];
      }
      for (const text of originalTexts) resolutions.set(text, resolution);
    } catch {
      summary.status = 'partial';
      summary.reason = 'provider-error';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { resolutions, summary };
}
