#!/usr/bin/env node
/**
 * OntoIndex Claude Code Hook
 *
 * PreToolUse  — intercepts Grep/Glob/Bash searches and augments
 *               with graph context from the OntoIndex index.
 * PostToolUse — detects stale index after git mutations and notifies
 *               the agent to reindex.
 *
 * NOTE: SessionStart hooks are broken on Windows (Claude Code bug).
 * Session context is injected via CLAUDE.md / skills instead.
 */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AUGMENT_TIMEOUT_MS = readIntEnv('ONTOINDEX_HOOK_AUGMENT_TIMEOUT_MS', 2000, 250, 10000);
const AUGMENT_COOLDOWN_MS = readIntEnv('ONTOINDEX_HOOK_AUGMENT_COOLDOWN_MS', 30000, 0, 300000);
const AUGMENT_LOCK_STALE_MS = readIntEnv(
  'ONTOINDEX_HOOK_AUGMENT_LOCK_STALE_MS',
  60000,
  1000,
  300000,
);

function readIntEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

/**
 * Read JSON input from stdin synchronously.
 */
function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Find the .ontoindex directory by walking up from startDir.
 * Returns the path to .ontoindex/ or null if not found.
 */
function findOntoIndexDir(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.ontoindex');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Extract search pattern from tool input.
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern || null;
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set([
      '-e',
      '-f',
      '-m',
      '-A',
      '-B',
      '-C',
      '-g',
      '--glob',
      '-t',
      '--type',
      '--include',
      '--exclude',
    ]);

    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith('-')) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      const cleaned = token.replace(/['"]/g, '');
      return cleaned.length >= 3 ? cleaned : null;
    }
    return null;
  }

  return null;
}

function normalizePattern(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  if (trimmed.length < 3 || trimmed.length > 120) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function augmentPaths(cwd, pattern) {
  const hash = crypto.createHash('sha256').update(`${cwd}\0${pattern}`).digest('hex').slice(0, 24);
  const base = path.join(os.tmpdir(), `ontoindex-hook-augment-${hash}`);
  return { lockPath: `${base}.lock`, stampPath: `${base}.stamp` };
}

function beginAugment(cwd, pattern) {
  if (process.env.ONTOINDEX_HOOK_AUGMENT === '0') return null;
  const now = Date.now();
  const paths = augmentPaths(cwd, pattern);

  try {
    const stamp = fs.statSync(paths.stampPath);
    if (now - stamp.mtimeMs < AUGMENT_COOLDOWN_MS) return null;
  } catch {
    /* no recent cooldown stamp */
  }

  try {
    const lock = fs.statSync(paths.lockPath);
    if (now - lock.mtimeMs < AUGMENT_LOCK_STALE_MS) return null;
    fs.unlinkSync(paths.lockPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') return null;
  }

  try {
    const fd = fs.openSync(paths.lockPath, 'wx');
    try {
      fs.writeFileSync(fd, `${process.pid}\n${now}\n${cwd}\n${pattern.slice(0, 120)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return paths;
  } catch {
    return null;
  }
}

function finishAugment(paths) {
  if (!paths) return;
  try {
    fs.writeFileSync(paths.stampPath, `${process.pid}\n${Date.now()}\n`);
  } catch {
    /* best effort */
  }
  try {
    fs.unlinkSync(paths.lockPath);
  } catch {
    /* best effort */
  }
}

/**
 * Resolve the ontoindex CLI path.
 * 1. Relative path (works when script is inside npm package)
 * 2. require.resolve (works when ontoindex is globally installed)
 * 3. Fall back to npx (returns empty string)
 */
function resolveCliPath() {
  let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
  if (!fs.existsSync(cliPath)) {
    try {
      cliPath = require.resolve('ontoindex/dist/cli/index.js');
    } catch {
      cliPath = '';
    }
  }
  return cliPath;
}

/**
 * Spawn a ontoindex CLI command synchronously.
 * Returns the stderr output (KuzuDB captures stdout at OS level).
 */
function runOntoIndexCli(cliPath, args, cwd, timeout) {
  const isWin = process.platform === 'win32';
  if (cliPath) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  // On Windows, invoke npx.cmd directly (no shell needed)
  return spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'ontoindex', ...args], {
    encoding: 'utf-8',
    timeout,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * PreToolUse handler — augment searches with graph context.
 */
function handlePreToolUse(input) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  if (!findOntoIndexDir(cwd)) return;

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Bash') return;

  const pattern = normalizePattern(extractPattern(toolName, toolInput));
  if (!pattern) return;

  const augmentLease = beginAugment(cwd, pattern);
  if (!augmentLease) return;

  const cliPath = resolveCliPath();
  let result = '';
  try {
    const child = runOntoIndexCli(cliPath, ['augment', '--', pattern], cwd, AUGMENT_TIMEOUT_MS);
    if (!child.error && child.status === 0) {
      result = child.stderr || '';
    }
  } catch {
    /* graceful failure */
  } finally {
    finishAugment(augmentLease);
  }

  if (result && result.trim()) {
    sendHookResponse('PreToolUse', result.trim());
  }
}

/**
 * Emit a PostToolUse hook response with additional context for the agent.
 */
function sendHookResponse(hookEventName, message) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: message },
    }),
  );
}

/**
 * PostToolUse handler — detect index staleness after git mutations.
 *
 * Instead of spawning a full `ontoindex analyze` synchronously (which blocks
 * the agent for up to 120s and risks KuzuDB corruption on timeout), we do a
 * lightweight staleness check: compare `git rev-parse HEAD` against the
 * lastCommit stored in `.ontoindex/meta.json`. If they differ, notify the
 * agent so it can decide when to reindex.
 */
function handlePostToolUse(input) {
  const toolName = input.tool_name || '';
  if (toolName !== 'Bash') return;

  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)) return;

  // Only proceed if the command succeeded
  const toolOutput = input.tool_output || {};
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const ontoIndexDir = findOntoIndexDir(cwd);
  if (!ontoIndexDir) return;

  // Compare HEAD against last indexed commit — skip if unchanged
  let currentHead = '';
  try {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentHead = (headResult.stdout || '').trim();
  } catch {
    return;
  }

  if (!currentHead) return;

  let lastCommit = '';
  let hadEmbeddings = false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ontoIndexDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
    hadEmbeddings = meta.stats && meta.stats.embeddings > 0;
  } catch {
    /* no meta — treat as stale */
  }

  // If HEAD matches last indexed commit, no reindex needed
  if (currentHead && currentHead === lastCommit) return;

  const analyzeCmd = `npx ontoindex analyze${hadEmbeddings ? ' --embeddings' : ''}`;
  sendHookResponse(
    'PostToolUse',
    `OntoIndex index is stale (last indexed: ${lastCommit ? lastCommit.slice(0, 7) : 'never'}). ` +
      `Run \`${analyzeCmd}\` to update the knowledge graph.`,
  );
}

// Dispatch map for hook events
const handlers = {
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
};

function main() {
  try {
    const input = readInput();
    const handler = handlers[input.hook_event_name || ''];
    if (handler) handler(input);
  } catch (err) {
    if (process.env.ONTOINDEX_DEBUG) {
      console.error('OntoIndex hook error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
