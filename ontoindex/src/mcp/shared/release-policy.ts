import type { PublicToolRegistryEntry } from './tool-registry.js';

export interface ReleaseRule {
  id: string;
  description: string;
  examples: {
    match: PublicToolRegistryEntry[];
    notMatch: PublicToolRegistryEntry[];
  };
  evaluate: (entries: PublicToolRegistryEntry[]) => {
    status: 'pass' | 'fail';
    violations: string[];
  };
}

/** Rule: Stable tools must have structuredOutput enabled if they are not gn_help or gn_quality_mode. */
export const STRUCTURED_OUTPUT_RULE: ReleaseRule = {
  id: 'stable-structured-output',
  description: 'Stable tools (except help/quality) must support structured output.',
  examples: {
    match: [
      {
        name: 'gn_explore',
        kind: 'super',
        contractStatus: 'stable',
        structuredOutput: true,
      } as any,
    ],
    notMatch: [
      {
        name: 'gn_some_new_tool',
        kind: 'super',
        contractStatus: 'stable',
        structuredOutput: false,
      } as any,
    ],
  },
  evaluate: (entries) => {
    const violations: string[] = [];
    for (const entry of entries) {
      if (
        entry.contractStatus === 'stable' &&
        ![
          'gn_help',
          'gn_quality_mode',
          'discover',
          'refactor',
          'manage',
          'gn_safe_refactor',
        ].includes(entry.name) &&
        !entry.structuredOutput
      ) {
        violations.push(`Tool "${entry.name}" is stable but lacks structuredOutput support.`);
      }
    }
    return {
      status: violations.length === 0 ? 'pass' : 'fail',
      violations,
    };
  },
};

/** Rule: Experimental tools must not be discoverable in 'query-projects' mode. */
export const EXPERIMENTAL_ISOLATION_RULE: ReleaseRule = {
  id: 'experimental-isolation',
  description: 'Experimental tools should not be in query-projects mode.',
  examples: {
    match: [
      {
        name: 'gn_exp_tool',
        kind: 'super',
        contractStatus: 'experimental',
        modes: ['general'],
      } as any,
    ],
    notMatch: [
      {
        name: 'gn_exp_tool',
        kind: 'super',
        contractStatus: 'experimental',
        modes: ['query-projects'],
      } as any,
    ],
  },
  evaluate: (entries) => {
    const violations: string[] = [];
    for (const entry of entries) {
      if (entry.contractStatus === 'experimental' && entry.modes.includes('query-projects')) {
        violations.push(
          `Experimental tool "${entry.name}" is discoverable in query-projects mode.`,
        );
      }
    }
    return {
      status: violations.length === 0 ? 'pass' : 'fail',
      violations,
    };
  },
};

export const RELEASE_POLICIES = [STRUCTURED_OUTPUT_RULE, EXPERIMENTAL_ISOLATION_RULE];
