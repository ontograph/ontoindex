import type { GraphIdentityProvider } from './markdown-graph-identity-provider.js';
import {
  checkAnswerGrounding,
  extractAnswerCitations,
  type AnswerGroundingResult,
} from './markdown-answer-grounding.js';
import {
  MARKDOWN_MENTION_MAX_DISTINCT,
  mentionLookupName,
  resolveMentionTexts,
} from './markdown-mention-resolution.js';

export interface VerifyAnswerInput {
  answer: string;
  paths: readonly string[];
  provider?: Pick<GraphIdentityProvider, 'findSymbols'>;
}

export interface VerifyAnswerReport extends AnswerGroundingResult {
  symbolCheck: 'ok' | 'partial' | 'skipped';
  pathsKnown: number;
}

export async function verifyAnswer(input: VerifyAnswerInput): Promise<VerifyAnswerReport> {
  const symbolTexts = extractAnswerCitations(input.answer)
    .filter((citation) => citation.kind === 'symbol')
    .map((citation) => citation.text);
  let symbolCheck: VerifyAnswerReport['symbolCheck'] = input.provider
    ? symbolTexts.length === 0
      ? 'ok'
      : 'partial'
    : 'skipped';
  const mentionTargets: Record<
    string,
    {
      status: 'resolved' | 'ambiguous' | 'unresolved';
      targets: { name?: string; filePath?: string }[];
    }
  > = {};

  if (input.provider && symbolTexts.length > 0) {
    const { resolutions, summary } = await resolveMentionTexts(symbolTexts, input.provider);
    symbolCheck = summary.status === 'ok' ? 'ok' : 'partial';
    for (const [text, resolution] of resolutions) {
      mentionTargets[text] = {
        status: resolution.status,
        targets: resolution.targets.map(({ name, filePath }) => ({
          ...(name === undefined ? {} : { name }),
          ...(filePath === undefined ? {} : { filePath }),
        })),
      };
    }
  }

  const result = checkAnswerGrounding(input.answer, {
    docPaths: input.paths,
    mentionTargets,
  });
  const distinctNames = new Set(
    symbolTexts.map(mentionLookupName).filter((name) => name !== undefined),
  );
  if (symbolCheck !== 'ok' || distinctNames.size > MARKDOWN_MENTION_MAX_DISTINCT) {
    const moved = result.ungrounded.filter((citation) => citation.kind === 'symbol');
    result.ungrounded = result.ungrounded.filter((citation) => citation.kind !== 'symbol');
    result.unverifiable = [...result.unverifiable, ...moved];
    const hasCitations =
      result.grounded.length + result.ungrounded.length + result.unverifiable.length > 0;
    result.status = !hasCitations
      ? 'no-citations'
      : result.ungrounded.length > 0
        ? 'ungrounded'
        : 'grounded';
  }

  return { ...result, symbolCheck, pathsKnown: input.paths.length };
}
