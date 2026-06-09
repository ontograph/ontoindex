import fs from 'fs/promises';
import path from 'path';

import type { RepoMeta } from './repo-manager.js';

const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values)];

export const formatIndexCapabilityWarnings = (meta: RepoMeta): string[] => {
  const capabilities = meta.capabilities;
  const isSymbolsOnly =
    meta.indexMode === 'symbols-only' ||
    meta.pipelineProfile === 'symbols' ||
    meta.pipelineProfile === 'huge-repo-symbols';
  const hasDegradedCapability =
    capabilities?.impact === 'degraded' ||
    capabilities?.processes === false ||
    Boolean(meta.degradedFiles?.length) ||
    Boolean(meta.skippedPhases?.length);

  if (!isSymbolsOnly && !hasDegradedCapability) return [];

  const symbolsAvailable = capabilities?.symbols ?? true;
  const processesAvailable = capabilities?.processes ?? !isSymbolsOnly;
  const impactCapability = capabilities?.impact ?? (isSymbolsOnly ? 'degraded' : 'full');
  const lines = [
    'WARNING: index capabilities are degraded.',
    `Index mode: ${meta.indexMode ?? meta.pipelineProfile ?? 'unknown'}`,
    `  Symbols: ${symbolsAvailable ? 'available' : 'unavailable'}`,
    `  Processes: ${processesAvailable ? 'available' : 'unavailable'}`,
    `  Impact analysis: ${impactCapability}`,
  ];

  if (meta.pipelineProfile === 'huge-repo-symbols') {
    lines.push('  Profile: huge-repo-symbols (deep enrichment skipped)');
  }

  if (meta.skippedPhases?.length) {
    lines.push(`  Skipped phases: ${meta.skippedPhases.join(', ')}`);
  }
  if (meta.degradedFiles?.length) {
    lines.push(`  Degraded files: ${meta.degradedFiles.length}`);
  }
  if (meta.partialCheckpointPath) {
    lines.push(`  Partial checkpoint: ${meta.partialCheckpointPath}`);
  }

  return lines;
};

export async function loadIndexCapabilityWarnings(storagePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(storagePath, 'meta.json'), 'utf-8');
    return formatIndexCapabilityWarnings(JSON.parse(raw) as RepoMeta);
  } catch {
    return [];
  }
}

export function appendIndexCapabilityWarnings(
  result: unknown,
  warnings: readonly string[],
): unknown {
  if (warnings.length === 0) return result;

  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const existingWarnings = Array.isArray(record.warnings)
      ? record.warnings.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      ...record,
      warnings: uniqueStrings([...existingWarnings, ...warnings]),
    };
  }

  return {
    result,
    warnings: uniqueStrings([...warnings]),
  };
}
