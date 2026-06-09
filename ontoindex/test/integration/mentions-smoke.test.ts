/**
 * Integration Test: MENTIONS Smoke Test (T-2.1.09)
 *
 * Verifies that the analyzer emits MENTIONS edges linking Markdown sections
 * to code symbols mentioned in them.
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processMarkdown } from '../../src/core/ingestion/markdown-processor.js';

describe('MENTIONS Smoke Test', () => {
  it('emits MENTIONS edges when symbols are mentioned in markdown', async () => {
    const graph = createKnowledgeGraph();

    // 1. Pre-populate graph with code symbols and the markdown file
    graph.addNode({
      id: 'File:README.md',
      label: 'File',
      domain: 'doc',
      properties: { name: 'README.md', filePath: 'README.md' },
    });

    graph.addNode({
      id: 'Function:src/auth.ts:login',
      label: 'Function',
      domain: 'code',
      properties: { name: 'login', filePath: 'src/auth.ts' },
    });

    graph.addNode({
      id: 'Class:src/models.ts:User',
      label: 'Class',
      domain: 'code',
      properties: { name: 'User', filePath: 'src/models.ts' },
    });

    // 2. Mock markdown file
    const mdFiles = [
      {
        path: 'README.md',
        content: '# Auth\n\nUse the `login` function to authenticate a `User` object.',
      },
    ];

    // 3. Process markdown
    processMarkdown(graph, mdFiles, new Set(['README.md', 'src/auth.ts', 'src/models.ts']));

    // 4. Verify MENTIONS edges
    const rels = graph.relationships.filter((r) => r.type === 'MENTIONS');

    // We expect at least 2 mentions: login and User
    expect(rels.length).toBeGreaterThanOrEqual(2);

    const targets = rels.map((r) => r.targetId);
    expect(targets).toContain('Function:src/auth.ts:login');
    expect(targets).toContain('Class:src/models.ts:User');
  });

  it('stores section body content for markdown embedding', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'File:docs/security.md',
      label: 'File',
      domain: 'doc',
      properties: { name: 'security.md', filePath: 'docs/security.md' },
    });

    processMarkdown(
      graph,
      [
        {
          path: 'docs/security.md',
          content:
            '# Sanitization Rules\n\nAccess tokens and user paths must be redacted.\n\n## Examples\n\nUse stable placeholders.',
        },
      ],
      new Set(['docs/security.md']),
    );

    const section = graph.nodes.find(
      (node) => node.label === 'Section' && node.properties.name === 'Sanitization Rules',
    );

    expect(section?.properties.content).toContain('Access tokens and user paths');
    expect(section?.properties.content).toContain('## Examples');
  });
});
