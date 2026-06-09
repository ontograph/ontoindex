import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/audit/verification-gap.js', () => ({
  auditVerificationGap: vi.fn(),
}));

import { auditVerificationGap } from '../../src/audit/verification-gap.js';
import { runVerificationGap } from '../../src/mcp/local/backend-verification-gap.js';

const auditMock = auditVerificationGap as unknown as ReturnType<typeof vi.fn>;

function makeRepo(): any {
  return {
    id: 'verif-gap-test',
    name: 'verif-gap-test',
    repoPath: '/tmp/verif-gap-test',
  };
}

describe('verification_gap', () => {
  beforeEach(() => {
    auditMock.mockReset();
  });

  it('applies default base_ref HEAD~1 when none is provided', async () => {
    auditMock.mockResolvedValue({ summary: 'nothing changed', coverage: [] });
    const repo = makeRepo();
    const result = await runVerificationGap(repo, {});
    expect(result.status).toBe('success');
    expect(result.base_ref).toBe('HEAD~1');
    expect(auditMock).toHaveBeenCalledWith({
      repoId: 'verif-gap-test',
      repoPath: '/tmp/verif-gap-test',
      baseRef: 'HEAD~1',
    });
  });

  it('honors an explicit base_ref', async () => {
    auditMock.mockResolvedValue({ summary: 'nothing', coverage: [] });
    const repo = makeRepo();
    const result = await runVerificationGap(repo, { base_ref: 'main' });
    expect(result.base_ref).toBe('main');
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'main' }));
  });

  it('summarises coverage and counts uncovered files', async () => {
    auditMock.mockResolvedValue({
      summary: 'Detected 2 changed files without test coverage',
      coverage: [
        { file: 'src/a.ts', status: 'covered', gap: 'Verified by graph trace' },
        { file: 'src/b.ts', status: 'uncovered', gap: 'No matching test' },
        { file: 'src/c.ts', status: 'weakly_covered', gap: 'Test file exists' },
        { file: 'src/d.ts', status: 'uncovered', gap: 'No matching test' },
      ],
    });
    const repo = makeRepo();
    const result = await runVerificationGap(repo, {});
    expect(result.status).toBe('success');
    expect(result.coverage).toHaveLength(4);
    expect(result.uncovered_count).toBe(2);
    expect(result.summary).toMatch(/2 changed files/);
  });

  it('returns an empty-success structure when no files changed', async () => {
    auditMock.mockResolvedValue({
      summary: 'All changed files have some level of test coverage',
      coverage: [],
    });
    const repo = makeRepo();
    const result = await runVerificationGap(repo, {});
    expect(result.status).toBe('success');
    expect(result.coverage).toEqual([]);
    expect(result.uncovered_count).toBe(0);
  });

  it('returns an error response when the audit engine throws', async () => {
    auditMock.mockRejectedValue(new Error('git ref unknown'));
    const repo = makeRepo();
    const result = await runVerificationGap(repo, { base_ref: 'nope' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/git ref unknown/);
    expect(result.coverage).toEqual([]);
  });
});
