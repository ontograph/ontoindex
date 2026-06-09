/**
 * Setup Command
 *
 * One-time global MCP configuration writer.
 * Detects installed AI editors and writes the appropriate MCP config
 * so the OntoIndex MCP server is available in all projects.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { getGitRoot } from '../storage/git.js';
import { getGlobalDir } from '../storage/repo-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

interface SetupResult {
  configured: string[];
  skipped: string[];
  errors: string[];
}

interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonArray | JsonObject;

interface JsonArray extends Array<JsonValue> {}

interface JsonObject {
  [key: string]: JsonValue | undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}

function legacyConfigObject(value: unknown, configName: string): JsonObject {
  if (!value) {
    return {};
  }
  if (!isJsonObject(value)) {
    throw new TypeError(`${configName} must be a JSON object`);
  }
  return value;
}

function mcpEntryToJsonObject(entry: McpEntry): JsonObject {
  return entry.env
    ? { command: entry.command, args: entry.args, env: entry.env }
    : { command: entry.command, args: entry.args };
}

function caughtMessage(err: unknown): unknown {
  return err instanceof Error ? err.message : (err as { message: unknown }).message;
}

function resolveMcpRepoPath(): string {
  const cwd = process.cwd();
  const repoRoot = getGitRoot(cwd);
  return path.resolve(repoRoot || cwd);
}

function defaultMcpEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    ONTOINDEX_MCP_AUTO_ANALYZE: '0',
    ONTOINDEX_LBUG_POOL_SIZE: '1',
    ONTOINDEX_MCP_STARTUP_TIMEOUT_MS: process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS || '10000',
    ONTOINDEX_MCP_STARTUP_TRACE: process.env.ONTOINDEX_MCP_STARTUP_TRACE || '1',
    ONTOINDEX_MCP_PROJECT_CWD: resolveMcpRepoPath(),
    ONTOINDEX_MCP_REPO: resolveMcpRepoPath(),
    NODE_OPTIONS: process.env.ONTOINDEX_MCP_NODE_OPTIONS || '--max-old-space-size=1536',
  };
}

/**
 * Resolve the absolute path to the `ontoindex` binary if it's installed
 * globally (or via npm -g / yarn global). Returns null when not found.
 */
function resolveOntoIndexBin(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const resolved = execFileSync(cmd, ['ontoindex'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')[0]
      .trim();
    return resolved || null;
  } catch {
    return null;
  }
}

function resolvePackagedCliPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js'),
    path.resolve(__dirname, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The MCP server entry for all editors.
 *
 * Prefer the CLI that is running setup. MCP clients should not cold-start
 * through `npx ontoindex@latest`: npm installs and native postinstall scripts
 * are slow enough to exceed editor MCP startup deadlines, and global binaries
 * can drift away from the repo's active development build.
 */
function getMcpEntry(): McpEntry {
  const cliPath = resolvePackagedCliPath();
  if (cliPath) {
    return {
      command: process.execPath,
      args: [cliPath, 'mcp'],
      env: defaultMcpEnv(),
    };
  }

  const bin = resolveOntoIndexBin();
  if (bin) {
    return { command: bin, args: ['mcp'], env: defaultMcpEnv() };
  }

  // Last-resort fallback for source-tree setup before a build exists. This is
  // intentionally not @latest; it avoids silent version drift during MCP init.
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'ontoindex', 'mcp'],
      env: defaultMcpEnv(),
    };
  }
  return {
    command: 'npx',
    args: ['-y', 'ontoindex', 'mcp'],
    env: defaultMcpEnv(),
  };
}

/**
 * Merge ontoindex entry into an existing MCP config JSON object.
 * Returns the updated config.
 */
function mergeMcpConfig(existing: unknown): JsonObject {
  const config = isJsonObject(existing) ? existing : {};
  if (!isJsonObject(config.mcpServers)) {
    config.mcpServers = {};
  }
  const mcpServers = config.mcpServers;
  const entry = getMcpEntry();
  mcpServers.ontoindex = mcpEntryToJsonObject(entry);
  return config;
}

/**
 * Try to read a JSON file, returning null if it doesn't exist or is invalid.
 */
async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write JSON to a file, creating parent directories if needed.
 */
async function writeJsonFile(filePath: string, data: JsonValue): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Check if a directory exists
 */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ─── Editor-specific setup ─────────────────────────────────────────

async function setupCursor(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) {
    result.skipped.push('Cursor (not installed)');
    return;
  }

  const mcpPath = path.join(cursorDir, 'mcp.json');
  try {
    const existing = await readJsonFile(mcpPath);
    const updated = mergeMcpConfig(existing);
    await writeJsonFile(mcpPath, updated);
    result.configured.push('Cursor');
  } catch (err: unknown) {
    result.errors.push(`Cursor: ${caughtMessage(err)}`);
  }
}

async function setupClaudeCode(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) {
    result.skipped.push('Claude Code (not installed)');
    return;
  }

  // Claude Code stores MCP config in ~/.claude.json
  const mcpPath = path.join(os.homedir(), '.claude.json');
  try {
    const existing = await readJsonFile(mcpPath);
    const updated = mergeMcpConfig(existing);
    await writeJsonFile(mcpPath, updated);
    result.configured.push('Claude Code');
  } catch (err: unknown) {
    result.errors.push(`Claude Code: ${caughtMessage(err)}`);
  }
}

/**
 * Install OntoIndex skills to ~/.claude/skills/ for Claude Code.
 */
async function installClaudeCodeSkills(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const skillsDir = path.join(claudeDir, 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Claude Code skills (${installed.length} skills → ~/.claude/skills/)`);
    }
  } catch (err: unknown) {
    result.errors.push(`Claude Code skills: ${caughtMessage(err)}`);
  }
}

/**
 * Install OntoIndex hooks to ~/.claude/settings.json for Claude Code.
 * Merges hook config without overwriting existing hooks.
 */
async function installClaudeCodeHooks(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const settingsPath = path.join(claudeDir, 'settings.json');

  // Source hooks bundled within the ontoindex package (hooks/claude/)
  const pluginHooksPath = path.join(__dirname, '..', '..', 'hooks', 'claude');

  // Copy unified hook script to ~/.claude/hooks/ontoindex/
  const destHooksDir = path.join(claudeDir, 'hooks', 'ontoindex');

  try {
    await fs.mkdir(destHooksDir, { recursive: true });

    const src = path.join(pluginHooksPath, 'ontoindex-hook.cjs');
    const dest = path.join(destHooksDir, 'ontoindex-hook.cjs');
    try {
      let content = await fs.readFile(src, 'utf-8');
      // Inject resolved CLI path so the copied hook can find the CLI
      // even when it's no longer inside the npm package tree
      const resolvedCli = resolveClaudeHookCliPath();
      const normalizedCli = path.resolve(resolvedCli).replace(/\\/g, '/');
      const jsonCli = JSON.stringify(normalizedCli);
      content = content.replace(
        "let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');",
        `let cliPath = ${jsonCli};`,
      );
      await fs.writeFile(dest, content, 'utf-8');
    } catch {
      // Script not found in source — skip
    }

    const hookPath = path.join(destHooksDir, 'ontoindex-hook.cjs').replace(/\\/g, '/');
    const hookCmd = `node "${hookPath.replace(/"/g, '\\"')}"`;

    // Merge hook config into ~/.claude/settings.json
    const parsedSettings = await readJsonFile(settingsPath);
    const existing = legacyConfigObject(parsedSettings, 'Claude Code settings');
    if (!Object.hasOwn(existing, 'hooks')) {
      existing.hooks = {};
    } else if (!isJsonObject(existing.hooks)) {
      throw new TypeError('Claude Code hooks must be a JSON object');
    }
    const hooks = existing.hooks;

    // NOTE: SessionStart hooks are broken on Windows (Claude Code bug #23576).
    // Session context is delivered via CLAUDE.md / skills instead.

    // Helper: add a hook entry if one with 'ontoindex-hook' isn't already registered
    function ensureHookEntry(
      eventName: string,
      matcher: string,
      timeout: number,
      statusMessage: string,
    ) {
      const currentEventHooks = hooks[eventName];
      let eventHooks: JsonArray;
      if (!Object.hasOwn(hooks, eventName)) {
        eventHooks = [];
        hooks[eventName] = eventHooks;
      } else if (isJsonArray(currentEventHooks)) {
        eventHooks = currentEventHooks;
      } else {
        throw new TypeError(`Claude Code ${eventName} hooks must be an array`);
      }
      const hasHook = eventHooks.some(
        (h) =>
          isJsonObject(h) &&
          isJsonArray(h.hooks) &&
          h.hooks.some(
            (hh) =>
              isJsonObject(hh) &&
              typeof hh.command === 'string' &&
              hh.command.includes('ontoindex-hook'),
          ),
      );
      if (!hasHook) {
        eventHooks.push({
          matcher,
          hooks: [{ type: 'command', command: hookCmd, timeout, statusMessage }],
        });
      }
    }

    ensureHookEntry(
      'PreToolUse',
      'Grep|Glob|Bash',
      10,
      'Enriching with OntoIndex graph context...',
    );
    ensureHookEntry('PostToolUse', 'Bash', 10, 'Checking OntoIndex index freshness...');

    await writeJsonFile(settingsPath, existing);
    result.configured.push('Claude Code hooks (PreToolUse, PostToolUse)');
  } catch (err: unknown) {
    result.errors.push(`Claude Code hooks: ${caughtMessage(err)}`);
  }
}

function resolveClaudeHookCliPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'cli', 'index.js'),
    path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

async function setupOpenCode(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) {
    result.skipped.push('OpenCode (not installed)');
    return;
  }

  const configPath = path.join(opencodeDir, 'opencode.json');
  try {
    const existing = await readJsonFile(configPath);
    const config = legacyConfigObject(existing, 'OpenCode config');
    if (!config.mcp || isJsonArray(config.mcp)) {
      config.mcp = {};
    } else if (!isJsonObject(config.mcp)) {
      throw new TypeError('OpenCode mcp must be a JSON object');
    }
    config.mcp.ontoindex = mcpEntryToJsonObject(getMcpEntry());
    await writeJsonFile(configPath, config);
    result.configured.push('OpenCode');
  } catch (err: unknown) {
    result.errors.push(`OpenCode: ${caughtMessage(err)}`);
  }
}

/**
 * Build a TOML section for Codex MCP config (~/.codex/config.toml).
 */
function getCodexMcpTomlSection(): string {
  const entry = getMcpEntry();
  const command = JSON.stringify(entry.command);
  const args = `[${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`;
  const env =
    entry.env && Object.keys(entry.env).length > 0
      ? `env = { ${Object.entries(entry.env)
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
          .join(', ')} }\n`
      : '';
  return `[mcp_servers.ontoindex]\ncommand = ${command}\nargs = ${args}\n${env}`;
}

/**
 * Upsert OntoIndex MCP server config in Codex's config.toml.
 * Existing stale sections are replaced so setup can repair removed binaries.
 */
async function upsertCodexConfigToml(configPath: string): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch {
    existing = '';
  }

  const section = getCodexMcpTomlSection();
  const sectionRe =
    /^\[mcp_servers\.ontoindex(?:\.[^\]]+)?\]\n[\s\S]*?(?=^\[(?!mcp_servers\.ontoindex(?:\.|\]))|\s*$)/gm;
  const firstMatch = sectionRe.exec(existing);
  sectionRe.lastIndex = 0;
  const nextContent = firstMatch
    ? [
        existing.slice(0, firstMatch.index).trimEnd(),
        section.trimEnd(),
        existing.slice(firstMatch.index).replace(sectionRe, '').trimStart(),
      ]
        .filter((part) => part.length > 0)
        .join('\n\n')
    : existing.trim().length > 0
      ? `${existing.trimEnd()}\n\n${section}`
      : section;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${nextContent.trimEnd()}\n`, 'utf-8');
}

async function setupCodex(result: SetupResult): Promise<void> {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!(await dirExists(codexDir))) {
    result.skipped.push('Codex (not installed)');
    return;
  }

  try {
    const configPath = path.join(codexDir, 'config.toml');
    await upsertCodexConfigToml(configPath);
    result.configured.push('Codex (MCP repaired in ~/.codex/config.toml)');
    return;
  } catch {
    // Fallback for unusual environments where direct config writes fail.
  }

  try {
    const entry = getMcpEntry();
    await execFileAsync('codex', ['mcp', 'add', 'ontoindex', '--', entry.command, ...entry.args], {
      shell: process.platform === 'win32',
    });
    result.configured.push('Codex');
  } catch (err: unknown) {
    result.errors.push(`Codex: ${caughtMessage(err)}`);
  }
}

// ─── Skill Installation ───────────────────────────────────────────

/**
 * Install OntoIndex skills to a target directory.
 * Each skill is installed as {targetDir}/ontoindex-{skillName}/SKILL.md
 * following the Agent Skills standard (Cursor, Claude Code, and Codex).
 *
 * Supports two source layouts:
 *   - Flat file:  skills/{name}.md           → copied as SKILL.md
 *   - Directory:  skills/{name}/SKILL.md     → copied recursively (includes references/, etc.)
 */
async function installSkillsTo(targetDir: string): Promise<string[]> {
  const installed: string[] = [];
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');

  let flatFiles: string[] = [];
  let dirSkillFiles: string[] = [];
  try {
    [flatFiles, dirSkillFiles] = await Promise.all([
      glob('*.md', { cwd: skillsRoot }),
      glob('*/SKILL.md', { cwd: skillsRoot }),
    ]);
  } catch {
    return [];
  }

  const skillSources = new Map<string, { isDirectory: boolean }>();

  for (const relPath of dirSkillFiles) {
    skillSources.set(path.dirname(relPath), { isDirectory: true });
  }
  for (const relPath of flatFiles) {
    const skillName = path.basename(relPath, '.md');
    if (!skillSources.has(skillName)) {
      skillSources.set(skillName, { isDirectory: false });
    }
  }

  for (const [skillName, source] of skillSources) {
    const skillDir = path.join(targetDir, skillName);

    try {
      if (source.isDirectory) {
        const dirSource = path.join(skillsRoot, skillName);
        await copyDirRecursive(dirSource, skillDir);
        installed.push(skillName);
      } else {
        const flatSource = path.join(skillsRoot, `${skillName}.md`);
        const content = await fs.readFile(flatSource, 'utf-8');
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        installed.push(skillName);
      }
    } catch {
      // Source skill not found — skip
    }
  }

  return installed;
}

/**
 * Recursively copy a directory tree.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Install global Cursor skills to ~/.cursor/skills/ontoindex/
 */
async function installCursorSkills(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) return;

  const skillsDir = path.join(cursorDir, 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Cursor skills (${installed.length} skills → ~/.cursor/skills/)`);
    }
  } catch (err: unknown) {
    result.errors.push(`Cursor skills: ${caughtMessage(err)}`);
  }
}

/**
 * Install global OpenCode skills to ~/.config/opencode/skill/ontoindex/
 */
async function installOpenCodeSkills(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) return;

  const skillsDir = path.join(opencodeDir, 'skill');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(
        `OpenCode skills (${installed.length} skills → ~/.config/opencode/skill/)`,
      );
    }
  } catch (err: unknown) {
    result.errors.push(`OpenCode skills: ${caughtMessage(err)}`);
  }
}

/**
 * Install global Codex skills to ~/.agents/skills/ontoindex/
 */
async function installCodexSkills(result: SetupResult): Promise<void> {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!(await dirExists(codexDir))) return;

  const skillsDir = path.join(os.homedir(), '.agents', 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Codex skills (${installed.length} skills → ~/.agents/skills/)`);
    }
  } catch (err: unknown) {
    result.errors.push(`Codex skills: ${caughtMessage(err)}`);
  }
}

// ─── Main command ──────────────────────────────────────────────────

export const setupCommand = async () => {
  console.log('');
  console.log('  OntoIndex Setup');
  console.log('  ==============');
  console.log('');

  // Ensure global directory exists
  const globalDir = getGlobalDir();
  await fs.mkdir(globalDir, { recursive: true });

  const result: SetupResult = {
    configured: [],
    skipped: [],
    errors: [],
  };

  // Detect and configure each editor's MCP
  await setupCursor(result);
  await setupClaudeCode(result);
  await setupOpenCode(result);
  await setupCodex(result);

  // Install global skills for platforms that support them
  await installClaudeCodeSkills(result);
  await installClaudeCodeHooks(result);
  await installCursorSkills(result);
  await installOpenCodeSkills(result);
  await installCodexSkills(result);

  // Print results
  if (result.configured.length > 0) {
    console.log('  Configured:');
    for (const name of result.configured) {
      console.log(`    + ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  Skipped:');
    for (const name of result.skipped) {
      console.log(`    - ${name}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const err of result.errors) {
      console.log(`    ! ${err}`);
    }
  }

  console.log('');
  console.log('  Summary:');
  console.log(
    `    MCP configured for: ${result.configured.filter((c) => !c.includes('skills')).join(', ') || 'none'}`,
  );
  console.log(
    `    Skills installed to: ${result.configured.filter((c) => c.includes('skills')).length > 0 ? result.configured.filter((c) => c.includes('skills')).join(', ') : 'none'}`,
  );
  console.log('');
  console.log('  Next steps:');
  console.log('    1. cd into any git repo');
  console.log('    2. Run: ontoindex analyze');
  console.log('    3. Open the repo in your editor — MCP is ready!');
  console.log('');
};
