import type {
  AnalyzerTimingRecord,
  PrecisionScopeDeclaration,
  ScopedPrecisionDecision,
  ScopedPrecisionPolicy,
} from '../performance/index.js';
import { createAnalyzerTimingRecord, decideScopedPrecisionPolicy } from '../performance/index.js';
import type { PipelineContext, PipelinePhase } from './types.js';

export const OPTIONAL_PRECISION_ANALYZER_ID = 'optional-precision-placeholder';

export interface OptionalPrecisionAnalyzerOptions {
  policy?: ScopedPrecisionPolicy;
  declaration?: Partial<PrecisionScopeDeclaration>;
  onTimingRecord?: (record: AnalyzerTimingRecord) => void;
}

export interface OptionalPrecisionOutput {
  decision: ScopedPrecisionDecision;
  timingRecord: AnalyzerTimingRecord;
}

export const optionalPrecisionPhase: PipelinePhase<OptionalPrecisionOutput> = {
  name: 'optionalPrecision',
  deps: ['parse'],

  async execute(ctx: PipelineContext): Promise<OptionalPrecisionOutput> {
    const options = ctx.options?.optionalPrecisionAnalyzer;
    const analyzerId = options?.declaration?.engineId?.trim() || OPTIONAL_PRECISION_ANALYZER_ID;
    const startedAt = new Date();
    const decision = decideScopedPrecisionPolicy(options?.policy, options?.declaration);
    const finishedAt = new Date();

    const timingRecord = createAnalyzerTimingRecord({
      analyzerId,
      status: decision.allowed ? 'completed' : 'skipped',
      startedAt,
      finishedAt,
      input: {
        ...decision.scope.input,
        fileCount: decision.scope.files.length,
        languageCount: decision.scope.languages.length,
      },
      skippedReason: decision.allowed
        ? undefined
        : decision.reason === 'allowed'
          ? 'scope-empty'
          : decision.reason,
      result: decision.allowed ? { outputCount: 0 } : undefined,
    });

    try {
      options?.onTimingRecord?.(timingRecord);
    } catch {
      // Optional analyzer reporting must not change pipeline behavior.
    }

    return { decision, timingRecord };
  },
};
