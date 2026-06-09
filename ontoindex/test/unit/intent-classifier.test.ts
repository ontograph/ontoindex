import { describe, it, expect } from 'vitest';
import { classifyIntent, type Intent } from '../../src/core/search/intent-classifier.js';

interface LabeledQuery {
  query: string;
  intent: string;
}

const GOLD_STANDARD_QUERIES: LabeledQuery[] = [
  { query: 'what calls mergeWithRRF', intent: 'calls-of' },
  { query: 'who invokes embedQuery', intent: 'calls-of' },
  { query: 'downstream impact of changing executeQuery', intent: 'cross-file-impact' },
  { query: 'what breaks if I rename hybridSearch', intent: 'cross-file-impact' },
  { query: 'how does the embedding pipeline work', intent: 'nl-conceptual' },
  { query: 'explain wiki cache flow', intent: 'nl-conceptual' },
  { query: 'where is graph traversal implemented', intent: 'nl-conceptual' },
  { query: 'LadybugDB', intent: 'ambiguous' },
  { query: 'wiki', intent: 'ambiguous' },
  { query: 'embed query', intent: 'ambiguous' },
];

/** Treat 'nl-question' (training set legacy label) as equivalent to 'nl-conceptual'. */
function normalizeIntent(label: string): Intent {
  if (label === 'nl-question') return 'nl-conceptual';
  return label as Intent;
}

describe('classifyIntent', () => {
  describe('unit cases', () => {
    it('detects calls-of from "what calls X"', () => {
      expect(classifyIntent('what calls mergeWithRRF').intent).toBe('calls-of');
      expect(classifyIntent('callers of LadybugDB').intent).toBe('calls-of');
      expect(classifyIntent('who invokes embedQuery').intent).toBe('calls-of');
    });

    it('detects cross-file-impact from "what breaks" / "downstream"', () => {
      expect(classifyIntent('what breaks if I rename hybridSearch').intent).toBe(
        'cross-file-impact',
      );
      expect(classifyIntent('downstream impact of changing X').intent).toBe('cross-file-impact');
      expect(classifyIntent('files affected by removing Y').intent).toBe('cross-file-impact');
    });

    it('detects nl-conceptual from "how does X work"', () => {
      expect(classifyIntent('how does the cache work').intent).toBe('nl-conceptual');
      expect(classifyIntent('explain the embedding pipeline').intent).toBe('nl-conceptual');
      expect(classifyIntent('where is wiki rendering').intent).toBe('nl-conceptual');
    });

    it('detects ambiguous on bare tokens', () => {
      expect(classifyIntent('analyze').intent).toBe('ambiguous');
      expect(classifyIntent('wiki').intent).toBe('ambiguous');
      expect(classifyIntent('embed query').intent).toBe('ambiguous');
    });

    it('falls back to nl-conceptual on long unmatched queries', () => {
      const r = classifyIntent('describe the wiki cache flow with content addressing');
      expect(r.intent).toBe('nl-conceptual');
      expect(r.confidence).toBeLessThan(0.7);
    });

    it('returns ambiguous on empty / non-string input', () => {
      expect(classifyIntent('').intent).toBe('ambiguous');
      expect(classifyIntent('   ').intent).toBe('ambiguous');
      expect(classifyIntent(null as unknown as string).intent).toBe('ambiguous');
    });

    it('priority: cross-file-impact beats nl-conceptual when both match', () => {
      // "what is the impact of changing X" — should NOT classify as nl-conceptual
      // (which would match 'what is the' first if order were different).
      const r = classifyIntent('what is the impact of changing executeQuery');
      expect(r.intent).toBe('cross-file-impact');
    });
  });

  describe('gold-standard validation against representative labeled queries', () => {
    const all = GOLD_STANDARD_QUERIES;

    it('loads the representative labeled queries', () => {
      expect(all).toHaveLength(10);
    });

    it('achieves overall accuracy ≥ 0.75 on the representative gold standard', () => {
      let correct = 0;
      const misclassified: Array<{ query: string; expected: string; got: string }> = [];
      for (const q of all) {
        const expected = normalizeIntent(q.intent);
        const got = classifyIntent(q.query).intent;
        if (got === expected) {
          correct++;
        } else {
          misclassified.push({ query: q.query, expected, got });
        }
      }
      const accuracy = correct / all.length;
      // Surface mismatches for human review when the threshold trips.
      if (accuracy < 0.75) {
        console.error(
          `Misclassified (${misclassified.length}/${all.length}):`,
          misclassified.slice(0, 20),
        );
      }
      expect(accuracy).toBeGreaterThanOrEqual(0.75);
    });

    it('reports per-intent accuracy', () => {
      const perIntent = new Map<string, { correct: number; total: number }>();
      for (const q of all) {
        const expected = normalizeIntent(q.intent);
        const got = classifyIntent(q.query).intent;
        const stat = perIntent.get(expected) ?? { correct: 0, total: 0 };
        stat.total++;
        if (got === expected) stat.correct++;
        perIntent.set(expected, stat);
      }
      const summary: Record<string, string> = {};
      for (const [intent, { correct, total }] of perIntent) {
        summary[intent] = `${correct}/${total} (${((correct / total) * 100).toFixed(0)}%)`;
      }

      console.log('[intent-classifier] gold-standard per-intent:', summary);
      // ambiguous intent must be detected on bare-token queries (this is the
      // class with the simplest signal); the others tolerate noise.
      expect(perIntent.get('ambiguous')?.correct).toBeGreaterThanOrEqual(
        Math.floor((perIntent.get('ambiguous')?.total ?? 0) * 0.6),
      );
    });
  });
});
