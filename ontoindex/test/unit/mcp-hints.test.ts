import { describe, it, expect } from 'vitest';
import { getNextStepHint } from '../../src/mcp/server.js';
import { ONTOINDEX_TOOLS } from '../../src/mcp/tools.js';

describe('MCP Next-Step Hints', () => {
  it('provides a non-empty hint for every tool in ONTOINDEX_TOOLS', () => {
    for (const tool of ONTOINDEX_TOOLS) {
      const hint = getNextStepHint(tool.name, {});
      expect(hint, `Tool "${tool.name}" is missing a next-step hint`).not.toBe('');
      expect(hint, `Tool "${tool.name}" hint should start with separator`).toContain(
        '---\n**Next:**',
      );
    }
  });

  it('customizes context hint with repo parameter', () => {
    const hint = getNextStepHint('context', { repo: 'my-repo', name: 'foo' });
    expect(hint).toContain('repo: "my-repo"');
  });

  it('guides facade semantic search toward opt-in Markdown enrichment', () => {
    const hint = getNextStepHint('search', {
      action: 'semantic',
      query: 'release docs',
      repo: 'my-repo',
    });

    expect(hint).toContain('consume_enrichment_facts: true');
    expect(hint).toContain('include_markdown_context: true');
    expect(hint).toContain('repo: "my-repo"');
  });
});
