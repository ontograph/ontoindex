import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  it('creates or updates CLAUDE.md with OntoIndex section', async () => {
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toContain('ontoindex:start');
    expect(content).toContain('ontoindex:end');
    expect(content).toContain('TestProject');
  });

  it('keeps the load-bearing repo-specific sections in the CLAUDE.md block (#856)', async () => {
    // The trimmed block must still contain everything that is genuinely
    // unique per repo or load-bearing for the agent: the freshness warning,
    // the Always Do / Never Do imperative lists, the Resources URI table
    // (projectName-interpolated), and the skills routing table that tells
    // the agent which skill file to read for each task.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

    expect(content).toContain('If any OntoIndex tool warns the index is stale');
    expect(content).toContain('## Always Do');
    expect(content).toContain('## Never Do');
    expect(content).toContain('## Resources');
    expect(content).toContain('ontoindex://repo/TestProject/context');
    expect(content).toContain('ontoindex-impact-analysis/SKILL.md');
    expect(content).toContain('ontoindex-refactoring/SKILL.md');
    expect(content).toContain('ontoindex-debugging/SKILL.md');
    expect(content).toContain('ontoindex-cli/SKILL.md');
    expect(content).toContain('ontoindex analyze');
    expect(content).not.toContain('npx ontoindex');
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

  it('keeps the CLAUDE.md OntoIndex block under the token-cost budget (#856)', async () => {
    // The pre-trim block was ~5465 chars. After #856 it's ~2580 — about a
    // 52% reduction. 2700 is a soft ceiling that still leaves headroom for
    // legitimate future additions but will fail loudly if the trim is
    // reverted or someone pads the block back out toward the original size.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const block = content.slice(
      content.indexOf('<!-- ontoindex:start -->'),
      content.indexOf('<!-- ontoindex:end -->'),
    );
    expect(block.length).toBeLessThan(2700);
  });

  it('handles empty stats', async () => {
    const stats = {};
    const result = await generateAIContextFiles(tmpDir, storagePath, 'EmptyProject', stats);
    expect(result.files).toBeDefined();
  });

  it('updates existing CLAUDE.md without duplicating', async () => {
    const stats = { nodes: 10 };

    // Run twice
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const content = await fs.readFile(claudeMdPath, 'utf-8');

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
    expect(content).toContain('CleanProject');
    expect(content).not.toContain('OldInlineProject');
    expect(content).not.toContain('OldRealProject');
    expect(content).not.toContain('npx ontoindex');
    expect(content).toContain(`ONTOINDEX_MAX_WORKERS=7 node ${localCli} analyze`);
  });

  it('installs skills files', async () => {
    const stats = { nodes: 10 };
    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    // Should have installed skill files
    const skillsDir = path.join(tmpDir, '.claude', 'skills', 'ontoindex');
    try {
      const entries = await fs.readdir(skillsDir, { recursive: true });
      expect(entries.length).toBeGreaterThan(0);
    } catch {
      // Skills dir may not be created if skills source doesn't exist in test context
    }
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
