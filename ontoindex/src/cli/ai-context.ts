/**
 * AI Context Generator
 *
 * Creates AGENTS.md and CLAUDE.md with full inline OntoIndex context.
 * AGENTS.md is the standard read by Cursor, Windsurf, OpenCode, Codex, Cline, etc.
 * CLAUDE.md is for Claude Code which only reads that file.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { type GeneratedSkillInfo } from './skill-gen.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RepoStats {
  files?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  clusters?: number; // Aggregated cluster count (what tools show)
  processes?: number;
}

interface AIContextOptions {
  skipAgentsMd?: boolean;
  noStats?: boolean;
}

const ONTOINDEX_START_MARKER = '<!-- ontoindex:start -->';
const ONTOINDEX_END_MARKER = '<!-- ontoindex:end -->';
const ONTOINDEX_BLOCK_PATTERN =
  /^<!-- ontoindex:start -->[ \t]*\r?\n[\s\S]*?^<!-- ontoindex:end -->[ \t]*(?:\r?\n)?/gm;

/**
 * Generate the full OntoIndex context content.
 *
 * Design principles (learned from real agent behavior and industry research):
 * - Inline critical workflows — skills are skipped 56% of the time (Vercel eval data)
 * - Use RFC 2119 language (MUST, NEVER, ALWAYS) — models follow imperative rules
 * - Three-tier boundaries (Always/When/Never) — proven to change model behavior
 * - Keep under 120 lines — adherence degrades past 150 lines
 * - Exact tool commands with parameters — vague directives get ignored
 * - Self-review checklist — forces model to verify its own work
 */
async function findGroupsContainingRegistryName(registryName: string): Promise<string[]> {
  const { listGroups, getDefaultOntoIndexDir, getGroupDir } =
    await import('../core/group/storage.js');
  const { loadGroupConfig } = await import('../core/group/config-parser.js');
  const names = await listGroups();
  const hits: string[] = [];
  for (const g of names) {
    try {
      const config = await loadGroupConfig(getGroupDir(getDefaultOntoIndexDir(), g));
      if (Object.values(config.repos).some((r) => r === registryName)) hits.push(config.name);
    } catch {
      // skip invalid or unreadable groups
    }
  }
  return hits;
}

function generateOntoIndexContent(
  projectName: string,
  stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[],
  groupNames?: string[],
  noStats?: boolean,
  cliCommand = 'ontoindex',
): string {
  const generatedRows =
    generatedSkills && generatedSkills.length > 0
      ? generatedSkills
          .map(
            (s) =>
              `| Work in the ${s.label} area (${s.symbolCount} symbols) | \`.claude/skills/generated/${s.name}/SKILL.md\` |`,
          )
          .join('\n')
      : '';

  const skillsTable = `| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | \`.claude/skills/ontoindex/ontoindex-exploring/SKILL.md\` |
| Blast radius / "What breaks if I change X?" | \`.claude/skills/ontoindex/ontoindex-impact-analysis/SKILL.md\` |
| Trace bugs / "Why is X failing?" | \`.claude/skills/ontoindex/ontoindex-debugging/SKILL.md\` |
| Rename / extract / split / refactor | \`.claude/skills/ontoindex/ontoindex-refactoring/SKILL.md\` |
| Tools, resources, schema reference | \`.claude/skills/ontoindex/ontoindex-guide/SKILL.md\` |
| Index, status, clean, wiki CLI commands | \`.claude/skills/ontoindex/ontoindex-cli/SKILL.md\` |${generatedRows ? '\n' + generatedRows : ''}`;

  const analyzeCommand = cliCommand.startsWith('node ')
    ? `ONTOINDEX_MAX_WORKERS=7 ${cliCommand} analyze`
    : `${cliCommand} analyze`;

  return `${ONTOINDEX_START_MARKER}
# OntoIndex — Code Intelligence

This project is indexed by OntoIndex as **${projectName}**${noStats ? '' : ` (${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows)`}. Use the OntoIndex MCP tools to understand code, assess impact, and navigate safely.

> If any OntoIndex tool warns the index is stale, coordinate first; exactly one process should run \`${analyzeCommand}\`.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run \`ontoindex_impact({target: "symbolName", direction: "upstream"})\` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run \`ontoindex_detect_changes()\` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use \`ontoindex_query({query: "concept"})\` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use \`ontoindex_context({name: "symbolName"})\`.

## Never Do

- NEVER edit a function, class, or method without first running \`ontoindex_impact\` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use \`ontoindex_rename\` which understands the call graph.
- NEVER commit changes without running \`ontoindex_detect_changes()\` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| \`ontoindex://repo/${projectName}/context\` | Codebase overview, check index freshness |
| \`ontoindex://repo/${projectName}/clusters\` | All functional areas |
| \`ontoindex://repo/${projectName}/processes\` | All execution flows |
| \`ontoindex://repo/${projectName}/process/{name}\` | Step-by-step execution trace |

${
  groupNames && groupNames.length > 0
    ? `## Cross-Repo Groups

This repository is listed under OntoIndex **group(s): ${groupNames.join(', ')}** (see \`~/.ontoindex/groups/\`). For cross-repo analysis, use MCP tools \`impact\`, \`query\`, and \`context\` with \`repo\` set to \`@<groupName>\` or \`@<groupName>/<memberPath>\` (paths match keys in that group’s \`group.yaml\`). Use \`group_list\` / \`group_sync\` for membership and sync. From the terminal: \`${cliCommand} group list\`, \`${cliCommand} group sync <name>\`, \`${cliCommand} group impact <name> --target <symbol> --repo <group-path>\`.

`
    : ''
}## CLI

${skillsTable}

${ONTOINDEX_END_MARKER}`;
}

async function resolveGeneratedCliCommand(repoPath: string): Promise<string> {
  const localCli = path.join(repoPath, 'ontoindex', 'dist', 'cli', 'index.js');
  try {
    await fs.access(localCli);
    return `node ${localCli}`;
  } catch {
    return 'ontoindex';
  }
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or update OntoIndex section in a file
 * - If file doesn't exist: create with OntoIndex content
 * - If file exists without OntoIndex section: append
 * - If file exists with OntoIndex section: replace that section
 */
async function upsertOntoIndexSection(
  filePath: string,
  content: string,
): Promise<'created' | 'updated' | 'appended'> {
  const exists = await fileExists(filePath);

  if (!exists) {
    await fs.writeFile(filePath, content, 'utf-8');
    return 'created';
  }

  const existingContent = stripMalformedOntoIndexBlocks(await fs.readFile(filePath, 'utf-8'));

  // Check if OntoIndex section already exists
  let replaced = false;
  const newContent = existingContent.replace(ONTOINDEX_BLOCK_PATTERN, () => {
    if (replaced) return '';
    replaced = true;
    return `${content}\n`;
  });

  if (replaced) {
    await fs.writeFile(filePath, newContent.trim() + '\n', 'utf-8');
    return 'updated';
  }

  // Append new section
  const appendedContent = existingContent.trim() + '\n\n' + content + '\n';
  await fs.writeFile(filePath, appendedContent, 'utf-8');
  return 'appended';
}

function stripMalformedOntoIndexBlocks(content: string): string {
  const canonicalSpans = Array.from(content.matchAll(ONTOINDEX_BLOCK_PATTERN), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const markerSpans = Array.from(
    content.matchAll(new RegExp(`${ONTOINDEX_START_MARKER}[\\s\\S]*?${ONTOINDEX_END_MARKER}`, 'g')),
    (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }),
  );

  const rangesToStrip = markerSpans
    .filter(
      (span) =>
        !canonicalSpans.some(
          (canonical) => span.start >= canonical.start && span.end <= canonical.end,
        ),
    )
    .map((span) => {
      const lineStart = content.lastIndexOf('\n', span.start) + 1;
      const nextLineBreak = content.indexOf('\n', span.end);
      const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak + 1;
      return { start: lineStart, end: lineEnd };
    })
    .sort((a, b) => a.start - b.start);

  if (rangesToStrip.length === 0) return content;

  let sanitized = '';
  let cursor = 0;
  for (const range of rangesToStrip) {
    sanitized += content.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  sanitized += content.slice(cursor);

  return sanitized;
}

/**
 * Install OntoIndex skills to .claude/skills/ontoindex/
 * Works natively with Claude Code, Cursor, and GitHub Copilot
 */
async function installSkills(repoPath: string): Promise<string[]> {
  const skillsDir = path.join(repoPath, '.claude', 'skills', 'ontoindex');
  const installedSkills: string[] = [];

  // Skill definitions bundled with the package
  const skills = [
    {
      name: 'ontoindex-exploring',
      description:
        'Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: "How does X work?", "What calls this function?", "Show me the auth flow"',
    },
    {
      name: 'ontoindex-debugging',
      description:
        'Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: "Why is X failing?", "Where does this error come from?", "Trace this bug"',
    },
    {
      name: 'ontoindex-impact-analysis',
      description:
        'Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: "Is it safe to change X?", "What depends on this?", "What will break?"',
    },
    {
      name: 'ontoindex-refactoring',
      description:
        'Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: "Rename this function", "Extract this into a module", "Refactor this class", "Move this to a separate file"',
    },
    {
      name: 'ontoindex-guide',
      description:
        'Use when the user asks about OntoIndex itself — available tools, how to query the knowledge graph, MCP resources, graph schema, or workflow reference. Examples: "What OntoIndex tools are available?", "How do I use OntoIndex?"',
    },
    {
      name: 'ontoindex-cli',
      description:
        'Use when the user needs to run OntoIndex CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: "Index this repo", "Reanalyze the codebase", "Generate a wiki"',
    },
  ];

  for (const skill of skills) {
    const skillDir = path.join(skillsDir, skill.name);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      // Create skill directory
      await fs.mkdir(skillDir, { recursive: true });

      // Try to read from package skills directory
      const packageSkillPath = path.join(__dirname, '..', '..', 'skills', `${skill.name}.md`);
      let skillContent: string;

      try {
        skillContent = await fs.readFile(packageSkillPath, 'utf-8');
      } catch {
        // Fallback: generate minimal skill content
        skillContent = `---
name: ${skill.name}
description: ${skill.description}
---

# ${skill.name.charAt(0).toUpperCase() + skill.name.slice(1)}

${skill.description}

Use OntoIndex tools to accomplish this task.
`;
      }

      await fs.writeFile(skillPath, skillContent, 'utf-8');
      installedSkills.push(skill.name);
    } catch (err) {
      // Skip on error, don't fail the whole process
      console.warn(`Warning: Could not install skill ${skill.name}:`, err);
    }
  }

  return installedSkills;
}

/**
 * Generate AI context files after indexing
 */
export async function generateAIContextFiles(
  repoPath: string,
  _storagePath: string,
  projectName: string,
  stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[],
  options?: AIContextOptions,
): Promise<{ files: string[] }> {
  const groupNames = await findGroupsContainingRegistryName(projectName);
  const cliCommand = await resolveGeneratedCliCommand(repoPath);
  const content = generateOntoIndexContent(
    projectName,
    stats,
    generatedSkills,
    groupNames,
    options?.noStats,
    cliCommand,
  );
  const createdFiles: string[] = [];

  if (!options?.skipAgentsMd) {
    // Create AGENTS.md (standard for Cursor, Windsurf, OpenCode, Cline, etc.)
    const agentsPath = path.join(repoPath, 'AGENTS.md');
    const agentsResult = await upsertOntoIndexSection(agentsPath, content);
    createdFiles.push(`AGENTS.md (${agentsResult})`);

    // Create CLAUDE.md (for Claude Code)
    const claudePath = path.join(repoPath, 'CLAUDE.md');
    const claudeResult = await upsertOntoIndexSection(claudePath, content);
    createdFiles.push(`CLAUDE.md (${claudeResult})`);
  } else {
    createdFiles.push('AGENTS.md (skipped via --skip-agents-md)');
    createdFiles.push('CLAUDE.md (skipped via --skip-agents-md)');
  }

  // Install skills to .claude/skills/ontoindex/
  const installedSkills = await installSkills(repoPath);
  if (installedSkills.length > 0) {
    createdFiles.push(`.claude/skills/ontoindex/ (${installedSkills.length} skills)`);
  }

  return { files: createdFiles };
}
