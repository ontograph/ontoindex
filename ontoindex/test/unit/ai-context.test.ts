import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { generateAIContextFiles } from '../../src/cli/ai-context.js';

describe('generateAIContextFiles', () => {
  let tmpDir: string;
  let storagePath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-test-'));
    storagePath = path.join(tmpDir, '.ontoindex');
    await fs.mkdir(storagePath, { recursive: true });
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('generates context files', async () => {
    const stats = {
      nodes: 100,
      edges: 200,
      processes: 10,
    };

    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    expect(result.files).toBeDefined();
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('copies the generated block to both files and preserves surrounding user instructions', async () => {
    const repoPath = path.join(tmpDir, 'preserved-user-instructions');
    const storagePath = path.join(repoPath, '.ontoindex');
    await fs.mkdir(storagePath, { recursive: true });
    const oldBlock = '<!-- ontoindex:start -->\nold generated content\n<!-- ontoindex:end -->';
    const agentsBefore = `# User heading\n\nKeep this AGENTS text.\n\n${oldBlock}\n\n# User footer\n`;
    const claudeBefore = `# User heading\n\nKeep this CLAUDE text.\n\n${oldBlock}\n\n# User footer\n`;
    await fs.writeFile(path.join(repoPath, 'AGENTS.md'), agentsBefore, 'utf-8');
    await fs.writeFile(path.join(repoPath, 'CLAUDE.md'), claudeBefore, 'utf-8');

    await generateAIContextFiles(repoPath, storagePath, 'CopiedProjectName', { nodes: 1 });

    const agents = await fs.readFile(path.join(repoPath, 'AGENTS.md'), 'utf-8');
    const claude = await fs.readFile(path.join(repoPath, 'CLAUDE.md'), 'utf-8');
    const blockPattern = /<!-- ontoindex:start -->[\s\S]*?<!-- ontoindex:end -->/;
    const agentsBlock = agents.match(blockPattern)?.[0];
    const claudeBlock = claude.match(blockPattern)?.[0];

    expect(agentsBlock).toBeDefined();
    expect(claudeBlock).toBe(agentsBlock);
    for (const content of [agents, claude]) {
      expect(content).toContain('# User heading');
      expect(content).toContain('# User footer');
      expect(content).toContain('Keep this');
      expect(content).not.toContain('CopiedProjectName');
      expect(content).toContain('repo: "<absolute exact current worktree root>"');
    }
  });

  it('creates or updates CLAUDE.md with OntoIndex section', async () => {
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toContain('ontoindex:start');
    expect(content).toContain('ontoindex:end');
    expect(content).toContain('exact current worktree root');
  });

  it('keeps the load-bearing repo-specific sections in the CLAUDE.md block (#856)', async () => {
    // The trimmed block must still contain everything that is genuinely
    // load-bearing for the agent: the exact-root freshness gate,
    // the Always Do / Never Do imperative lists, the Resources URI table
    // portable resource templates, and the skills routing table that tells
    // the agent which skill file to read for each task.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

    expect(content).toContain('## Freshness gate');
    expect(content).toContain('## Always Do');
    expect(content).toContain('## Never Do');
    expect(content).toContain('## Resources');
    expect(content).toContain(
      'ontoindex://repo/{registered-name-confirmed-for-exact-current-worktree-root}/context',
    );
    expect(content).toContain('ontoindex-impact-analysis/SKILL.md');
    expect(content).toContain('ontoindex-refactoring/SKILL.md');
    expect(content).toContain('ontoindex-debugging/SKILL.md');
    expect(content).toContain('ontoindex-cli/SKILL.md');
    expect(content).toContain('ontoindex-pr-review/SKILL.md');
    expect(content).toContain('ontoindex analyze');
    expect(content).not.toContain('npx ontoindex');
  });

  it('generates a fail-closed exact-worktree freshness gate', async () => {
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

    // Concise ordered ladder: explore/search -> inspect -> impact -> verify-diff.
    const explore = content.indexOf('1. **Explore/search**');
    const inspect = content.indexOf('2. **Inspect context**');
    const impact = content.indexOf('3. **Impact before edits**');
    const verify = content.indexOf('4. **Verify scope before commit**');
    expect(explore).toBeGreaterThan(-1);
    expect(inspect).toBeGreaterThan(explore);
    expect(impact).toBeGreaterThan(inspect);
    expect(verify).toBeGreaterThan(impact);
    const root = '<absolute exact current worktree root>';
    expect(content).toContain(
      `manage({action: "ensure_fresh", repo: "${root}", autoAnalyze: true})`,
    );
    expect(content).toContain(
      `manage({action: "analyze_job", repo: "${root}", jobId: "<returned jobId>"})`,
    );
    expect(content).toContain('analysisSubmission.status');
    expect(content).toContain('"queued"');
    expect(content).toContain('"reused"');
    expect(content).toContain('job.status === "complete"');
    expect(content).toContain('job.exitCode === 0');
    expect(content).toContain('rerun');
    expect(content).toContain('isStale === false');
    expect(content).toContain('runtime health must not be degraded or untrusted');
    expect(content).toContain('needsAnalysis: true');
    expect(content).toContain('Stale graph output is never evidence');
    expect(content).toContain('Check uncommitted changes against source and diff.');
    expect(content).toContain('Do not use local wrappers or `ontoindex analyze` as a freshness gate');
    expect(content).toContain('Explicit maintenance only');
    expect(content).toContain('ontoindex analyze');
    expect(content).not.toContain('Use stale/refreshing results with freshness labels');
    expect(content).not.toContain('repo: "TestProject"');
    expect(content).not.toContain('ontoindex://repo/TestProject/');
  });

  it('only names gn_* tools available in the core startup profile', async () => {
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', { nodes: 50 });

    const coreTools = new Set([
      'gn_help',
      'gn_tool_contract',
      'gn_diagnose',
      'gn_ensure_fresh',
      'gn_analyze_job',
      'gn_quality_mode',
    ]);
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      const content = await fs.readFile(path.join(tmpDir, filename), 'utf-8');
      const hiddenTools = (content.match(/\bgn_[a-z_]+\b/g) || []).filter(
        (tool) => !coreTools.has(tool),
      );
      expect(hiddenTools).toEqual([]);
    }
  });

  it('does not duplicate content that already lives in skill files (#856)', async () => {
    // The six sections listed in issue #856 are redundant with the skill
    // files shipped alongside the CLAUDE.md block (both are loaded into
    // every Claude Code session). Their absence is the whole point of the
    // trim — assert each header is gone so a future regression that pads
    // the block back out fails here.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

    expect(content).not.toContain('## Tools Quick Reference');
    expect(content).not.toContain('## Impact Risk Levels');
    expect(content).not.toContain('## Self-Check Before Finishing');
    expect(content).not.toContain('## When Debugging');
    expect(content).not.toContain('## When Refactoring');
    expect(content).not.toContain('## Keeping the Index Fresh');
  });

  it('keeps the CLAUDE.md OntoIndex block under the token-cost budget', async () => {
    // Preserve the established compact block budget while keeping the fail-closed gate.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const block = content.slice(
      content.indexOf('<!-- ontoindex:start -->'),
      content.indexOf('<!-- ontoindex:end -->'),
    );
    expect(block.length).toBeLessThan(3000);
  });

  it('handles empty stats', async () => {
    const stats = {};
    const result = await generateAIContextFiles(tmpDir, storagePath, 'EmptyProject', stats);
    expect(result.files).toBeDefined();
  });

  it.each([undefined, false, true])(
    'omits counts regardless of stats and noStats=%s',
    async (noStats) => {
      for (const stats of [{}, { nodes: 123, edges: 456, processes: 789 }]) {
        await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats, undefined, {
          noStats,
        });
        for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
          const content = await fs.readFile(path.join(tmpDir, filename), 'utf-8');
          expect(content).not.toContain('TestProject');
          expect(content).not.toContain('symbols,');
        }
      }
    },
  );

  it('preserves content and mtimes on a second generation with different stats', async () => {
    const repoPath = path.join(tmpDir, 'stable-context-repo');
    const repoStoragePath = path.join(repoPath, '.ontoindex');
    await fs.mkdir(repoStoragePath, { recursive: true });
    const firstResult = await generateAIContextFiles(repoPath, repoStoragePath, 'StableProject', {
      nodes: 10,
      edges: 20,
      processes: 3,
    });
    expect(firstResult.files).toContain('AGENTS.md (created)');
    expect(firstResult.files).toContain('CLAUDE.md (created)');

    const skillsDir = path.join(repoPath, '.claude', 'skills', 'ontoindex');
    const skills = await fs.readdir(skillsDir);
    expect(skills.length).toBeGreaterThan(0);
    const files = [
      path.join(repoPath, 'AGENTS.md'),
      path.join(repoPath, 'CLAUDE.md'),
      ...skills.map((skill) => path.join(skillsDir, skill, 'SKILL.md')),
    ];
    const before = new Map<string, { content: string; mtimeMs: number }>();
    const oldTime = new Date('2000-01-01T00:00:00Z');
    for (const file of files) {
      await fs.utimes(file, oldTime, oldTime);
      before.set(file, {
        content: await fs.readFile(file, 'utf-8'),
        mtimeMs: (await fs.stat(file)).mtimeMs,
      });
    }

    const secondResult = await generateAIContextFiles(repoPath, repoStoragePath, 'StableProject', {
      nodes: 100,
      edges: 200,
      processes: 30,
    });
    expect(secondResult.files).toContain('AGENTS.md (unchanged)');
    expect(secondResult.files).toContain('CLAUDE.md (unchanged)');
    expect(secondResult.files).toContain(`.claude/skills/ontoindex/ (${skills.length} skills)`);
    for (const file of files) {
      expect({
        content: await fs.readFile(file, 'utf-8'),
        mtimeMs: (await fs.stat(file)).mtimeMs,
      }).toEqual(before.get(file));
    }
  });

  it('updates existing CLAUDE.md without duplicating', async () => {
    const stats = { nodes: 10 };

    // Run twice and require the update to be byte-identical.
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const firstContent = await fs.readFile(claudeMdPath, 'utf-8');
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toBe(firstContent);

    // Should only have one ontoindex section
    const starts = (content.match(/ontoindex:start/g) || []).length;
    const ends = (content.match(/ontoindex:end/g) || []).length;
    expect(starts).toBe(1);
    expect(ends).toBe(1);
  });

  it('removes malformed marker prose and duplicate generated blocks', async () => {
    const repoPath = path.join(tmpDir, 'malformed-marker-repo');
    const repoStoragePath = path.join(repoPath, '.ontoindex');
    const localCli = path.join(repoPath, 'ontoindex', 'dist', 'cli', 'index.js');
    await fs.mkdir(path.dirname(localCli), { recursive: true });
    await fs.writeFile(localCli, '', 'utf-8');
    await fs.mkdir(repoStoragePath, { recursive: true });

    await fs.writeFile(
      path.join(repoPath, 'CLAUDE.md'),
      `# CLAUDE

See the \`<!-- ontoindex:start -->
# OntoIndex — Code Intelligence

This project is indexed by OntoIndex as **OldInlineProject** (1 symbols, 2 relationships, 3 execution flows).

<!-- ontoindex:end -->\` block in AGENTS.md.

<!-- ontoindex:start -->
# OntoIndex — Code Intelligence

This project is indexed by OntoIndex as **OldRealProject** (4 symbols, 5 relationships, 6 execution flows).

<!-- ontoindex:end -->
`,
      'utf-8',
    );

    await generateAIContextFiles(
      repoPath,
      repoStoragePath,
      'CleanProject',
      { nodes: 10, edges: 20, processes: 3 },
      undefined,
      { skipAgentsMd: true },
    );
    await generateAIContextFiles(repoPath, repoStoragePath, 'CleanProject', {
      nodes: 10,
      edges: 20,
      processes: 3,
    });

    const content = await fs.readFile(path.join(repoPath, 'CLAUDE.md'), 'utf-8');
    const starts = content.match(/<!-- ontoindex:start -->/g) || [];
    const ends = content.match(/<!-- ontoindex:end -->/g) || [];
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(content).toContain('exact current worktree root');
    expect(content).not.toContain('CleanProject');
    expect(content).not.toContain('OldInlineProject');
    expect(content).not.toContain('OldRealProject');
    expect(content).not.toContain('npx ontoindex');
    expect(content).toContain('Explicit maintenance only');
    expect(content).not.toContain(localCli);
    expect(content).not.toContain('repo: "CleanProject"');
    expect(content).not.toContain('ontoindex://repo/CleanProject/');
  });

  it('installs skills files', async () => {
    const stats = { nodes: 10 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const skillsDir = path.join(tmpDir, '.claude', 'skills', 'ontoindex');
    const skillNames = [
      'ontoindex-cli',
      'ontoindex-debugging',
      'ontoindex-exploring',
      'ontoindex-guide',
      'ontoindex-impact-analysis',
      'ontoindex-navigation',
      'ontoindex-pr-review',
      'ontoindex-refactoring',
    ];
    expect((await fs.readdir(skillsDir)).sort()).toEqual(skillNames);

    for (const skillName of skillNames) {
      const packagedSkill = await fs.readFile(
        new URL(`../../skills/${skillName}.md`, import.meta.url),
        'utf-8',
      );
      const installedSkill = await fs.readFile(
        path.join(skillsDir, skillName, 'SKILL.md'),
        'utf-8',
      );
      expect(installedSkill).toBe(packagedSkill);
      expect(installedSkill).not.toContain('Use stale/refreshing results with freshness labels');
      expect(installedSkill).not.toContain('Run: ontoindex analyze');
      expect(installedSkill).not.toContain('npx ontoindex analyze');
      if (skillName === 'ontoindex-cli') {
        expect(installedSkill).toContain('ontoindex analyze [path]');
        expect(installedSkill).toContain('explicitly asks to operate the CLI');
        expect(installedSkill).toContain(
          'never run a local wrapper, `reindex.sh`, or `ontoindex analyze` as a substitute',
        );
      } else {
        expect(installedSkill).not.toContain('ontoindex analyze [path]');
      }
    }
  });

  it('uses the fail-closed freshness gate when a packaged skill is unavailable', async () => {
    const repoPath = path.join(tmpDir, 'fallback-skill');
    const storagePath = path.join(repoPath, '.ontoindex');
    await fs.mkdir(storagePath, { recursive: true });
    const readFileSpy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('missing packaged skill'), { code: 'ENOENT' }));

    try {
      await generateAIContextFiles(repoPath, storagePath, 'FallbackProject', { nodes: 1 });
    } finally {
      readFileSpy.mockRestore();
    }

    const fallback = await fs.readFile(
      path.join(repoPath, '.claude', 'skills', 'ontoindex', 'ontoindex-navigation', 'SKILL.md'),
      'utf-8',
    );
    expect(fallback).toContain('exact current worktree root');
    expect(fallback).toContain('analysisSubmission.status');
    expect(fallback).toContain('job.status === "complete"');
    expect(fallback).toContain('job.exitCode === 0');
    expect(fallback).toContain('Stale graph output is never evidence');
    expect(fallback).toContain(
      'Do not use local wrappers or `ontoindex analyze` as a freshness gate',
    );
    expect(fallback).toContain('Run installed `ontoindex analyze` only for an explicitly requested');
    expect(fallback).not.toContain('repo: "FallbackProject"');
  });

  it('preserves manual AGENTS.md and CLAUDE.md edits when skipAgentsMd is enabled', async () => {
    const stats = { nodes: 42, edges: 84, processes: 3 };
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const agentsContent = '# AGENTS\n\nCustom manual instructions only\n';
    const claudeContent = '# CLAUDE\n\nCustom manual instructions only\n';

    await fs.writeFile(agentsPath, agentsContent, 'utf-8');
    await fs.writeFile(claudePath, claudeContent, 'utf-8');

    const result = await generateAIContextFiles(
      tmpDir,
      storagePath,
      'TestProject',
      stats,
      undefined,
      { skipAgentsMd: true },
    );

    expect(result.files).toContain('AGENTS.md (skipped via --skip-agents-md)');
    expect(result.files).toContain('CLAUDE.md (skipped via --skip-agents-md)');

    const agentsAfter = await fs.readFile(agentsPath, 'utf-8');
    const claudeAfter = await fs.readFile(claudePath, 'utf-8');
    expect(agentsAfter).toBe(agentsContent);
    expect(claudeAfter).toBe(claudeContent);
  });
});
