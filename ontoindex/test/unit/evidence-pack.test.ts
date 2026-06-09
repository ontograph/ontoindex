import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runEvidencePack } from '../../src/mcp/local/backend-evidence-pack.js';

describe('evidence_pack', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-evpack-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, 'src', 'auth.ts'),
      [
        'export function login(user: string) {',
        '  const token = issueToken(user);',
        '  return token;',
        '}',
        '',
        'function issueToken(user: string) {',
        '  return `tok:${user}`;',
        '}',
      ].join('\n'),
      'utf8',
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves path:line targets with context', async () => {
    // Use a repo.id that is not in the pool so the DB-backed symbol lookup
    // fails gracefully and does not pollute line/file resolution.
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['src/auth.ts:2'],
      context_lines: 1,
    });
    expect(result.status).toBe('success');
    expect(result.resolved_count).toBe(1);
    const hit = result.evidence[0];
    expect(hit.kind).toBe('line');
    expect(hit.file).toBe(path.join('src', 'auth.ts'));
    // Line 2 with 1 line of context => lines 1..3.
    expect(hit.start_line).toBe(1);
    expect(hit.end_line).toBe(3);
    expect(hit.snippet).toContain('issueToken(user)');
  });

  it('resolves file-only targets with a leading window', async () => {
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['src/auth.ts'],
      context_lines: 5,
    });
    expect(result.status).toBe('success');
    expect(result.resolved_count).toBe(1);
    const hit = result.evidence[0];
    expect(hit.kind).toBe('file');
    expect(hit.start_line).toBe(1);
    expect(hit.snippet).toContain('export function login');
  });

  it('omits snippet when include_snippet=false', async () => {
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['src/auth.ts:1'],
      include_snippet: false,
    });
    expect(result.status).toBe('success');
    expect(result.evidence[0].snippet).toBeUndefined();
    expect(result.evidence[0].start_line).toBe(1);
    expect(result.evidence[0].end_line).toBe(1);
  });

  it('marks unknown symbols as unresolved', async () => {
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['notASymbolInAnyRepo_xyz_999'],
    });
    expect(result.status).toBe('success');
    expect(result.resolved_count).toBe(0);
    expect(result.unresolved_count).toBe(1);
    expect(result.unresolved[0].target).toBe('notASymbolInAnyRepo_xyz_999');
  });

  it('rejects targets that escape the repo root', async () => {
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['../../etc/passwd'],
    });
    expect(result.status).toBe('success');
    expect(result.resolved_count).toBe(0);
    expect(result.unresolved_count).toBe(1);
  });

  it('handles mix of resolved + unresolved', async () => {
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['src/auth.ts:6', 'missing.ts', 'src/auth.ts'],
    });
    expect(result.status).toBe('success');
    expect(result.target_count).toBe(3);
    expect(result.resolved_count).toBe(2);
    expect(result.unresolved_count).toBe(1);
    const kinds = result.evidence.map((e) => e.kind).sort();
    expect(kinds).toEqual(['file', 'line']);
  });

  it('clamps negative context_lines to zero', async () => {
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['src/auth.ts:3'],
      context_lines: -5,
    });
    expect(result.status).toBe('success');
    expect(result.evidence[0].start_line).toBe(3);
    expect(result.evidence[0].end_line).toBe(3);
  });
});
