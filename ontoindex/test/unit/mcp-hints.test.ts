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

    expect(hint).toContain('retrieval_policy: "graph-with-passive-docs"');
    expect(hint).toContain('repo: "my-repo"');
  });

  it('does not re-suggest docs when a docs retrieval policy is set', () => {
    const hint = getNextStepHint('search', {
      action: 'semantic',
      query: 'x',
      retrieval_policy: 'graph-with-passive-docs',
    });

    expect(hint).not.toContain('rerun search');
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
