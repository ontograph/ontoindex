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
import {
  MCP_FRESHNESS_GATE_GUIDANCE,
  MCP_REPO_ROOT_PLACEHOLDER,
} from '../mcp/freshness-guidance.js';

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
  /** @deprecated Counts are no longer written; this option has no effect. */
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
function generateOntoIndexContent(
  generatedSkills?: GeneratedSkillInfo[],
): string {
  const generatedRows =
    generatedSkills && generatedSkills.length > 0
      ? generatedSkills
          .map(
            (s) =>
              `- Work in the ${s.label} area (${s.symbolCount} symbols): \`.claude/skills/generated/${s.name}/SKILL.md\``,
          )
          .join('\n')
      : '';

  const skillsTable = `Skills under \`.claude/skills/ontoindex/\`: \`ontoindex-navigation/SKILL.md\`, \`ontoindex-exploring/SKILL.md\`, \`ontoindex-impact-analysis/SKILL.md\`, \`ontoindex-debugging/SKILL.md\`, \`ontoindex-refactoring/SKILL.md\`, \`ontoindex-guide/SKILL.md\`, \`ontoindex-cli/SKILL.md\`, \`ontoindex-pr-review/SKILL.md\`.${generatedRows ? '\n' + generatedRows : ''}`;

  return `${ONTOINDEX_START_MARKER}
# OntoIndex — Code Intelligence

Use OntoIndex MCP for code context. Names here are labels, never MCP \`repo\` paths.

${MCP_FRESHNESS_GATE_GUIDANCE}

Explicit maintenance only: \`ontoindex analyze\`.

## Always Do

After the gate, in order (warn on HIGH/CRITICAL impact):

1. **Explore/search** — \`search({action: "semantic", repo: "${MCP_REPO_ROOT_PLACEHOLDER}", query: "concept"})\`.
2. **Inspect context** — \`inspect({action: "context", repo: "${MCP_REPO_ROOT_PLACEHOLDER}", target: "symbolName"})\`.
3. **Impact before edits** — \`impact({action: "symbol", repo: "${MCP_REPO_ROOT_PLACEHOLDER}", target: "symbolName", direction: "upstream"})\`.
4. **Verify scope before commit** — \`audit({action: "verify_diff", repo: "${MCP_REPO_ROOT_PLACEHOLDER}", scope: "all"})\`.

## Never Do

- Never use \`impact\` before the gate or report blocked graph evidence as success.
- Rename with MCP \`refactor\`, not find-and-replace. Claim \`verify_diff\` passed only if step 4 ran.

## Resources

Use \`ontoindex://repo/{registered-name-confirmed-for-exact-current-worktree-root}/context\` etc.; resolve the name at task time.

## Cross-Repo Groups

For cross-repo work, use \`discover({action: "groups"})\`; keep local \`repo\` calls on the active root.

## CLI

${skillsTable}

${ONTOINDEX_END_MARKER}`;
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
): Promise<'created' | 'updated' | 'appended' | 'unchanged'> {
  const exists = await fileExists(filePath);

  if (!exists) {
    await fs.writeFile(filePath, content + '\n', 'utf-8');
    return 'created';
  }

  const originalContent = await fs.readFile(filePath, 'utf-8');
  const existingContent = stripMalformedOntoIndexBlocks(originalContent);

  // Check if OntoIndex section already exists
  let replaced = false;
  const newContent = existingContent.replace(ONTOINDEX_BLOCK_PATTERN, () => {
    if (replaced) return '';
    replaced = true;
    return `${content}\n`;
  });

  const finalContent = replaced
    ? newContent.trim() + '\n'
    : existingContent.trim() + '\n\n' + content + '\n';
  if (finalContent === originalContent) return 'unchanged';

  await fs.writeFile(filePath, finalContent, 'utf-8');
  return replaced ? 'updated' : 'appended';
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
      name: 'ontoindex-navigation',
      description:
        'Use first for any code task: OntoIndex tool routing, freshness labels, and what to do when a query fails.',
    },
    {
      name: 'ontoindex-pr-review',
      description:
        'Use when reviewing a pull request to understand changes, assess merge risk, and check test coverage.',
    },
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

${MCP_FRESHNESS_GATE_GUIDANCE}

## Explicit CLI maintenance

Run installed \`ontoindex analyze\` only for an explicitly requested index setup, rebuild, or maintenance task; never as the freshness gate.
`;
      }

      const existingContent = (await fileExists(skillPath))
        ? await fs.readFile(skillPath, 'utf-8')
        : undefined;
      if (existingContent !== skillContent) {
        await fs.writeFile(skillPath, skillContent, 'utf-8');
      }
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
  _projectName: string,
  _stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[],
  options?: AIContextOptions,
): Promise<{ files: string[] }> {
  const content = generateOntoIndexContent(generatedSkills);
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
