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
  });

  describe('appendIndexCapabilityWarnings', () => {
    it('appends warnings to existing object', () => {
      const result = appendIndexCapabilityWarnings({ data: 'ok' }, ['WARNING: degraded']);
      expect(result).toEqual({ data: 'ok', warnings: ['WARNING: degraded'] });
    });
  });
});
