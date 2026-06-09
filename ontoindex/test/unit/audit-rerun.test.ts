import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runAuditRerun } from '../../src/mcp/local/backend-audit-rerun.js';

describe('audit_rerun', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-audit-rerun-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'audits'), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, 'src', 'same.ts'),
      ['const a = 1;', 'node.addEventListener("c", h);', 'const b = 2;'].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'moved.ts'),
      // Pattern now lives on line 3 instead of the recorded line 1.
      ['const x = 1;', 'const y = 2;', 'node.addEventListener("m", h);'].join('\n'),
      'utf8',
    );
    await fs.writeFile(path.join(tmpDir, 'src', 'fixed.ts'), 'const z = 42;\n', 'utf8');

    const audit = {
      version: '1.0',
      name: 'demo',
      findings: [
        {
          id: 'F1',
          pattern: 'addEventListener',
          file: 'src/same.ts',
          line: 2,
          snippet: 'node.addEventListener("c", h);',
        },
        {
          id: 'F2',
          pattern: 'addEventListener',
          file: 'src/moved.ts',
          line: 1,
          snippet: 'node.addEventListener("m", h);',
        },
        {
          id: 'F3',
          pattern: 'addEventListener',
          file: 'src/fixed.ts',
          line: 1,
          snippet: 'node.addEventListener("f", h);',
        },
        {
          id: 'F4',
          pattern: 'addEventListener',
          file: 'src/missing.ts',
          line: 7,
          snippet: 'node.addEventListener("x", h);',
        },
        { id: 'F5', pattern: 'something' }, // invalid — no file
      ],
    };
    await fs.writeFile(
      path.join(tmpDir, 'audits', 'demo.json'),
      JSON.stringify(audit, null, 2),
      'utf8',
    );

    // Bare-array form also supported.
    await fs.writeFile(
      path.join(tmpDir, 'audits', 'bare.json'),
      JSON.stringify([
        {
          id: 'B1',
          pattern: 'addEventListener',
          file: 'src/same.ts',
          line: 2,
          snippet: 'node.addEventListener("c", h);',
        },
      ]),
      'utf8',
    );

    await fs.writeFile(path.join(tmpDir, 'audits', 'broken.json'), '{not json', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('classifies still_open, moved, fixed, missing_file, invalid', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runAuditRerun(repo, { audit_file: 'audits/demo.json' });
    expect(result.status).toBe('success');
    expect(result.total).toBe(5);
    expect(result.still_open).toBe(1);
    expect(result.moved).toBe(1);
    expect(result.fixed).toBe(1);
    expect(result.missing_file).toBe(1);
    expect(result.invalid).toBe(1);

    const byId = new Map<string, any>();
    for (const r of result.findings!) byId.set(r.id!, r);
    expect(byId.get('F1')!.status).toBe('still_open');
    expect(byId.get('F1')!.current_line).toBe(2);
    expect(byId.get('F2')!.status).toBe('moved');
    expect(byId.get('F2')!.current_line).toBe(3);
    expect(byId.get('F3')!.status).toBe('fixed');
    expect(byId.get('F4')!.status).toBe('missing_file');
    expect(byId.get('F5')!.status).toBe('invalid');
  });

  it('accepts a bare JSON array of findings', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runAuditRerun(repo, { audit_file: 'audits/bare.json' });
    expect(result.status).toBe('success');
    expect(result.total).toBe(1);
    expect(result.still_open).toBe(1);
  });

  it('reports broken JSON as a structured error', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runAuditRerun(repo, { audit_file: 'audits/broken.json' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not valid json/i);
  });

  it('rejects audit_file that escapes the repo root', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runAuditRerun(repo, { audit_file: '../outside.json' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/inside the indexed repo/i);
  });

  it('requires audit_file param', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runAuditRerun(repo, {} as any);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/audit_file.*required/i);
  });
});
