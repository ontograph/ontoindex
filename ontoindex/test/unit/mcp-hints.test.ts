import { describe, it, expect } from 'vitest';
import { getNextStepHint } from '../../src/mcp/server.js';
import { INTERNAL_TOOL_HANDLERS, ONTOINDEX_TOOLS } from '../../src/mcp/tools.js';

describe('MCP Next-Step Hints', () => {
  it('keeps committed navigation explicit without offering live enrichment', () => {
    for (const [tool, action] of [
      ['search', 'semantic'],
      ['inspect', 'context'],
    ]) {
      const hint = getNextStepHint(tool, { action, repo: 'fixture', read_mode: 'committed' });
      expect(hint).toContain('read_mode: "committed"');
      expect(hint).toContain('repo: "fixture"');
      expect(hint).not.toContain('consume_enrichment_facts: true');
    }
    const hint = getNextStepHint('search', { action: 'semantic', read_mode: 'committed' });
    expect(hint).toContain('last index');
    expect(hint).toContain('readContext.sourceProvenance');
    expect(hint).toContain('readContext.workingTreeIncluded');
    expect(hint).toContain('Manual overlays and live enrichment remain excluded.');
    expect(hint).not.toContain('Uncommitted source and live enrichment remain excluded.');
  });

  it.each([undefined, 'workspace'])(
    'preserves repository and explicit %s mode throughout hints',
    (read_mode) => {
      for (const tool of [...ONTOINDEX_TOOLS, ...INTERNAL_TOOL_HANDLERS]) {
        const hint = getNextStepHint(tool.name, { repo: 'my-repo', read_mode });
        expect(hint, tool.name).toContain('repo: "my-repo"');
        if (read_mode) expect(hint, tool.name).toContain('read_mode: "workspace"');
        for (const call of hint.matchAll(/\(\{([^{}]*)\}\)/g)) {
          expect(call[1], `${tool.name}: ${call[0]}`).toContain('repo: "my-repo"');
          if (read_mode) {
            expect(call[1], `${tool.name}: ${call[0]}`).toContain('read_mode: "workspace"');
          }
        }
      }
    },
  );

  it.each([
    {},
    { consume_enrichment_facts: true },
    { consume_enrichment_facts: true, include_markdown_context: true },
  ])('never suggests enrichment for explicit workspace navigation: %j', (enrichment) => {
    const hint = getNextStepHint('search', {
      action: 'semantic',
      read_mode: 'workspace',
      ...enrichment,
    });
    expect(hint).toContain('read_mode: "workspace"');
    expect(hint).not.toMatch(
      /consume_enrichment_facts|include_passive_related_facts|include_markdown_context|include_markdown_ppr|include_lsp_refs/,
    );
  });
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

  it('clarifies the CLI equivalent for list_repos', () => {
    const hint = getNextStepHint('list_repos', {});

    expect(hint).toContain('ontoindex://repo/{name}/context');
    expect(hint).toContain('CLI equivalent is `ontoindex list`');
  });

  it('uses current facade calls in next-step hints', () => {
    expect(getNextStepHint('query', { repo: 'my-repo' })).toContain(
      'inspect({action: "context", name: "<symbol_name>", repo: "my-repo"})',
    );
    expect(getNextStepHint('impact', { repo: 'my-repo' })).toContain(
      'Review depth-1 direct dependents first; they are the closest dependents, not proof of breakage.',
    );
    expect(getNextStepHint('detect_changes', { repo: 'my-repo' })).toContain(
      'gn_verify_diff({ expectedFiles:',
    );
    expect(getNextStepHint('cycle_detect', { repo: 'my-repo' })).toContain(
      'impact({action: "symbol", target:',
    );
    expect(getNextStepHint('coupling_matrix', { repo: 'my-repo' })).toContain(
      'search({action: "semantic", query:',
    );
    expect(getNextStepHint('rename', { repo: 'my-repo' })).toContain('refactor({action: "rename"');
    expect(getNextStepHint('evidence_pack', { repo: 'my-repo' })).toContain(
      'inspect({action: "context", name:',
    );
    expect(getNextStepHint('verification_gap', { repo: 'my-repo' })).toContain('gn_test_gap({');
  });

  it('never points agents at removed tool-call syntax', () => {
    const legacy =
      /(?<![\w.])(context|query|cypher|repomap|evidence_pack|list_repos|verification_gap|api_impact|detect_changes)\(|impact\(\{(?!action)|ontoindex_(query|context|impact|detect_changes|rename|cypher)|WILL BREAK/;
    for (const tool of ONTOINDEX_TOOLS) {
      const hint = getNextStepHint(tool.name, { repo: 'my-repo', name: 'foo' });
      expect(hint, `Tool "${tool.name}" hint uses a removed tool name`).not.toMatch(legacy);
    }
  });
});
