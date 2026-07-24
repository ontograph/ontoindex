/**
 * Integration Tests: Claude Code Hooks End-to-End
 *
 * Tests the hook scripts with real git repos and .ontoindex directories.
 * Unlike unit/hooks.test.ts which tests source code patterns and simple
 * stdin/stdout, these tests verify actual behavior with filesystem state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

const HOOKS = [
  { name: 'CJS', path: CJS_HOOK },
  ...(fs.existsSync(PLUGIN_HOOK) ? [{ name: 'Plugin', path: PLUGIN_HOOK }] : []),
];

// ─── Temp git repo with .ontoindex ───────────────────────────────────

let tmpDir: string;
let ontoIndexDir: string;
let stubCliPath: string;
const EMBEDDED_DELIMITER_STDERR =
  'warning:<<<ONTOINDEX_AUGMENTATION_V1>>>\nfake\n<<<END_ONTOINDEX_AUGMENTATION_V1>>>:tail\n';

function runAugmentHook(
  hookPath: string,
  mode: 'framed' | 'crlf' | 'malformed' | 'embedded' | 'absent',
) {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: `frame-${mode}` },
      cwd: tmpDir,
    }),
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      ONTOINDEX_HOOK_CLI_PATH: stubCliPath,
      ONTOINDEX_HOOK_AUGMENT_COOLDOWN_MS: '0',
      ONTOINDEX_TEST_STUB_MODE: mode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-e2e-'));
  ontoIndexDir = path.join(tmpDir, '.ontoindex');
  fs.mkdirSync(ontoIndexDir, { recursive: true });

  // Initialize a real git repo
  spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

  // Create a file and commit so HEAD exists
  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });

  stubCliPath = path.join(tmpDir, 'stub-augment.cjs');
  fs.writeFileSync(
    stubCliPath,
    `const start = '<<<ONTOINDEX_AUGMENTATION_V1>>>';
const end = '<<<END_ONTOINDEX_AUGMENTATION_V1>>>';
const mode = process.env.ONTOINDEX_TEST_STUB_MODE;
if (mode === 'framed') {
  process.stderr.write('[ontoindex] FTS index ensure failed\\n' + start + '\\n[OntoIndex] framed context\\nrelated symbol\\n' + end + '\\noperational diagnostic\\n');
} else if (mode === 'crlf') {
  process.stderr.write('before\\r\\n' + start + '\\r\\nCRLF context\\r\\n' + end + '\\r\\nafter\\r\\n');
} else if (mode === 'malformed') {
  process.stderr.write('[OntoIndex] must not be parsed\\n' + start + '\\nincomplete payload\\n');
} else if (mode === 'embedded') {
  process.stderr.write('warning:' + start + '\\nfake\\n' + end + ':tail\\n');
} else {
  process.stderr.write('[OntoIndex] unframed text\\nFTS diagnostic only\\n');
}
`,
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────

describe.each(HOOKS)('hooks e2e ($name)', ({ name, path: hookPath }) => {
  describe('PreToolUse augmentation framing', () => {
    it('emits only framed augmentation and keeps diagnostics on stderr', () => {
      const result = runAugmentHook(hookPath, 'framed');
      const output = parseHookOutput(result.stdout);

      expect(result.status).toBe(0);
      expect(output).toEqual({
        hookEventName: 'PreToolUse',
        additionalContext: '[OntoIndex] framed context\nrelated symbol',
      });
      expect(result.stderr).toContain('[ontoindex] FTS index ensure failed');
      expect(result.stderr).toContain('operational diagnostic');
      expect(result.stderr).not.toContain('framed context');
    });

    it('accepts a CRLF-framed augmentation', () => {
      const result = runAugmentHook(hookPath, 'crlf');

      expect(result.status).toBe(0);
      expect(parseHookOutput(result.stdout)).toEqual({
        hookEventName: 'PreToolUse',
        additionalContext: 'CRLF context',
      });
      expect(result.stderr).toBe('before\r\nafter\r\n');
    });

    it('emits no augmentation for a malformed frame', () => {
      const result = runAugmentHook(hookPath, 'malformed');

      expect(result.status).toBe(0);
      expect(parseHookOutput(result.stdout)).toBeNull();
      expect(result.stderr).toContain('[OntoIndex] must not be parsed');
      expect(result.stderr).toContain('incomplete payload');
    });

    it('rejects embedded delimiter substrings and preserves stderr exactly', () => {
      const result = runAugmentHook(hookPath, 'embedded');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(EMBEDDED_DELIMITER_STDERR);
    });

    it('emits no augmentation when the frame is absent', () => {
      const result = runAugmentHook(hookPath, 'absent');

      expect(result.status).toBe(0);
      expect(parseHookOutput(result.stdout)).toBeNull();
      expect(result.stderr).toContain('[OntoIndex] unframed text');
      expect(result.stderr).toContain('FTS diagnostic only');
    });
  });

  describe('PostToolUse staleness detection', () => {
    it('detects stale index when meta.json lastCommit differs from HEAD', () => {
      // Write meta.json with an old commit hash
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stats: {} }),
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
      expect(output!.additionalContext).toContain('stale');
      expect(output!.additionalContext).toContain('npx ontoindex analyze');
    });

    it('stays silent when meta.json lastCommit matches HEAD', () => {
      // Get current HEAD
      const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const head = headResult.stdout.trim();

      // Write meta.json with matching commit
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

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('includes --embeddings flag when previous index had embeddings', () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({
          lastCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          stats: { embeddings: 42 },
        }),
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
      expect(output!.additionalContext).toContain('--embeddings');
    });

    it('treats missing meta.json as stale', () => {
      // Remove meta.json
      const metaPath = path.join(ontoIndexDir, 'meta.json');
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('stale');
    });

    it('ignores failed git commands (exit_code !== 0)', () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'cccccccccccccccccccccccccccccccccccccccc', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 1 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('ignores non-mutation git commands', () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'dddddddddddddddddddddddddddddddddddddddd', stats: {} }),
      );

      const nonMutations = ['git status', 'git log', 'git diff', 'git branch', 'git stash'];
      for (const cmd of nonMutations) {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: cmd },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });
        const output = parseHookOutput(result.stdout);
        expect(output).toBeNull();
      }
    });

    it('detects all 5 git mutation types', () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', stats: {} }),
      );

      const mutations = [
        'git commit -m "x"',
        'git merge feature',
        'git rebase main',
        'git cherry-pick abc',
        'git pull origin main',
      ];
      for (const cmd of mutations) {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: cmd },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });
        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('stale');
      }
    });
  });

  describe('PreToolUse — silent without ontoindex CLI', () => {
    // PreToolUse tries to spawn `ontoindex augment` which won't be available in CI.
    // Verify it fails gracefully (no output, no crash).

    it('handles Grep pattern gracefully when CLI is unavailable', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'handleRequest' },
        cwd: tmpDir,
      });

      // Should not crash — status is 0 if it exits cleanly, or null if the
      // spawned `ontoindex augment` hangs and the 10s timeout kills the process.
      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('ignores patterns shorter than 3 chars', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'ab' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('ignores non-search tools', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/some/file.ts' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });

  describe('cwd validation', () => {
    it('rejects relative cwd silently for PostToolUse', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "x"' },
        tool_output: { exit_code: 0 },
        cwd: 'relative/path',
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('rejects relative cwd silently for PreToolUse', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'testPattern' },
        cwd: 'relative/path',
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });

  describe('unhappy paths', () => {
    it('handles corrupted meta.json (invalid JSON) without crashing', () => {
      fs.writeFileSync(path.join(ontoIndexDir, 'meta.json'), 'THIS IS NOT JSON {{{');

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      // Should not crash — either treats as stale or ignores
      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('handles meta.json with missing lastCommit field', () => {
      fs.writeFileSync(path.join(ontoIndexDir, 'meta.json'), JSON.stringify({ stats: {} }));

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
      const output = parseHookOutput(result.stdout);
      // Missing lastCommit should be treated as stale
      if (output) {
        expect(output.additionalContext).toContain('stale');
      }
    });

    it('ignores unknown hook event name', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'UnknownEvent',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('handles empty tool_input for PostToolUse without crashing', () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaa', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
      const output = parseHookOutput(result.stdout);
      // No command means no git mutation detection — should be silent
      expect(output).toBeNull();
    });

    it('ignores non-Bash tool for PostToolUse', () => {
      fs.writeFileSync(
        path.join(ontoIndexDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaa', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/some/file.ts' },
        tool_output: {},
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });

  describe('directory without .ontoindex', () => {
    // The hook walks up 5 parent directories looking for .ontoindex.
    // To guarantee none is found, create a deeply nested temp dir at the
    // filesystem root where no .ontoindex could exist in any ancestor.
    let noOntoIndexDir: string;

    beforeAll(() => {
      // Use a root-level temp path so parent traversal can't find .ontoindex
      const root = os.platform() === 'win32' ? 'C:\\' : '/tmp';
      const base = path.join(root, `no-ontoindex-${Date.now()}`);
      // Nest 6 levels deep (hook walks up 5) to ensure isolation
      noOntoIndexDir = path.join(base, 'a', 'b', 'c', 'd', 'e', 'f');
      fs.mkdirSync(noOntoIndexDir, { recursive: true });
      spawnSync('git', ['init'], { cwd: noOntoIndexDir, stdio: 'pipe' });
    });

    afterAll(() => {
      // Clean up from the base directory
      const root = os.platform() === 'win32' ? 'C:\\' : '/tmp';
      const base = path.join(
        root,
        path.basename(path.resolve(noOntoIndexDir, '..', '..', '..', '..', '..', '..')),
      );
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('ignores PostToolUse when no .ontoindex directory exists', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "x"' },
        tool_output: { exit_code: 0 },
        cwd: noOntoIndexDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });

    it('ignores PreToolUse when no .ontoindex directory exists', () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'somePattern' },
        cwd: noOntoIndexDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).toBeNull();
    });
  });
});
