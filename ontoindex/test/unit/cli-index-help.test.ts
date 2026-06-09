import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeCommand,
  resolveAnalyzeIncludePaths,
  resolveAnalyzePipelineProfile,
} from '../../src/cli/analyze.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: vi.fn(),
}));

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');

function runHelp(command: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, command, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runAnalyze(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, 'analyze', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
}

function initTempGitRepo(repoPath: string) {
  const result = spawnSync('git', ['init', '--quiet'], {
    cwd: repoPath,
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
}

describe('CLI help surface', () => {
  afterEach(() => {
    vi.mocked(runFullAnalysis).mockReset();
    process.exitCode = undefined;
  });

  it('analyze help exposes symbols-only mode', () => {
    const result = runHelp('analyze');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--symbols-only');
    expect(result.stdout).toContain('--huge-repo');
    expect(result.stdout).toContain('--allow-huge-root');
    expect(result.stdout).toContain('--include-path <path>');
  });

  it('maps the symbols-only analyze option to the symbols pipeline profile', () => {
    expect(resolveAnalyzePipelineProfile({ symbolsOnly: true })).toBe('symbols');
    expect(resolveAnalyzePipelineProfile({ indexOnly: true })).toBe('symbols');
    expect(resolveAnalyzePipelineProfile({ symbolsOnly: false })).toBeUndefined();
    expect(resolveAnalyzePipelineProfile({ hugeRepo: true })).toBe('huge-repo-symbols');
  });

  it('preserves repeatable include-path values for analyze', () => {
    expect(resolveAnalyzeIncludePaths({ includePath: ['sc', 'svl/source/misc'] })).toEqual([
      'sc',
      'svl/source/misc',
    ]);
    expect(resolveAnalyzeIncludePaths({ includePath: [] })).toBeUndefined();
  });

  it('refuses --huge-repo root indexing without an include path or explicit override', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-huge-root-'));
    initTempGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'sample.ts'), 'export const sample = 1;\n');

    try {
      const result = runAnalyze([tmpDir, '--huge-repo']);

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        '--huge-repo requires at least one --include-path',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes scoped --huge-repo options through to analysis without requiring --allow-huge-root', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-huge-scoped-'));
    initTempGitRepo(tmpDir);
    const sourceDir = path.join(tmpDir, 'src');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'sample.ts'), 'export const sample = 1;\n');
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(runFullAnalysis).mockResolvedValue({
      repoName: 'temp',
      repoPath: tmpDir,
      stats: {},
      alreadyUpToDate: true,
    });
    process.env.NODE_OPTIONS = `${originalNodeOptions || ''} --max-old-space-size=8192`.trim();

    try {
      await analyzeCommand(tmpDir, {
        hugeRepo: true,
        includePath: ['src'],
        skipAgentsMd: true,
        noStats: true,
      });

      expect(process.exitCode).toBeUndefined();
      expect(runFullAnalysis).toHaveBeenCalledWith(
        tmpDir,
        expect.objectContaining({
          profile: 'huge-repo-symbols',
          includePaths: ['src'],
          skipAgentsMd: true,
          noStats: true,
        }),
        expect.objectContaining({
          onProgress: expect.any(Function),
          onLog: expect.any(Function),
        }),
      );
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions;
      }
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('query help keeps advanced search options without importing analyze deps', () => {
    const result = runHelp('query');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--context <text>');
    expect(result.stdout).toContain('--goal <text>');
    expect(result.stdout).toContain('--content');
    expect(result.stdout).toContain('--typed');
    expect(result.stdout).toContain('--consume-enrichment-facts');
    expect(result.stdout).toContain('--include-passive-related-facts');
    expect(result.stdout).toContain('--include-markdown-context');
    expect(result.stdout).toContain('--include-markdown-ppr');
    expect(result.stderr).not.toContain('tree-sitter-kotlin');
  });

  it('context help keeps optional name and disambiguation flags', () => {
    const result = runHelp('context');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('context [options] [name]');
    expect(result.stdout).toContain('--uid <uid>');
    expect(result.stdout).toContain('--file <path>');
  });

  it('impact help keeps repo and include-tests flags', () => {
    const result = runHelp('impact');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--depth <n>');
    expect(result.stdout).toContain('--include-tests');
    expect(result.stdout).toContain('--repo <name>');
  });

  it('detect-changes help exposes compare scope and base-ref flags', () => {
    const result = runHelp('detect-changes');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ontoindex detect-changes|detect_changes [options]');
    expect(result.stdout).toContain('--scope <scope>');
    expect(result.stdout).toContain('--base-ref <ref>');
    expect(result.stdout).toContain('--repo <name>');
  });

  it('wiki help shows provider, review, and verbose flags', () => {
    const result = runHelp('wiki');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--provider <provider>');
    expect(result.stdout).toContain('--review');
    expect(result.stdout).toContain('-v, --verbose');
    expect(result.stdout).toContain('--model <model>');
    expect(result.stdout).toContain('--gist');
  });

  it('memory help exposes source and force flags', () => {
    const result = runHelp('memory');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ontoindex memory [options] <name>');
    expect(result.stdout).toContain('--source <source>');
    expect(result.stdout).toContain('--force');
  });
});
