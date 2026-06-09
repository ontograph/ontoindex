import type { PipelineProgress } from 'ontoindex-shared';
import type { PipelineResult } from '../../../types/pipeline.js';
import { type PipelineOptions, runPipelineFromRepo } from '../pipeline.js';

export interface AnalyzeRepoInput {
  repoPath: string;
  onProgress: (progress: PipelineProgress) => void;
  options?: PipelineOptions;
}

export interface AnalyzeRuntime {
  analyzeRepo(input: AnalyzeRepoInput): Promise<PipelineResult>;
}

export type AnalyzePipelineRunner = typeof runPipelineFromRepo;

export interface TypeScriptAnalyzeRuntimeOptions {
  runPipeline?: AnalyzePipelineRunner;
}

export class TypeScriptAnalyzeRuntime implements AnalyzeRuntime {
  private readonly runPipeline: AnalyzePipelineRunner;

  constructor(options: TypeScriptAnalyzeRuntimeOptions = {}) {
    this.runPipeline = options.runPipeline ?? runPipelineFromRepo;
  }

  analyzeRepo(input: AnalyzeRepoInput): Promise<PipelineResult> {
    return this.runPipeline(input.repoPath, input.onProgress, input.options);
  }
}

export const createTypeScriptAnalyzeRuntime = (
  options: TypeScriptAnalyzeRuntimeOptions = {},
): AnalyzeRuntime => new TypeScriptAnalyzeRuntime(options);
