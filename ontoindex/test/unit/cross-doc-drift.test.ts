import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runCrossDocDrift } from '../../src/mcp/local/backend-cross-doc-drift.js';

describe('cross_doc_drift', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-xdoc-'));
    await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'audit'), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, 'docs', 'plan.md'),
      [
        '# Plan',
        '',
        '- [x] T-1.2.03 login validation — done',
        '- [x] T-1.2.04 another task resolved',
        '- [ ] T-1.2.05 still being worked on',
        '- T-2.0.01: completed ✅',
        '- Progress note: REQ-001 is fixed as of today',
        '',
      ].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(tmpDir, 'audit', 'current.json'),
      JSON.stringify(
        [
          { id: 'T-1.2.03', status: 'open' }, // drift: plan done, audit open
          { id: 'T-1.2.04', status: 'done' }, // not drift: both closed
          { id: 'T-2.0.01', status: 'in_progress' }, // drift: plan done, audit open
          { id: 'REQ-001', status: 'resolved' }, // not drift
          { id: 'T-9.9.99', status: 'open' }, // not drift (not mentioned in plan)
          { id: 'T-3.0.01' }, // drift if referenced as done somewhere
        ],
        null,
        2,
      ),
      'utf8',
    );

    await fs.writeFile(
      path.join(tmpDir, 'audit', 'nested.json'),
      JSON.stringify({
        findings: [
          { task_id: 'T-5.0.01', status: 'unresolved' }, // referenced as done below
        ],
      }),
      'utf8',
    );

    await fs.writeFile(
      path.join(tmpDir, 'docs', 'status.md'),
      'T-5.0.01 was marked done last sprint.\n',
      'utf8',
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports drift when plan claims done but audit shows open', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runCrossDocDrift(repo, {});
    expect(result.status).toBe('success');
    expect(result.plan_files_scanned.length).toBeGreaterThanOrEqual(2);
    expect(result.audit_files_scanned.length).toBeGreaterThanOrEqual(2);

    const byId = new Map<string, (typeof result.drifts)[number]>();
    for (const d of result.drifts) byId.set(d.id, d);

    // Plan-done + audit-open combinations:
    expect(byId.has('T-1.2.03')).toBe(true);
    expect(byId.get('T-1.2.03')!.audit_status).toBe('open');
    expect(byId.has('T-2.0.01')).toBe(true);
    expect(byId.get('T-2.0.01')!.audit_status).toBe('in_progress');
    expect(byId.has('T-5.0.01')).toBe(true);
    expect(byId.get('T-5.0.01')!.audit_status).toBe('unresolved');

    // Already-closed findings must not appear:
    expect(byId.has('T-1.2.04')).toBe(false);
    expect(byId.has('REQ-001')).toBe(false);

    // Ids mentioned only in audit (not flagged done in any plan) must not drift:
    expect(byId.has('T-9.9.99')).toBe(false);
  });

  it('accepts explicit file lists and respects them', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runCrossDocDrift(repo, {
      plan_files: ['docs/plan.md'],
      audit_files: ['audit/current.json'],
    });
    expect(result.status).toBe('success');
    expect(result.plan_files_scanned.map((file) => file.replace(/\\/g, '/'))).toEqual([
      'docs/plan.md',
    ]);
    expect(result.audit_files_scanned.map((file) => file.replace(/\\/g, '/'))).toEqual([
      'audit/current.json',
    ]);
    // T-5.0.01 drift is only visible through nested.json + status.md,
    // which are excluded here — it must not appear.
    const ids = new Set(result.drifts.map((d) => d.id));
    expect(ids.has('T-5.0.01')).toBe(false);
    expect(ids.has('T-1.2.03')).toBe(true);
  });

  it('returns no drift when no ids overlap', async () => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-xdoc-iso-'));
    try {
      await fs.mkdir(path.join(isolated, 'docs'), { recursive: true });
      await fs.mkdir(path.join(isolated, 'audit'), { recursive: true });
      await fs.writeFile(path.join(isolated, 'docs', 'plan.md'), '- [x] T-1.0.01 done\n', 'utf8');
      await fs.writeFile(
        path.join(isolated, 'audit', 'a.json'),
        JSON.stringify([{ id: 'DIFFERENT-1', status: 'open' }]),
        'utf8',
      );
      const repo: any = { id: 'i', name: 'i', repoPath: isolated };
      const result = await runCrossDocDrift(repo, {});
      expect(result.status).toBe('success');
      expect(result.drift_count).toBe(0);
    } finally {
      await fs.rm(isolated, { recursive: true, force: true });
    }
  });

  it('handles missing default directories cleanly', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-xdoc-empty-'));
    try {
      const repo: any = { id: 'e', name: 'e', repoPath: empty };
      const result = await runCrossDocDrift(repo, {});
      expect(result.status).toBe('success');
      expect(result.plan_files_scanned).toEqual([]);
      expect(result.audit_files_scanned).toEqual([]);
      expect(result.drift_count).toBe(0);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it('rejects path-escaping inputs', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runCrossDocDrift(repo, {
      plan_files: ['../../etc/passwd'],
      audit_files: ['../outside.json'],
    });
    expect(result.status).toBe('success');
    // Escaped paths are silently dropped, resulting in empty scan lists.
    expect(result.plan_files_scanned).toEqual([]);
    expect(result.audit_files_scanned).toEqual([]);
    expect(result.drift_count).toBe(0);
  });

  it('preserves template interpolation behavior for Symbol error messages', async () => {
    const symbolic = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-xdoc-symbol-'));
    try {
      await fs.mkdir(path.join(symbolic, 'docs'), { recursive: true });
      await fs.writeFile(path.join(symbolic, 'docs', 'plan.md'), '- [x] T-1 done\n', 'utf8');

      const thrown = { message: Symbol('xdoc') };
      const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValueOnce({
        split: () => {
          throw thrown;
        },
      } as unknown as string);
      try {
        const repo = { id: 's', name: 's', repoPath: symbolic };
        await expect(
          runCrossDocDrift(repo, {
            plan_files: ['docs/plan.md'],
          }),
        ).rejects.toThrow(TypeError);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      await fs.rm(symbolic, { recursive: true, force: true });
    }
  });

  it('caps plan collection by total mentions, not unique ids', async () => {
    const capped = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-xdoc-plan-cap-'));
    try {
      await fs.mkdir(path.join(capped, 'docs'), { recursive: true });
      await fs.mkdir(path.join(capped, 'audit'), { recursive: true });
      const repeatedMentions = Array.from({ length: 10_000 }, () => '- [x] T-1 done').join('\n');
      await fs.writeFile(path.join(capped, 'docs', 'p1.md'), repeatedMentions, 'utf8');
      await fs.writeFile(path.join(capped, 'docs', 'p2.md'), repeatedMentions, 'utf8');
      await fs.writeFile(path.join(capped, 'docs', 'p3.md'), repeatedMentions, 'utf8');
      await fs.writeFile(
        path.join(capped, 'audit', 'a.json'),
        JSON.stringify([{ id: 'T-1', status: 'open' }]),
        'utf8',
      );

      const readSpy = vi.spyOn(fs, 'readFile');
      try {
        const repo: any = { id: 'p', name: 'p', repoPath: capped };
        const result = await runCrossDocDrift(repo, {
          plan_files: ['docs/p1.md', 'docs/p2.md', 'docs/p3.md'],
          audit_files: ['audit/a.json'],
        });
        expect(result.status).toBe('success');
        expect(result.drift_count).toBe(1);

        const p3Reads = readSpy.mock.calls.filter((call) =>
          String(call[0]).endsWith(path.join('docs', 'p3.md')),
        );
        expect(p3Reads).toHaveLength(0);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      await fs.rm(capped, { recursive: true, force: true });
    }
  });

  it('caps audit collection by total records, not unique ids', async () => {
    const capped = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-xdoc-audit-cap-'));
    try {
      await fs.mkdir(path.join(capped, 'docs'), { recursive: true });
      await fs.mkdir(path.join(capped, 'audit'), { recursive: true });
      await fs.writeFile(path.join(capped, 'docs', 'plan.md'), '- [x] T-2 done\n', 'utf8');
      const repeatedRecords = Array.from({ length: 50_000 }, () => ({
        id: 'T-2',
        status: 'open',
      }));
      await fs.writeFile(
        path.join(capped, 'audit', 'a1.json'),
        JSON.stringify(repeatedRecords),
        'utf8',
      );
      await fs.writeFile(
        path.join(capped, 'audit', 'a2.json'),
        JSON.stringify([{ id: 'T-2', status: 'open' }]),
        'utf8',
      );

      const readSpy = vi.spyOn(fs, 'readFile');
      try {
        const repo: any = { id: 'a', name: 'a', repoPath: capped };
        const result = await runCrossDocDrift(repo, {
          plan_files: ['docs/plan.md'],
          audit_files: ['audit/a1.json', 'audit/a2.json'],
        });
        expect(result.status).toBe('success');
        expect(result.drift_count).toBe(20_000);

        const a2Reads = readSpy.mock.calls.filter((call) =>
          String(call[0]).endsWith(path.join('audit', 'a2.json')),
        );
        expect(a2Reads).toHaveLength(0);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      await fs.rm(capped, { recursive: true, force: true });
    }
  });
});
