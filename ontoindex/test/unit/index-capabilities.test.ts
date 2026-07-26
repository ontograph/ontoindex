import { describe, it, expect } from 'vitest';
import {
  formatIndexCapabilityWarnings,
  appendIndexCapabilityWarnings,
} from '../../src/storage/index-capabilities.js';

describe('index-capabilities', () => {
  describe('formatIndexCapabilityWarnings', () => {
    it('returns empty array when fully capable', () => {
      const result = formatIndexCapabilityWarnings({ indexMode: 'full' } as any);
      expect(result).toEqual([]);
    });

    it('returns warnings when degraded', () => {
      const result = formatIndexCapabilityWarnings({ indexMode: 'symbols-only' } as any);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBe('WARNING: index capabilities are degraded.');
    });

    it('returns warnings for huge-repo-symbols profile', () => {
      const result = formatIndexCapabilityWarnings({ pipelineProfile: 'huge-repo-symbols' } as any);
      expect(result).toContain('WARNING: index capabilities are degraded.');
      expect(result).toContain('  Profile: huge-repo-symbols (deep enrichment skipped)');
    });

    it('formats degradedFileAggregates with cause, phase, language, and sampled counts', () => {
      const result = formatIndexCapabilityWarnings({
        indexMode: 'symbols-only',
        degradedFileAggregates: {
          sampledDegradedCount: 5,
          groups: [
            { cause: 'file exceeds cap', phase: 'parse', language: 'python', count: 3 },
            { cause: 'file exceeds cap', phase: 'parse', language: 'unknown', count: 2 },
          ],
          omittedGroupCount: 0,
        },
      } as any);
      expect(result).toContain('  Degraded files (sampled): 5');
      expect(result).toContain('    - file exceeds cap [phase: parse, lang: python]: 3');
      expect(result).toContain('    - file exceeds cap [phase: parse, lang: unknown]: 2');
    });

    it('reports omitted degraded groups when the top-N bound truncates', () => {
      const result = formatIndexCapabilityWarnings({
        indexMode: 'symbols-only',
        degradedFileAggregates: {
          sampledDegradedCount: 9,
          groups: [{ cause: 'file exceeds cap', phase: 'parse', language: 'python', count: 4 }],
          omittedGroupCount: 2,
        },
      } as any);
      expect(result).toContain('  Degraded files (sampled): 9');
      expect(result).toContain('    - (+2 more group(s) omitted)');
    });

    it('falls back to legacy degradedFiles count without aggregates', () => {
      const result = formatIndexCapabilityWarnings({
        indexMode: 'symbols-only',
        degradedFiles: [
          { filePath: 'a.py', reason: 'skipped' },
          { filePath: 'b.py', reason: 'skipped' },
        ],
      } as any);
      expect(result).toContain('  Degraded files: 2');
      expect(result.some((line) => line.includes('sampled'))).toBe(false);
    });
  });

  describe('appendIndexCapabilityWarnings', () => {
    it('appends warnings to existing object', () => {
      const result = appendIndexCapabilityWarnings({ data: 'ok' }, ['WARNING: degraded']);
      expect(result).toEqual({ data: 'ok', warnings: ['WARNING: degraded'] });
    });
  });
});
