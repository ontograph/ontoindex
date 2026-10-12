import { describe, it, expect } from 'vitest';
import { gnToolContract } from '../../../src/mcp/super/tool-contract.js';
import { getPublicToolRegistry } from '../../../src/mcp/shared/tool-registry.js';

describe('gnToolContract — release policies', () => {
  it('marks scoped path observations advisory without audit authority', () => {
    const tool = getPublicToolRegistry().find((entry) => entry.name === 'gn_path_verify');
    expect(tool).toMatchObject({ advisoryOnly: true, auditAuthority: false });
  });
  it('surfaces release policy checks in structuralChecks', () => {
    const report = gnToolContract({ includeFacades: true });

    const policyChecks = report.structuralChecks.filter((check) =>
      check.check.startsWith('policy:'),
    );

    expect(policyChecks.map((check) => check.check)).toEqual(
      expect.arrayContaining(['policy:stable-structured-output', 'policy:experimental-isolation']),
    );

    expect(
      policyChecks.find((check) => check.check === 'policy:stable-structured-output')?.status,
    ).toBe('pass');
    expect(
      policyChecks.find((check) => check.check === 'policy:experimental-isolation')?.status,
    ).toBe('pass');
  });
});
