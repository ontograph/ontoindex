import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/audit/requirements-trace.js', () => ({
  auditRequirementsTrace: vi.fn(),
}));

import { auditRequirementsTrace } from '../../src/audit/requirements-trace.js';
import { runRequirementsTrace } from '../../src/mcp/local/backend-requirements-trace.js';

const auditMock = auditRequirementsTrace as unknown as ReturnType<typeof vi.fn>;

function makeRepo(): any {
  return {
    id: 'req-trace-test',
    name: 'req-trace-test',
    repoPath: '/tmp/req-trace-test',
  };
}

describe('requirements_trace', () => {
  beforeEach(() => {
    auditMock.mockReset();
  });

  it('applies default id_pattern when none is provided', async () => {
    auditMock.mockResolvedValue({ summary: 'Traced 0 requirements', items: [] });
    const repo = makeRepo();
    const result = await runRequirementsTrace(repo, {});
    expect(result.status).toBe('success');
    expect(result.id_pattern).toBe('[A-Z]{2,}-\\d+');
    expect(auditMock).toHaveBeenCalledWith({
      repoId: 'req-trace-test',
      repoPath: '/tmp/req-trace-test',
      ids: undefined,
      idPattern: '[A-Z]{2,}-\\d+',
    });
    expect(result.ids_requested).toBeNull();
  });

  it('passes explicit ids through and reports them in the response', async () => {
    auditMock.mockResolvedValue({
      summary: 'Traced 2 requirements',
      items: [
        {
          id: 'REQ-001',
          status: 'implemented',
          confidence: 'high',
          evidence: ['src/foo.ts:42'],
        },
        { id: 'REQ-002', status: 'missing', confidence: 'high', evidence: [] },
      ],
    });
    const repo = makeRepo();
    const result = await runRequirementsTrace(repo, { ids: ['REQ-001', 'REQ-002'] });
    expect(result.status).toBe('success');
    expect(result.item_count).toBe(2);
    expect(result.ids_requested).toEqual(['REQ-001', 'REQ-002']);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['REQ-001', 'REQ-002'] }),
    );
  });

  it('filters blank ids and falls back to discovery mode when none remain', async () => {
    auditMock.mockResolvedValue({ summary: 'Traced 0 requirements', items: [] });
    const repo = makeRepo();
    const result = await runRequirementsTrace(repo, { ids: ['', '   '] });
    expect(result.status).toBe('success');
    expect(result.ids_requested).toBeNull();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ ids: undefined }));
  });

  it('honors a custom id_pattern', async () => {
    auditMock.mockResolvedValue({ summary: 'Traced 1 requirements', items: [] });
    const repo = makeRepo();
    const result = await runRequirementsTrace(repo, { id_pattern: 'TICKET-\\d+' });
    expect(result.id_pattern).toBe('TICKET-\\d+');
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ idPattern: 'TICKET-\\d+' }));
  });

  it('returns an error response when the audit engine throws', async () => {
    auditMock.mockRejectedValue(new Error('walk failed'));
    const repo = makeRepo();
    const result = await runRequirementsTrace(repo, {});
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/walk failed/);
    expect(result.items).toEqual([]);
  });
});
