import { getLanguageFromFilename } from 'ontoindex-shared';

export interface ScopeRetentionCoverage {
  version: 1;
  languages: Array<{
    language: string;
    files: number;
    retained: number;
    skipped: number;
    refused: number;
    unaccounted: number;
    unparsed: number;
    refusalReasons: Array<{ reason: string; count: number }>;
  }>;
  complete: boolean;
}

/** Descriptive inventory evidence only; this summary is never seed admission. */
export function summarizeScopeRetentionCoverage(
  inventory: readonly { filePath: string; status: string; reason?: string }[],
): ScopeRetentionCoverage {
  const buckets = new Map<string, ScopeRetentionCoverage['languages'][number]>();
  for (const item of inventory) {
    const language = getLanguageFromFilename(item.filePath) ?? 'unknown';
    let bucket = buckets.get(language);
    if (!bucket) {
      bucket = {
        language,
        files: 0,
        retained: 0,
        skipped: 0,
        refused: 0,
        unaccounted: 0,
        unparsed: 0,
        refusalReasons: [],
      };
      buckets.set(language, bucket);
    }
    bucket.files++;
    if (item.status === 'retained') bucket.retained++;
    else if (item.status === 'skipped') bucket.skipped++;
    else if (['failed', 'unsupported', 'invalid-outcome'].includes(item.status)) {
      bucket.refused++;
      const reason = item.reason ?? item.status;
      const existing = bucket.refusalReasons.find((entry) => entry.reason === reason);
      if (existing) existing.count++;
      else bucket.refusalReasons.push({ reason, count: 1 });
    } else if (language === 'unknown' && item.status === 'missing-outcome') bucket.unparsed++;
    else bucket.unaccounted++;
  }
  const languages = [...buckets.values()].sort((a, b) =>
    a.language < b.language ? -1 : a.language > b.language ? 1 : 0,
  );
  for (const bucket of languages) {
    bucket.refusalReasons.sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  }
  return {
    version: 1,
    languages,
    complete:
      languages.length > 0 &&
      languages.every((bucket) => bucket.refused === 0 && bucket.unaccounted === 0),
  };
}
