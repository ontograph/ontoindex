import { describe, it, expect } from 'vitest';
import { gnToolContract } from '../../../src/mcp/super/tool-contract.js';

describe('gnToolContract — release policies', () => {
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
