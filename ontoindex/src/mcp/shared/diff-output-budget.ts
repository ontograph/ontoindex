export interface DiffOutputBudgetSummary {
  totalChangedFiles: number;
  emittedChangedFiles: number;
  totalChangedSymbols: number;
  emittedChangedSymbols: number;
  detailTruncated: boolean;
  truncatedFileCount: number;
  truncatedSymbolCount: number;
}

export interface DiffOutputBudgetLimits {
  summaryFirst: true;
  truncated: boolean;
  maxChangedFiles: number;
  maxChangedSymbolsPerFile: number;
  emittedChangedFiles: number;
  totalChangedFiles: number;
  emittedChangedSymbols: number;
  totalChangedSymbols: number;
  truncatedFileCount: number;
  truncatedSymbolCount: number;
  cursor: null;
  retryHint?: string;
}

export interface DiffOutputBudgetInput {
  totalChangedFiles: number;
  emittedChangedFiles: number;
  totalChangedSymbols: number;
  emittedChangedSymbols: number;
  truncatedFileCount: number;
  truncatedSymbolCount: number;
  maxChangedFiles: number;
  maxChangedSymbolsPerFile: number;
  retryHint?: string;
}

export interface DiffOutputBudget {
  summary: DiffOutputBudgetSummary;
  limits: DiffOutputBudgetLimits;
}

export function buildDiffOutputBudget(input: DiffOutputBudgetInput): DiffOutputBudget {
  const truncated =
    input.truncatedFileCount > 0 ||
    input.truncatedSymbolCount > 0 ||
    input.emittedChangedFiles < input.totalChangedFiles ||
    input.emittedChangedSymbols < input.totalChangedSymbols;

  return {
    summary: {
      totalChangedFiles: input.totalChangedFiles,
      emittedChangedFiles: input.emittedChangedFiles,
      totalChangedSymbols: input.totalChangedSymbols,
      emittedChangedSymbols: input.emittedChangedSymbols,
      detailTruncated: truncated,
      truncatedFileCount: input.truncatedFileCount,
      truncatedSymbolCount: input.truncatedSymbolCount,
    },
    limits: {
      summaryFirst: true,
      truncated,
      maxChangedFiles: input.maxChangedFiles,
      maxChangedSymbolsPerFile: input.maxChangedSymbolsPerFile,
      emittedChangedFiles: input.emittedChangedFiles,
      totalChangedFiles: input.totalChangedFiles,
      emittedChangedSymbols: input.emittedChangedSymbols,
      totalChangedSymbols: input.totalChangedSymbols,
      truncatedFileCount: input.truncatedFileCount,
      truncatedSymbolCount: input.truncatedSymbolCount,
      cursor: null,
      ...(input.retryHint ? { retryHint: input.retryHint } : {}),
    },
  };
}
