/**
 * Regression Tests: Claude Code Hooks
 *
 * Tests the hook scripts (ontoindex-hook.cjs and ontoindex-hook.js) that run
 * as PreToolUse and PostToolUse hooks in Claude Code.
 *
 * Covers:
 * - extractPattern: pattern extraction from Grep/Glob/Bash tool inputs
 * - findOntoIndexDir: .ontoindex directory discovery
 * - handlePostToolUse: staleness detection after git mutations
 * - cwd validation: rejects relative paths (defense-in-depth)
 * - shell injection: verifies no shell: true in spawnSync calls
 * - dispatch map: correct handler routing
 * - cross-platform: Windows .cmd extension handling
 *
 * Since the hooks are CJS scripts that call main() on load, we test them
 * by spawning them as child processes with controlled stdin JSON.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import vm from 'vm';
import { runHook, parseHookOutput } from '../utils/hook-test-helpers.js';

// ─── Paths to both hook variants ────────────────────────────────────

const CJS_HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'ontoindex-hook.cjs');
const PLUGIN_HOOK = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'ontoindex-claude-plugin',
  'hooks',
  'ontoindex-hook.js',
);
const AUGMENT_COMMAND = path.resolve(__dirname, '..', '..', 'src', 'cli', 'augment.ts');
const AUGMENT_FRAME_START = '<<<ONTOINDEX_AUGMENTATION_V1>>>';
const AUGMENT_FRAME_END = '<<<END_ONTOINDEX_AUGMENTATION_V1>>>';

// ─── Test fixtures: temporary .ontoindex directory ───────────────────

let tmpDir: string;
let ontoIndexDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-hook-test-'));
  ontoIndexDir = path.join(tmpDir, '.ontoindex');
  fs.mkdirSync(ontoIndexDir, { recursive: true });

  // Initialize a bare git repo so git rev-parse HEAD works
  spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helper to get HEAD commit hash ─────────────────────────────────

function getHeadCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: tmpDir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return (result.stdout || '').trim();
}

// ─── Both hook files should exist ───────────────────────────────────

describe('Hook files exist', () => {
  it('CJS hook exists', () => {
    expect(fs.existsSync(CJS_HOOK)).toBe(true);
  });

  it('Plugin hook exists', () => {
    expect(fs.existsSync(PLUGIN_HOOK)).toBe(true);
  });
});

// ─── Source code regression: no shell: true ──────────────────────────

describe('Shell injection regression', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook has no shell: true in spawnSync calls`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      // Match spawnSync calls with shell option set to true or a variable
      // Allowed: comments mentioning shell: true, string literals
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments and string literals
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        // Check for shell: true or shell: isWin in actual code
        if (/shell:\s*(true|isWin)/.test(line)) {
          throw new Error(`${label} hook line ${i + 1} has shell injection risk: ${line.trim()}`);
        }
      }
    });
  }
});

// ─── Source code regression: .cmd extensions for Windows ─────────────

describe('Windows .cmd extension handling', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook uses the Windows installed binary without a package runner`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('ontoindex.cmd');
      expect(source).not.toContain('npx');
    });
  }

  it('Plugin hook uses .cmd extension for Windows ontoindex binary', () => {
    const source = fs.readFileSync(PLUGIN_HOOK, 'utf-8');
    expect(source).toContain('ontoindex.cmd');
  });
});

describe('Installed CLI PATH fallback', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    function loadRunner(platform: string, spawn: ReturnType<typeof vi.fn>) {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const start = source.indexOf('function runOntoIndexCli(');
      const end = source.indexOf('\n}\n', start) + 2;
      return vm.runInNewContext(`${source.slice(start, end)}\nrunOntoIndexCli`, {
        process: { platform, env: {}, execPath: process.execPath },
        spawnSync: spawn,
      }) as (...args: unknown[]) => unknown;
    }

    for (const [platform, binary] of [['linux', 'ontoindex'], ['win32', 'ontoindex.cmd']]) {
      it(`${label}: runs the PATH binary on ${platform} exactly once`, () => {
        const result = { status: 0, stderr: 'context' };
        const spawn = vi.fn().mockReturnValue(result);
        const runner = loadRunner(platform, spawn);
        const args = ['augment', '--', 'login'];
        expect(label === 'CJS' ? runner('', args, tmpDir, 1234) : runner(args, tmpDir, 1234)).toBe(result);
        expect(spawn).toHaveBeenCalledExactlyOnceWith(binary, args, {
          encoding: 'utf-8', timeout: 1234, cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'],
        });
      });
    }

    it(`${label}: returns a missing PATH binary failure without retrying`, () => {
      const result = { status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) };
      const spawn = vi.fn().mockReturnValue(result);
      const runner = loadRunner('linux', spawn);
      expect(label === 'CJS' ? runner('', [], tmpDir, 1234) : runner([], tmpDir, 1234)).toBe(result);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  }
});

// ─── Source code regression: cwd validation ─────────────────────────

describe('cwd validation guards', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook validates cwd is absolute path`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const cwdChecks = (source.match(/path\.isAbsolute\(cwd\)/g) || []).length;
      // Should have at least 2 checks (one in PreToolUse, one in PostToolUse)
      expect(cwdChecks).toBeGreaterThanOrEqual(2);
    });
  }
});

// ─── Source code regression: sendHookResponse used consistently ──────

describe('sendHookResponse consistency', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook uses sendHookResponse in both handlers`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const calls = (source.match(/sendHookResponse\(/g) || []).length;
      // At least 3: definition + PreToolUse call + PostToolUse call
      expect(calls).toBeGreaterThanOrEqual(3);
    });

    it(`${label} hook does not inline hookSpecificOutput JSON in handlers`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      // Count inline hookSpecificOutput usage (should only be in sendHookResponse definition)
      const inlineCount = (source.match(/hookSpecificOutput/g) || []).length;
      // Exactly 1 occurrence: inside the sendHookResponse function body
      expect(inlineCount).toBe(1);
    });
  }
});

// ─── Source code regression: dispatch map pattern ────────────────────

describe('Dispatch map pattern', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook uses dispatch map instead of if/else`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('const handlers = {');
      expect(source).toContain('PreToolUse: handlePreToolUse');
      expect(source).toContain('PostToolUse: handlePostToolUse');
      // Should NOT have if/else dispatch in main()
      expect(source).not.toMatch(/if\s*\(hookEvent\s*===\s*'PreToolUse'\)/);
    });
  }
});

// ─── Source code regression: debug error truncation ──────────────────

describe('Debug error message truncation', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook truncates error messages to 200 chars`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('.slice(0, 200)');
    });
  }
});

// ─── PreToolUse augment bounds ──────────────────────────────────────

describe('PreToolUse augment hardening', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook bounds all augment spawns with the configured timeout`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('ONTOINDEX_HOOK_AUGMENT_TIMEOUT_MS');
      expect(source).toContain("readIntEnv('ONTOINDEX_HOOK_AUGMENT_TIMEOUT_MS', 2000, 250, 10000)");
      expect(source).toContain('AUGMENT_TIMEOUT_MS');
      expect(source).not.toContain('timeout: timeout + 5000');
    });

    it(`${label} hook normalizes patterns before augmenting`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('function normalizePattern(pattern)');
      expect(source).toContain('trimmed.length < 3 || trimmed.length > 120');
      expect(source).toContain('/[\\r\\n]/.test(trimmed)');
      expect(source).toContain('normalizePattern(extractPattern(toolName, toolInput))');
    });

    it(`${label} hook uses a cooldown stamp and exclusive lock around augment`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('ONTOINDEX_HOOK_AUGMENT_COOLDOWN_MS');
      expect(source).toContain('ONTOINDEX_HOOK_AUGMENT_LOCK_STALE_MS');
      expect(source).toContain("fs.openSync(paths.lockPath, 'wx')");
      expect(source).toContain('fs.statSync(paths.stampPath)');
      expect(source).toContain('finishAugment(augmentLease)');
    });

    it(`${label} hook stores stamps in a private directory and prunes stale files hourly`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-hook-prune-test-'));
      try {
        const dir = path.join(root, 'ontoindex-hook-augment');
        fs.mkdirSync(dir, { mode: 0o700 });
        const stale = path.join(dir, `ontoindex-hook-augment-${'a'.repeat(24)}.stamp`);
        const legacy = path.join(root, `ontoindex-hook-augment-${'b'.repeat(24)}.lock`);
        const recent = path.join(dir, `ontoindex-hook-augment-${'c'.repeat(24)}.lock`);
        const unrelated = path.join(root, 'unrelated.stamp');
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
        for (const file of [stale, legacy, unrelated]) {
          fs.writeFileSync(file, '');
          fs.utimesSync(file, old, old);
        }
        fs.writeFileSync(recent, '');
        const source = fs.readFileSync(hookPath, 'utf-8');
        const functions = source.slice(
          source.indexOf('function augmentPaths('),
          source.indexOf('function beginAugment('),
        );
        const augmentPaths = vm.runInNewContext(`${functions}\naugmentPaths`, {
          fs, path, crypto, os: { tmpdir: () => root },
        }) as (cwd: string, pattern: string) => { stampPath: string; lockPath: string };

        const paths = augmentPaths(root, 'pattern');
        expect(path.dirname(paths.stampPath)).toBe(dir);
        expect(path.dirname(paths.lockPath)).toBe(dir);
        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(legacy)).toBe(false);
        expect(fs.existsSync(recent)).toBe(true);
        expect(fs.existsSync(unrelated)).toBe(true);

        fs.writeFileSync(stale, '');
        fs.utimesSync(stale, old, old);
        augmentPaths(root, 'another-pattern');
        expect(fs.existsSync(stale)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it(`${label} hook releases augment lock in a finally block`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toMatch(
        /try\s*\{[\s\S]*runOntoIndexCli[\s\S]*\}\s*catch\s*\{[\s\S]*\}\s*finally\s*\{[\s\S]*finishAugment\(augmentLease\);[\s\S]*\}/,
      );
    });
  }
});

describe('PreToolUse augmentation frame contract', () => {
  it('augmentCommand emits the explicit sentinel frame on stderr', () => {
    const source = fs.readFileSync(AUGMENT_COMMAND, 'utf-8');
    expect(source).toContain(AUGMENT_FRAME_START);
    expect(source).toContain(AUGMENT_FRAME_END);
    expect(source).toContain('process.stderr.write(`${AUGMENT_FRAME_START}');
  });

  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook consumes only the sentinel frame and preserves diagnostics`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain(AUGMENT_FRAME_START);
      expect(source).toContain(AUGMENT_FRAME_END);
      expect(source).toContain('function splitAugmentStderr(stderr)');
      expect(source).toContain('if (diagnostics) process.stderr.write(diagnostics)');
      expect(source).toContain('ONTOINDEX_HOOK_CLI_PATH');
      expect(source).not.toMatch(/includes\(['"]\[OntoIndex\]/);
      expect(source).not.toMatch(/indexOf\(['"]\[OntoIndex\]/);
    });
  }
});

// ─── extractPattern regression (via source analysis) ────────────────

describe('extractPattern coverage', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook extracts pattern from Grep tool input`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain("toolName === 'Grep'");
      expect(source).toContain('toolInput.pattern');
    });

    it(`${label} hook extracts pattern from Glob tool input`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain("toolName === 'Glob'");
    });

    it(`${label} hook extracts pattern from Bash grep/rg commands`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toMatch(/\\brg\\b.*\\bgrep\\b/);
    });

    it(`${label} hook rejects patterns shorter than 3 chars`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('cleaned.length >= 3');
    });
  }
});

// ─── PostToolUse: git mutation regex coverage ───────────────────────

describe('Git mutation regex', () => {
  const GIT_REGEX = /\\bgit\\s\+\(commit\|merge\|rebase\|cherry-pick\|pull\)/;

  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook detects git commit`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('commit');
    });

    it(`${label} hook detects git merge`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('merge');
    });

    it(`${label} hook detects git rebase`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('rebase');
    });

    it(`${label} hook detects git cherry-pick`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('cherry-pick');
    });

    it(`${label} hook detects git pull`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      // 'pull' in the regex alternation
      expect(source).toMatch(/commit\|merge\|rebase\|cherry-pick\|pull/);
    });
  }
});

// ─── Integration: PostToolUse staleness detection ───────────────────

describe('PostToolUse staleness detection (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: emits stale notification when HEAD differs from meta`, () => {
      // Write meta.json with a different commit
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaaaaa0000000000000000000000000deadbeef', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.hookEventName).toBe('PostToolUse');
      expect(output!.additionalContext).toBe(
        'OntoIndex index is behind HEAD (last indexed: aaaaaaa). ' +
        'The next OntoIndex query refreshes it automatically in the background; keep using OntoIndex. ' +
        'To refresh now, run `ontoindex analyze`.',
      );
    });

    it(`${label}: silent when HEAD matches meta lastCommit`, () => {
      const head = getHeadCommit();
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: head, stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: silent when tool is not Bash`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: silent when command is not a git mutation`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: silent when exit code is non-zero`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "fail"' },
        tool_output: { exit_code: 1 },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: includes --embeddings in suggestion when meta had embeddings`, () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'deadbeef', stats: { embeddings: 42 } }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git merge feature' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('--embeddings');
    });

    it(`${label}: omits --embeddings when meta had no embeddings`, () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'deadbeef', stats: { embeddings: 0 } }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).not.toContain('--embeddings');
    });

    it(`${label}: detects git rebase as a mutation`, () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git rebase main' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('behind HEAD');
    });

    it(`${label}: detects git cherry-pick as a mutation`, () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git cherry-pick abc123' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
    });

    it(`${label}: detects git pull as a mutation`, () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git pull origin main' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
    });
  }
});

// ─── Integration: cwd validation rejects relative paths ─────────────

describe('cwd validation (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: PostToolUse silent when cwd is relative`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: 'relative/path',
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: PreToolUse silent when cwd is relative`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'validateUser' },
        cwd: 'relative/path',
      });
      expect(result.stdout.trim()).toBe('');
    });
  }
});

// ─── Integration: dispatch map routes correctly ─────────────────────

describe('Dispatch map routing (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: unknown hook_event_name produces no output`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'UnknownEvent',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
      expect(result.status).toBe(0);
    });

    it(`${label}: empty hook_event_name produces no output`, () => {
      const result = runHook(hookPath, {
        hook_event_name: '',
        tool_name: 'Bash',
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
      expect(result.status).toBe(0);
    });

    it(`${label}: missing hook_event_name produces no output`, () => {
      const result = runHook(hookPath, {
        tool_name: 'Bash',
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
      expect(result.status).toBe(0);
    });

    it(`${label}: invalid JSON input exits cleanly`, () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: 'not json at all',
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: empty stdin exits cleanly`, () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: '',
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.status).toBe(0);
    });
  }
});

// ─── Integration: PostToolUse with missing meta.json ────────────────

describe('PostToolUse with missing/corrupt meta.json', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: emits stale when meta.json does not exist`, () => {
      const metaPath = path.join(ontoIndexDir, 'meta.json');
      const hadMeta = fs.existsSync(metaPath);
      if (hadMeta) fs.unlinkSync(metaPath);

      try {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('never');
      } finally {
        // Restore meta.json for subsequent tests
        fs.writeFileSync(metaPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
      }
    });

    it(`${label}: emits stale when meta.json is corrupt`, () => {
      const metaPath = path.join(ontoIndexDir, 'meta.json');
      fs.writeFileSync(metaPath, 'not valid json!!!');

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('never');

      // Restore
      fs.writeFileSync(metaPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
    });
  }
});
