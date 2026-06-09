import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runBuildResidueAudit } from '../../src/mcp/local/backend-build-residue.js';

describe('build_residue_audit', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-residue-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'vendor'), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, 'src', 'app.ts'),
      ['// TODO: remove this before shipping', 'export function doWork() { return 1; }'].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(tmpDir, 'dist', 'bundle.js'),
      ['var a=1;', 'debugger;', 'var b=2;'].join('\n'),
      'utf8',
    );

    // node_modules is always skipped.
    await fs.writeFile(
      path.join(tmpDir, 'node_modules', 'vendor', 'lib.js'),
      "console.log('library debug — not our problem');\n",
      'utf8',
    );

    await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'tmp'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'test', 'unit'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'docs', 'notes.md'), 'FIXME: docs noise\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'tmp', 'scratch.txt'), 'TODO: tmp noise\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'test', 'unit', 'sample.test.ts'),
      'TODO: test noise\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'package-lock.json'),
      '{"note":"TODO: lock noise"}\n',
      'utf8',
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults find debug residue in source and build output, skip node_modules', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runBuildResidueAudit(repo, {});
    expect(result.status).toBe('success');
    expect(result.domains_scanned).toContain('TODO:');
    expect(result.domains_scanned).toContain('debugger;');

    const files = new Set(result.findings.map((f) => f.file));
    // Ensure vendor lib under node_modules is not in the report.
    for (const file of files) {
      expect(file.includes('node_modules')).toBe(false);
    }

    // Must have at least one build_output match (dist/bundle.js) and at
    // least one source match (src/app.ts).
    expect(result.build_output_matches).toBeGreaterThanOrEqual(1);
    expect(result.source_matches).toBeGreaterThanOrEqual(1);

    const bundleHit = result.findings.find((f) => f.file === path.join('dist', 'bundle.js'));
    expect(bundleHit).toBeDefined();
    expect(bundleHit!.is_build_output).toBe(true);
    expect(bundleHit!.domain).toBe('debugger;');

    const findingsText = result.findings.map((f) => f.file).join('\n');
    expect(findingsText).not.toContain(path.join('docs', 'notes.md'));
    expect(findingsText).not.toContain(path.join('tmp', 'scratch.txt'));
    expect(findingsText).not.toContain(path.join('test', 'unit', 'sample.test.ts'));
    expect(findingsText).not.toContain('package-lock.json');
  });

  it('honours caller-supplied forbidden_domains (overrides default)', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runBuildResidueAudit(repo, {
      forbidden_domains: ['doWork'],
    });
    expect(result.status).toBe('success');
    expect(result.domains_scanned).toEqual(['doWork']);
    // "doWork" only appears in src/app.ts.
    expect(result.finding_count).toBeGreaterThanOrEqual(1);
    for (const f of result.findings) {
      expect(f.domain).toBe('doWork');
    }
  });

  it('still scans doc-like files when explicitly asked via extension-bearing code files only', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runBuildResidueAudit(repo, {
      forbidden_domains: ['debugger;'],
    });
    expect(result.status).toBe('success');
    expect(result.findings.some((f) => f.file === path.join('dist', 'bundle.js'))).toBe(true);
  });

  it('includes test files when the caller explicitly supplies domains', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runBuildResidueAudit(repo, {
      forbidden_domains: ['TODO:'],
    });
    expect(result.status).toBe('success');
    expect(
      result.findings.some((f) => f.file === path.join('test', 'unit', 'sample.test.ts')),
    ).toBe(true);
  });

  it('is case-insensitive', async () => {
    const repo: any = { id: 't', name: 't', repoPath: tmpDir };
    const result = await runBuildResidueAudit(repo, {
      // Supplied as uppercase but src/app.ts has "dowork" only at the
      // exact case "doWork" — ensure we still match regardless.
      forbidden_domains: ['DOWORK'],
    });
    expect(result.status).toBe('success');
    expect(result.finding_count).toBeGreaterThanOrEqual(1);
  });

  it('returns zero findings on a clean tree', async () => {
    const cleanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-residue-clean-'));
    try {
      await fs.writeFile(path.join(cleanDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
      const repo: any = { id: 'c', name: 'c', repoPath: cleanDir };
      const result = await runBuildResidueAudit(repo, {});
      expect(result.status).toBe('success');
      expect(result.finding_count).toBe(0);
      expect(result.build_output_matches).toBe(0);
      expect(result.source_matches).toBe(0);
    } finally {
      await fs.rm(cleanDir, { recursive: true, force: true });
    }
  });
});
