/**
 * TASK-7: deterministic, manifest-driven call-resolution precision baseline.
 *
 * This suite does not introduce new fixtures or new resolver semantics. It
 * aggregates the same CALLS edges the existing per-language resolver suites
 * already assert (positive: correct target file; negative: forbidden shadowed
 * target file, or expected-unresolved) into a single precision summary and pins
 * it against an explicit manifest. The manifest (precision-baseline.json) is the
 * sole baseline update point; the per-language suites remain authoritative for
 * individual edges.
 *
 * Per language:
 *   - truePositives: cases whose CALLS edge resolves to the expected file.
 *   - falsePositives: cases that resolve to the forbidden file, or that resolve
 *     somewhere other than the expected file, or (for expected-unresolved cases)
 *     that resolve at all. Missing resolution is NEVER a false positive.
 *   - falseNegatives: expected-file cases that produced zero matching CALLS
 *     edges (a miss). This is tracked separately and never enters the precision
 *     denominator.
 *   - expectedUnresolved: cases declared with expectFilePath=null that pass
 *     because no matching CALLS edge exists (no false-positive edge).
 *   - precision: truePositives / (truePositives + falsePositives).
 *
 * Parser-gated languages (manifest `parser` field) draw their availability guard
 * from the same probe their authoritative suite uses. When the grammar is not
 * available at runtime the language records an explicit, deterministic skipped
 * outcome instead of being silently omitted, and it is excluded from the runtime
 * aggregate. The top-level manifest baseline is the full-availability aggregate.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import Parser from 'tree-sitter';
import fs from 'fs';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const require = createRequire(import.meta.url);

/**
 * The authoritative, manifest-independent inventory of language resolver suites
 * this baseline must cover. Declared here (not derived from the manifest) so
 * that dropping a language from the manifest fails the inventory self-check
 * instead of silently shrinking the baseline.
 */
const EXPECTED_LANGUAGES = [
  'cpp',
  'csharp',
  'go',
  'java',
  'javascript',
  'php',
  'python',
  'ruby',
  'rust',
  'typescript',
  'kotlin',
  'dart',
  'swift',
  'cobol',
] as const;

type ManifestCase = {
  source: string;
  target: string;
  expectFilePath: string | null;
  forbidFilePath?: string | null;
};

type LangSummary = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  expectedUnresolved: number;
  precision: number;
};

type ParserGate = 'kotlin' | 'dart' | 'swift';

type ManifestLanguage = {
  language: string;
  fixture: string;
  parser?: ParserGate;
  cases: ManifestCase[];
  baseline: LangSummary;
};

type Manifest = {
  version: number;
  schema: string;
  skipGraphPhases?: boolean;
  languages: ManifestLanguage[];
  baseline: LangSummary;
};

const MANIFEST_PATH = path.join(FIXTURES, 'precision-baseline.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
const PIPELINE_OPTS = manifest.skipGraphPhases ? { skipGraphPhases: true } : undefined;

// ── Availability guards: each mirrors the probe its authoritative suite uses ──

/** Matches kotlin.test.ts: require the grammar and probe setLanguage. */
function isKotlinParserAvailable(): boolean {
  try {
    const language = require('tree-sitter-kotlin') as Parser.Language;
    const parser = new Parser();
    parser.setLanguage(language);
    return true;
  } catch {
    return false;
  }
}

/** Matches dart.test.ts: module-loaded check plus a runtime parser probe. */
async function isDartParserAvailable(): Promise<boolean> {
  if (!isLanguageAvailable(SupportedLanguages.Dart)) return false;
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
    return true;
  } catch {
    return false;
  }
}

/** Matches swift.test.ts: module-loaded check. */
function isSwiftParserAvailable(): boolean {
  return isLanguageAvailable(SupportedLanguages.Swift);
}

type AvailabilityOutcome = 'available' | 'skipped';

function precisionOf(tp: number, fp: number): number {
  const denom = tp + fp;
  return denom === 0 ? 1 : tp / denom;
}

/** Compute the precision summary for one language from its resolved CALLS edges. */
function summarizeLanguage(result: PipelineResult, cases: ManifestCase[]): LangSummary {
  const calls = getRelationships(result, 'CALLS');
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let expectedUnresolved = 0;

  for (const c of cases) {
    const edges = calls.filter((e) => e.source === c.source && e.target === c.target);

    if (c.expectFilePath === null) {
      // Ambiguous / expected-unresolved: passes only when no edge exists.
      if (edges.length === 0) expectedUnresolved += 1;
      else falsePositives += 1;
      continue;
    }

    if (edges.length === 0) {
      // Missed: expected an edge, resolver produced none. Not a false positive
      // and not part of the precision denominator.
      falseNegatives += 1;
      continue;
    }

    const resolvedExpected = edges.some((e) => e.targetFilePath === c.expectFilePath);
    const resolvedForbidden =
      c.forbidFilePath != null && edges.some((e) => e.targetFilePath === c.forbidFilePath);
    const resolvedOther = edges.some(
      (e) => e.targetFilePath !== c.expectFilePath && e.targetFilePath !== c.forbidFilePath,
    );

    if (resolvedExpected && !resolvedForbidden && !resolvedOther) {
      truePositives += 1;
    } else {
      falsePositives += 1;
    }
  }

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    expectedUnresolved,
    precision: precisionOf(truePositives, falsePositives),
  };
}

const availability = new Map<string, AvailabilityOutcome>();

describe('call-resolution precision baseline (manifest-driven)', () => {
  const results = new Map<string, PipelineResult>();

  beforeAll(async () => {
    // Resolve parser availability once, deterministically, per gated language.
    for (const lang of manifest.languages) {
      if (!lang.parser) {
        availability.set(lang.language, 'available');
        continue;
      }
      let ok = false;
      if (lang.parser === 'kotlin') ok = isKotlinParserAvailable();
      else if (lang.parser === 'dart') ok = await isDartParserAvailable();
      else if (lang.parser === 'swift') ok = isSwiftParserAvailable();
      availability.set(lang.language, ok ? 'available' : 'skipped');
    }

    // Run the pipeline only for available languages.
    for (const lang of manifest.languages) {
      if (availability.get(lang.language) !== 'available') continue;
      results.set(
        lang.language,
        await runPipelineFromRepo(path.join(FIXTURES, lang.fixture), () => {}, PIPELINE_OPTS),
      );
    }

    // Report availability outcomes and counts for the run.
    const outcomes = manifest.languages
      .map((l) => `${l.language}=${availability.get(l.language)}`)
      .join(', ');
    const skipped = manifest.languages.filter(
      (l) => availability.get(l.language) === 'skipped',
    ).length;
    const available = manifest.languages.length - skipped;

    console.log(
      `[precision-baseline] availability: ${outcomes} (available=${available}, skipped=${skipped})`,
    );
  }, 120000);

  it('manifest is schema v2 with a falseNegatives-aware baseline', () => {
    expect(manifest.version).toBe(2);
    expect(manifest.schema).toBe('precision-baseline/v2');
    expect(manifest.baseline).toHaveProperty('falseNegatives');
  });

  it('covers exactly the expected language inventory (independent of manifest)', () => {
    // Independent self-check: the manifest must cover precisely the declared
    // inventory. A missing or extra language fails here regardless of baselines.
    const manifestLangs = manifest.languages.map((l) => l.language).sort();
    expect(manifestLangs).toEqual([...EXPECTED_LANGUAGES].sort());
  });

  it('every manifest language supplies positive and negative evidence', () => {
    expect(manifest.languages.length).toBeGreaterThan(0);
    for (const lang of manifest.languages) {
      expect(lang.cases.length).toBeGreaterThan(0);
      // Each language must contribute at least one positive expectation and one
      // negative expectation (forbidden edge or expected-unresolved case).
      const hasPositive = lang.cases.some((c) => c.expectFilePath !== null);
      const hasNegative = lang.cases.some(
        (c) => c.expectFilePath === null || c.forbidFilePath != null,
      );
      expect(hasPositive, `${lang.language} must have a positive case`).toBe(true);
      expect(hasNegative, `${lang.language} must have a negative case`).toBe(true);
    }
  });

  it('top-level baseline is the full-availability aggregate of all languages', () => {
    // Pure manifest self-check (no runtime): the top-level baseline must equal
    // the sum of every per-language baseline, so it stays honest even when a
    // parser is unavailable at runtime.
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let expectedUnresolved = 0;
    for (const lang of manifest.languages) {
      truePositives += lang.baseline.truePositives;
      falsePositives += lang.baseline.falsePositives;
      falseNegatives += lang.baseline.falseNegatives;
      expectedUnresolved += lang.baseline.expectedUnresolved;
    }
    expect(manifest.baseline).toEqual({
      truePositives,
      falsePositives,
      falseNegatives,
      expectedUnresolved,
      precision: precisionOf(truePositives, falsePositives),
    });
  });

  for (const lang of manifest.languages) {
    it(`${lang.language} precision summary matches manifest baseline (or records skip)`, () => {
      const outcome = availability.get(lang.language);
      expect(outcome, `${lang.language} availability must be recorded`).toBeDefined();
      if (outcome === 'skipped') {
        // Explicit, deterministic, recorded skip — not a silent omission.
        expect(lang.parser, `${lang.language} may only skip when parser-gated`).toBeDefined();
        expect(results.has(lang.language)).toBe(false);
        return;
      }
      const result = results.get(lang.language)!;
      const summary = summarizeLanguage(result, lang.cases);
      expect(summary).toEqual(lang.baseline);
    });
  }

  it('runtime aggregate matches the sum of available-language baselines', () => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let expectedUnresolved = 0;
    let expectedTp = 0;
    let expectedFp = 0;
    let expectedFn = 0;
    let expectedEu = 0;

    for (const lang of manifest.languages) {
      if (availability.get(lang.language) !== 'available') continue;
      const summary = summarizeLanguage(results.get(lang.language)!, lang.cases);
      truePositives += summary.truePositives;
      falsePositives += summary.falsePositives;
      falseNegatives += summary.falseNegatives;
      expectedUnresolved += summary.expectedUnresolved;
      expectedTp += lang.baseline.truePositives;
      expectedFp += lang.baseline.falsePositives;
      expectedFn += lang.baseline.falseNegatives;
      expectedEu += lang.baseline.expectedUnresolved;
    }

    const aggregate: LangSummary = {
      truePositives,
      falsePositives,
      falseNegatives,
      expectedUnresolved,
      precision: precisionOf(truePositives, falsePositives),
    };
    expect(aggregate).toEqual({
      truePositives: expectedTp,
      falsePositives: expectedFp,
      falseNegatives: expectedFn,
      expectedUnresolved: expectedEu,
      precision: precisionOf(expectedTp, expectedFp),
    });
  });
});
