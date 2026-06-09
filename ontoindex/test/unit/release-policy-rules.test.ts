import { describe, it, expect } from 'vitest';
import {
  STRUCTURED_OUTPUT_RULE,
  EXPERIMENTAL_ISOLATION_RULE,
} from '../../src/mcp/shared/release-policy.js';
import type { PublicToolRegistryEntry } from '../../src/mcp/shared/tool-registry.js';

describe('release-policy — rules (Phase 4)', () => {
  describe('STRUCTURED_OUTPUT_RULE', () => {
    it('passes for stable tools with structured output', () => {
      const entry: Partial<PublicToolRegistryEntry> = {
        name: 'gn_explore',
        contractStatus: 'stable',
        structuredOutput: true,
      };
      const result = STRUCTURED_OUTPUT_RULE.evaluate([entry as any]);
      expect(result.status).toBe('pass');
    });

    it('fails for stable tools without structured output (except allowlist)', () => {
      const entry: Partial<PublicToolRegistryEntry> = {
        name: 'gn_some_new_tool',
        contractStatus: 'stable',
        structuredOutput: false,
      };
      const result = STRUCTURED_OUTPUT_RULE.evaluate([entry as any]);
      expect(result.status).toBe('fail');
      expect(result.violations[0]).toContain('lacks structuredOutput support');
    });

    it('passes for allowlisted tools without structured output', () => {
      const entry: Partial<PublicToolRegistryEntry> = {
        name: 'gn_help',
        contractStatus: 'stable',
        structuredOutput: false,
      };
      const result = STRUCTURED_OUTPUT_RULE.evaluate([entry as any]);
      expect(result.status).toBe('pass');
    });
  });

  describe('EXPERIMENTAL_ISOLATION_RULE', () => {
    it('passes for experimental tools not in query-projects mode', () => {
      const entry: Partial<PublicToolRegistryEntry> = {
        name: 'gn_exp_tool',
        contractStatus: 'experimental',
        modes: ['general'],
      };
      const result = EXPERIMENTAL_ISOLATION_RULE.evaluate([entry as any]);
      expect(result.status).toBe('pass');
    });

    it('fails for experimental tools in query-projects mode', () => {
      const entry: Partial<PublicToolRegistryEntry> = {
        name: 'gn_exp_tool',
        contractStatus: 'experimental',
        modes: ['query-projects'],
      };
      const result = EXPERIMENTAL_ISOLATION_RULE.evaluate([entry as any]);
      expect(result.status).toBe('fail');
      expect(result.violations[0]).toContain('discoverable in query-projects mode');
    });
  });
});
