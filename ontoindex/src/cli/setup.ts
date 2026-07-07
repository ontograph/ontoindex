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
  warnings: string[];
  errors: string[];
}

interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  mode: 'packaged-cli' | 'binary' | 'npx';
  cliPath?: string;
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

const ONTOINDEX_AGENT_GUIDANCE = `# OntoIndex

When the user asks to use OntoIndex, or when code work depends on architecture,
impact, review, routing, or graph context, use available OntoIndex MCP tools
before claiming graph-backed analysis. Useful tools include \`search\`, \`inspect\`,
\`impact\`, \`gn_explore\`, \`gn_diagnose\`, \`gn_diff_impact\`, \`gn_review_diff\`,
\`gn_verify_diff\`, and related \`gn_*\` tools.

Never claim OntoIndex was used unless an OntoIndex MCP call or \`ontoindex://\`
resource read actually returned. If only \`rg\`, \`sed\`, shell commands, or local
file reads were used, say that. If OntoIndex is unavailable, stale, degraded, or
not configured for the repo, state the exact limitation and verify directly from
source. The \`ontoindex\` CLI may not be on PATH; prefer MCP tools/resources.

For simple exact file lookup or newly-created unindexed files, direct source
inspection is acceptable; do not label it OntoIndex evidence.

For non-trivial code research/analysis on an indexed repo, use OntoIndex early,
then verify exact claims from source:

- Architecture / "how does X work" -> \`gn_explore\` or \`search\` plus \`inspect\`
- "What breaks if I change X" / impact -> \`impact\` or \`gn_diff_impact\`
- Bug trace / "where does this error come from" -> \`search\` plus \`inspect\`; use \`gn_diagnose\` when index/tool health is suspect
- Review a diff's blast radius -> \`gn_review_diff\` or \`gn_diff_impact\`
`;

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
function getMcpEntry(projectPath = resolveMcpRepoPath()): McpEntry {
  const cliPath = resolvePackagedCliPath();
  if (cliPath) {
    return {
      command: process.execPath,
      args: [cliPath, 'mcp', '--project', projectPath],
      env: defaultMcpEnv(),
      mode: 'packaged-cli',
      cliPath,
    };
  }

  const bin = resolveOntoIndexBin();
  if (bin) {
    return {
      command: bin,
      args: ['mcp', '--project', projectPath],
      env: defaultMcpEnv(),
      mode: 'binary',
    };
  }

  // Last-resort fallback for source-tree setup before a build exists. This is
  // intentionally not @latest; it avoids silent version drift during MCP init.
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'ontoindex', 'mcp', '--project', projectPath],
      env: defaultMcpEnv(),
      mode: 'npx',
    };
  }
  return {
    command: 'npx',
    args: ['-y', 'ontoindex', 'mcp', '--project', projectPath],
    env: defaultMcpEnv(),
    mode: 'npx',
  };
}

/**
 * Merge ontoindex entry into an existing MCP config JSON object.
 * Returns the updated config.
 */
function mergeMcpConfig(existing: unknown, entry: McpEntry): JsonObject {
  const config = isJsonObject(existing) ? existing : {};
  if (!isJsonObject(config.mcpServers)) {
    config.mcpServers = {};
  }
  const mcpServers = config.mcpServers;
  mcpServers.ontoindex = mcpEntryToJsonObject(entry);
  return config;
}

interface McpEntryValidation {
  warnings: string[];
  errors: string[];
}

function validateMcpEntry(entry: McpEntry, projectPath: string): McpEntryValidation {
  const warnings: string[] = [];
  const errors: string[] = [];
  const args = Array.isArray(entry.args) ? entry.args : [];

  if (!entry.command || entry.command.trim().length === 0) {
    errors.push('MCP entry command is missing');
  }

  if (!Array.isArray(entry.args) || !args.includes('mcp')) {
    errors.push('MCP entry args must include "mcp"');
  }

  const projectFlagIndex = args.indexOf('--project');
  if (projectFlagIndex === -1) {
    errors.push('MCP entry args must include "--project <path>"');
  } else if (projectFlagIndex === args.length - 1) {
    errors.push('MCP entry args must include a project path after "--project"');
  } else {
    const entryProjectPath = path.resolve(args[projectFlagIndex + 1]);
    if (entryProjectPath !== projectPath) {
      errors.push(
        `MCP entry project path resolves to ${entryProjectPath}, expected ${projectPath}`,
      );
    }
  }

  if (entry.env?.ONTOINDEX_MCP_AUTO_ANALYZE !== '0') {
    errors.push('MCP entry env must disable auto analyze with ONTOINDEX_MCP_AUTO_ANALYZE=0');
  }

  if (entry.mode === 'packaged-cli') {
    const cliPath = entry.cliPath || args[0];
    if (!cliPath) {
      errors.push('Packaged CLI entry is missing the CLI path');
    } else if (!existsSync(cliPath)) {
      errors.push(`Packaged CLI path does not exist: ${cliPath}`);
    }
  } else if (entry.mode === 'binary') {
    warnings.push(`Using global ontoindex binary fallback: ${entry.command}`);
  } else {
    warnings.push(`Using npx fallback for MCP entry: ${entry.command}`);
  }

  return { warnings, errors };
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

function hasOntoIndexIncludeOrBlock(content: string): boolean {
  return (
    /(^|\r?\n)\s*@ONTOINDEX\.md\s*(\r?\n|$)/.test(content) ||
    /<!--\s*ontoindex\s*-->/i.test(content) ||
    /\bONTOINDEX\.md\b/i.test(content)
  );
}

async function ensureOntoIndexAgentGuidance(
  result: SetupResult,
  clientName: string,
  configDir: string,
  instructionFileName: 'AGENTS.md' | 'CLAUDE.md',
): Promise<void> {
  if (!(await dirExists(configDir))) return;

  const ontoindexPath = path.join(configDir, 'ONTOINDEX.md');
  const instructionPath = path.join(configDir, instructionFileName);

  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(ontoindexPath, ONTOINDEX_AGENT_GUIDANCE, 'utf-8');

    let instructionContent = '';
    try {
      instructionContent = await fs.readFile(instructionPath, 'utf-8');
    } catch {
      instructionContent = '# Global Agent Instructions\n';
    }

    if (!hasOntoIndexIncludeOrBlock(instructionContent)) {
      instructionContent = `${instructionContent.trimEnd()}\n\n@ONTOINDEX.md\n`;
      await fs.writeFile(instructionPath, instructionContent, 'utf-8');
    }

    result.configured.push(
      `${clientName} OntoIndex guidance (~/${path.basename(configDir)}/ONTOINDEX.md)`,
    );
  } catch (err: unknown) {
    result.errors.push(`${clientName} OntoIndex guidance: ${caughtMessage(err)}`);
  }
}

// ─── Editor-specific setup ─────────────────────────────────────────

async function setupCursor(result: SetupResult, entry: McpEntry): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) {
    result.skipped.push('Cursor (not installed)');
    return;
  }

  const mcpPath = path.join(cursorDir, 'mcp.json');
  try {
    const existing = await readJsonFile(mcpPath);
    const updated = mergeMcpConfig(existing, entry);
    await writeJsonFile(mcpPath, updated);
    result.configured.push('Cursor');
  } catch (err: unknown) {
    result.errors.push(`Cursor: ${caughtMessage(err)}`);
  }
}

async function setupClaudeCode(result: SetupResult, entry: McpEntry): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) {
    result.skipped.push('Claude Code (not installed)');
    return;
  }

  // Claude Code stores MCP config in ~/.claude.json
  const mcpPath = path.join(os.homedir(), '.claude.json');
  try {
    const existing = await readJsonFile(mcpPath);
    const updated = mergeMcpConfig(existing, entry);
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
async function installGenericHooks(
  result: SetupResult,
  clientName: string,
  configDir: string,
  hooksFileName: string,
): Promise<void> {
  if (!(await dirExists(configDir))) return;

  const settingsPath = path.join(configDir, hooksFileName);
  const pluginHooksPath = path.join(__dirname, '..', '..', 'hooks', 'claude');
  const destHooksDir = path.join(configDir, 'hooks', 'ontoindex');

  try {
    await fs.mkdir(destHooksDir, { recursive: true });

    const src = path.join(pluginHooksPath, 'ontoindex-hook.cjs');
    const dest = path.join(destHooksDir, 'ontoindex-hook.cjs');
    try {
      let content = await fs.readFile(src, 'utf-8');
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

    let parsedSettings = await readJsonFile(settingsPath);
    // Codex/Ontocode use a top-level hooks object usually, but let's be robust
    const existing = legacyConfigObject(parsedSettings, `${clientName} config`);
    if (!Object.hasOwn(existing, 'hooks')) {
      existing.hooks = {};
    } else if (!isJsonObject(existing.hooks)) {
      throw new TypeError(`${clientName} hooks must be a JSON object`);
    }
    const hooks = existing.hooks;

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
        throw new TypeError(`${clientName} ${eventName} hooks must be an array`);
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
    result.configured.push(`${clientName} hooks (PreToolUse, PostToolUse)`);
  } catch (err: unknown) {
    result.errors.push(`${clientName} hooks: ${caughtMessage(err)}`);
  }
}

async function installClaudeCodeHooks(result: SetupResult): Promise<void> {
  return installGenericHooks(
    result,
    'Claude Code',
    path.join(os.homedir(), '.claude'),
    'settings.json',
  );
}

async function installCodexHooks(result: SetupResult): Promise<void> {
  return installGenericHooks(result, 'Codex', path.join(os.homedir(), '.codex'), 'hooks.json');
}

async function installOntocodeHooks(result: SetupResult): Promise<void> {
  return installGenericHooks(
    result,
    'Ontocode',
    path.join(os.homedir(), '.ontocode'),
    'hooks.json',
  );
}

function resolveClaudeHookCliPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'cli', 'index.js'),
    path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

async function setupOpenCode(result: SetupResult, entry: McpEntry): Promise<void> {
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
    config.mcp.ontoindex = mcpEntryToJsonObject(entry);
    await writeJsonFile(configPath, config);
    result.configured.push('OpenCode');
  } catch (err: unknown) {
    result.errors.push(`OpenCode: ${caughtMessage(err)}`);
  }
}

/**
 * Build a TOML section for Codex-compatible MCP config.
 */
function getCodexMcpTomlSection(entry: McpEntry): string {
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

function isTomlSectionHeader(line: string): boolean {
  return /^\[\[?.+\]\]?\s*$/.test(line.trim());
}

function isOntoindexMcpSectionHeader(line: string): boolean {
  const match = line.trim().match(/^\[([^\]]+)\]\s*$/);
  if (!match) return false;
  const sectionName = match[1];
  return (
    sectionName === 'mcp_servers.ontoindex' || sectionName.startsWith('mcp_servers.ontoindex.')
  );
}

function findOntoindexMcpSectionRange(existing: string): { start: number; end: number } | null {
  const lines = existing.match(/^.*(?:\n|$)/gm) ?? [];
  let startLine = -1;
  let endLine = lines.length;
  let offset = 0;
  const offsets: number[] = [];

  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isTomlSectionHeader(line)) continue;
    if (startLine === -1) {
      if (isOntoindexMcpSectionHeader(line)) {
        startLine = i;
      }
      continue;
    }
    if (!isOntoindexMcpSectionHeader(line)) {
      endLine = i;
      break;
    }
  }

  if (startLine === -1) return null;
  return {
    start: offsets[startLine],
    end: endLine < offsets.length ? offsets[endLine] : existing.length,
  };
}

/**
 * Upsert OntoIndex MCP server config in a Codex-compatible config.toml.
 * Existing stale sections are replaced so setup can repair removed binaries.
 */
async function upsertCodexConfigToml(configPath: string, entry: McpEntry): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch {
    existing = '';
  }

  const section = getCodexMcpTomlSection(entry);
  const existingRange = findOntoindexMcpSectionRange(existing);
  const nextContent = existingRange
    ? [
        existing.slice(0, existingRange.start).trimEnd(),
        section.trimEnd(),
        existing.slice(existingRange.end).trimStart(),
      ]
        .filter((part) => part.length > 0)
        .join('\n\n')
    : existing.trim().length > 0
      ? `${existing.trimEnd()}\n\n${section}`
      : section;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${nextContent.trimEnd()}\n`, 'utf-8');
}

async function setupCodex(result: SetupResult, entry: McpEntry): Promise<void> {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!(await dirExists(codexDir))) {
    result.skipped.push('Codex (not installed)');
    return;
  }

  try {
    const configPath = path.join(codexDir, 'config.toml');
    await upsertCodexConfigToml(configPath, entry);
    result.configured.push('Codex (MCP repaired in ~/.codex/config.toml)');
    return;
  } catch {
    // Fallback for unusual environments where direct config writes fail.
  }

  try {
    await execFileAsync('codex', ['mcp', 'add', 'ontoindex', '--', entry.command, ...entry.args], {
      shell: process.platform === 'win32',
    });
    result.configured.push('Codex');
  } catch (err: unknown) {
    result.errors.push(`Codex: ${caughtMessage(err)}`);
  }
}

async function setupOntocode(result: SetupResult, entry: McpEntry): Promise<void> {
  const ontocodeDir = path.join(os.homedir(), '.ontocode');
  if (!(await dirExists(ontocodeDir))) {
    result.skipped.push('Ontocode (not installed)');
    return;
  }

  try {
    const configPath = path.join(ontocodeDir, 'config.toml');
    await upsertCodexConfigToml(configPath, entry);
    result.configured.push('Ontocode (MCP repaired in ~/.ontocode/config.toml)');
    return;
  } catch {
    // Fallback for unusual environments where direct config writes fail.
  }

  try {
    await execFileAsync(
      'ontocode',
      ['mcp', 'add', 'ontoindex', '--', entry.command, ...entry.args],
      {
        shell: process.platform === 'win32',
      },
    );
    result.configured.push('Ontocode');
  } catch (err: unknown) {
    result.errors.push(`Ontocode: ${caughtMessage(err)}`);
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
        const skillContent = await fs.readFile(path.join(dirSource, 'SKILL.md'), 'utf-8');
        if (!hasYamlFrontmatter(skillContent)) continue;
        await copyDirRecursive(dirSource, skillDir);
        installed.push(skillName);
      } else {
        const flatSource = path.join(skillsRoot, `${skillName}.md`);
        const content = await fs.readFile(flatSource, 'utf-8');
        if (!hasYamlFrontmatter(content)) continue;
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

function hasYamlFrontmatter(content: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content);
}

async function removeInvalidLegacyGitNexusSkills(skillsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('gitnexus-')) continue;
    const skillDir = path.join(skillsDir, entry.name);
    try {
      const content = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
      if (hasYamlFrontmatter(content)) continue;
    } catch {
      continue;
    }
    await fs.rm(skillDir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
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
    const removedLegacy = await removeInvalidLegacyGitNexusSkills(skillsDir);
    const installed = await installSkillsTo(skillsDir);
    if (removedLegacy.length > 0) {
      result.configured.push(
        `Removed invalid legacy GitNexus Codex skills (${removedLegacy.length})`,
      );
    }
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
    warnings: [],
    errors: [],
  };

  const projectPath = resolveMcpRepoPath();
  const mcpEntry = getMcpEntry(projectPath);
  const validation = validateMcpEntry(mcpEntry, projectPath);
  result.warnings.push(...validation.warnings);
  result.errors.push(...validation.errors);

  // Detect and configure each editor's MCP
  await setupCursor(result, mcpEntry);
  await setupClaudeCode(result, mcpEntry);
  await setupOpenCode(result, mcpEntry);
  await setupCodex(result, mcpEntry);
  await setupOntocode(result, mcpEntry);

  // Install agent guidance that prevents false OntoIndex-use claims.
  await ensureOntoIndexAgentGuidance(
    result,
    'Claude Code',
    path.join(os.homedir(), '.claude'),
    'CLAUDE.md',
  );
  await ensureOntoIndexAgentGuidance(
    result,
    'Codex',
    path.join(os.homedir(), '.codex'),
    'AGENTS.md',
  );
  await ensureOntoIndexAgentGuidance(
    result,
    'Ontocode',
    path.join(os.homedir(), '.ontocode'),
    'AGENTS.md',
  );

  // Install global skills and hooks for platforms that support them
  await installClaudeCodeSkills(result);
  await installClaudeCodeHooks(result);

  await installCursorSkills(result);
  await installOpenCodeSkills(result);

  await installCodexSkills(result);
  await installCodexHooks(result);

  await installOntocodeHooks(result);

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

  if (result.warnings.length > 0) {
    console.log('');
    console.log('  Warnings:');
    for (const warning of result.warnings) {
      console.log(`    ! ${warning}`);
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
  console.log('    3. Run: ontoindex setup (safe to rerun after installs/upgrades)');
  console.log('    4. Open the repo in your editor — MCP is ready!');
  console.log('');
};
