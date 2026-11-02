import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runEvidencePack } from '../../src/mcp/local/backend-evidence-pack.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';

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
    expect(hit.file).toBe('src/auth.ts');
    expect(hit.file).not.toContain('\\');
    // Line 2 with 1 line of context => lines 1..3.
    expect(hit.start_line).toBe(1);
    expect(hit.end_line).toBe(3);
    expect(hit.snippet).toContain('issueToken(user)');
  });

  it.each([false, true])(
    'converts graph coordinates before snippet extraction (snippet=%s)',
    async (includeSnippet) => {
      const lookup = vi.spyOn(pool, 'executeParameterized').mockResolvedValueOnce([
        {
          name: 'issueToken',
          type: 'Function',
          filePath: 'src/auth.ts',
          startLine: 5,
          endLine: 7,
        },
      ]);
      try {
        const result = await runEvidencePack(
          { id: 'mock', name: 't', repoPath: tmpDir },
          {
            targets: ['issueToken'],
            context_lines: 0,
            include_snippet: includeSnippet,
          },
        );
        expect(result.evidence[0]).toMatchObject({ start_line: 6, end_line: 8 });
        expect(result.evidence[0].snippet).toBe(
          includeSnippet
            ? 'function issueToken(user: string) {\n  return `tok:${user}`;\n}'
            : undefined,
        );
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it('preserves one-based Section graph coordinates', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.md'), '# Notes\nBody\n');
    const lookup = vi
      .spyOn(pool, 'executeParameterized')
      .mockResolvedValueOnce([
        { name: 'Notes', type: 'Section', filePath: 'notes.md', startLine: 1, endLine: 2 },
      ]);
    try {
      const result = await runEvidencePack(
        { id: 'mock', name: 't', repoPath: tmpDir },
        {
          targets: ['Notes'],
          context_lines: 0,
        },
      );
      expect(result.evidence[0]).toMatchObject({
        start_line: 1,
        end_line: 2,
        snippet: '# Notes\nBody',
      });
    } finally {
      lookup.mockRestore();
    }
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

  it('marks oversized files unresolved when snippets are omitted', async () => {
    const oversized = path.join(tmpDir, 'large.txt');
    await fs.writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 97));
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, {
      targets: ['large.txt'],
      include_snippet: false,
    });
    expect(result.status).toBe('success');
    expect(result.resolved_count).toBe(0);
    expect(result.unresolved_count).toBe(1);
    expect(result.unresolved[0].reason).toContain('1048576-byte evidence read limit');
  });

  it('marks oversized files unresolved when snippets are requested', async () => {
    const oversized = path.join(tmpDir, 'large-with-snippet.txt');
    await fs.writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 97));
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, { targets: ['large-with-snippet.txt'] });
    expect(result.resolved_count).toBe(0);
    expect(result.unresolved_count).toBe(1);
    expect(result.unresolved[0].reason).toContain('1048576-byte evidence read limit');
  });

  it('rejects requests exceeding the target limit', async () => {
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, { targets: Array(129).fill('missing.ts') });
    expect(result.status).toBe('error');
    expect(result.error).toContain('At most 128 evidence targets');
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

  it('does not resolve a file symlink that points outside the repo', async () => {
    const outside = path.join(path.dirname(tmpDir), 'gn-evpack-outside.ts');
    await fs.writeFile(outside, 'secret\n', 'utf8');
    await fs.symlink(outside, path.join(tmpDir, 'outside-link.ts'));
    const repo: any = { id: 'not-initialized', name: 't', repoPath: tmpDir };
    const result = await runEvidencePack(repo, { targets: ['outside-link.ts'] });
    expect(result.resolved_count).toBe(0);
    expect(result.unresolved_count).toBe(1);
    await fs.rm(outside, { force: true });
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
