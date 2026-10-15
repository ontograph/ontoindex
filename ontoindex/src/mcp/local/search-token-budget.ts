import { estimateTokens } from '../../core/wiki/llm-client.js';

export interface SearchTokenBudgetReport {
  max_tokens: number;
  estimated_tokens: number;
  kept_process_symbols: number;
  kept_definitions: number;
  dropped_process_symbols: number;
  dropped_definitions: number;
  skeletons_dropped: boolean;
  content_stripped: number;
  truncated: boolean;
  over_budget: boolean;
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? '');
}

export function applySearchTokenBudget<T>(result: T, maxTokens: number): T {
  if (result === null || typeof result !== 'object') return result;

  const input = result as T & {
    definitions?: unknown;
    process_symbols?: unknown;
  };
  const processSymbols = Array.isArray(input.process_symbols)
    ? [...input.process_symbols]
    : undefined;
  const definitions = Array.isArray(input.definitions) ? [...input.definitions] : undefined;
  if (!processSymbols && !definitions) return result;

  const output: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  output.process_symbols = [...(processSymbols ?? [])];
  output.definitions = [...(definitions ?? [])];

  let skeletonsDropped = false;
  const base: Record<string, unknown> = { ...output, process_symbols: [], definitions: [] };
  if (
    estimateJsonTokens(base) > maxTokens &&
    Object.prototype.hasOwnProperty.call(base, 'skeletons')
  ) {
    delete base.skeletons;
    delete output.skeletons;
    skeletonsDropped = true;
  }

  let total = estimateJsonTokens(base);
  for (const item of [...(processSymbols ?? []), ...(definitions ?? [])]) {
    total += estimateJsonTokens(item) + 1;
  }
  let contentStripped = 0;
  for (const items of [definitions, processSymbols]) {
    if (!items) continue;
    for (let index = items.length - 1; index >= 0 && total > maxTokens; index--) {
      const item = items[index];
      if (
        item === null ||
        typeof item !== 'object' ||
        !Object.prototype.hasOwnProperty.call(item, 'content')
      ) {
        continue;
      }
      const stripped = { ...item };
      delete stripped.content;
      items[index] = stripped;
      total += estimateJsonTokens(stripped) - estimateJsonTokens(item);
      contentStripped++;
    }
  }

  let used = estimateJsonTokens(base);
  const keptProcessSymbols: unknown[] = [];
  const keptDefinitions: unknown[] = [];
  let stopped = false;
  for (const item of processSymbols ?? []) {
    const cost = estimateJsonTokens(item) + 1;
    if (used + cost <= maxTokens) {
      keptProcessSymbols.push(item);
      used += cost;
    } else {
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    for (const item of definitions ?? []) {
      const cost = estimateJsonTokens(item) + 1;
      if (used + cost <= maxTokens) {
        keptDefinitions.push(item);
        used += cost;
      } else {
        stopped = true;
        break;
      }
    }
  }

  if (
    keptProcessSymbols.length === 0 &&
    keptDefinitions.length === 0 &&
    (processSymbols?.length || definitions?.length)
  ) {
    if (processSymbols?.length) keptProcessSymbols.push(processSymbols[0]);
    else keptDefinitions.push(definitions![0]);
  }

  output.process_symbols = keptProcessSymbols;
  output.definitions = keptDefinitions;
  const estimatedOutput = { ...output };
  const report: SearchTokenBudgetReport = {
    max_tokens: maxTokens,
    estimated_tokens: estimateJsonTokens(estimatedOutput),
    kept_process_symbols: keptProcessSymbols.length,
    kept_definitions: keptDefinitions.length,
    dropped_process_symbols: (processSymbols?.length ?? 0) - keptProcessSymbols.length,
    dropped_definitions: (definitions?.length ?? 0) - keptDefinitions.length,
    skeletons_dropped: skeletonsDropped,
    content_stripped: contentStripped,
    truncated:
      (processSymbols?.length ?? 0) - keptProcessSymbols.length > 0 ||
      (definitions?.length ?? 0) - keptDefinitions.length > 0 ||
      skeletonsDropped ||
      contentStripped > 0,
    over_budget: estimateJsonTokens(estimatedOutput) > maxTokens,
  };
  output.budget = report;
  return output as T;
}
