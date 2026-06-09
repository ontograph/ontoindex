import { describe, it, expect, vi } from 'vitest';
import { processMarkdownForLiveDiagrams } from '../../../src/core/wiki/live-mermaid.js';

// ─── Mock pool-adapter ─────────────────────────────────────────────────────
vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn().mockResolvedValue([
    { fromName: 'A', toName: 'B' },
    { fromName: 'B', toName: 'C' },
  ]),
}));

describe('live-mermaid', () => {
  it('replaces call_flow tags with mermaid blocks', async () => {
    const md = `
# Title
<!-- gn-mermaid: call_flow MATCH (n) RETURN n -->
Footer
`;
    const repo = { id: 'test-repo' };
    const processed = await processMarkdownForLiveDiagrams(md, repo);

    expect(processed).toContain('```mermaid');
    expect(processed).toContain('flowchart LR');
    expect(processed).toContain('A --> B');
    expect(processed).toContain('B --> C');
    expect(processed).not.toContain('<!-- gn-mermaid');
  });

  it('handles empty results gracefully', async () => {
    const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');
    vi.mocked(executeParameterized).mockResolvedValueOnce([]);

    const md = `<!-- gn-mermaid: call_flow EMPTY -->`;
    const processed = await processMarkdownForLiveDiagrams(md, { id: 'test' });

    expect(processed).toContain('*(No data for diagram)*');
  });

  it('handles query errors gracefully', async () => {
    const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');
    vi.mocked(executeParameterized).mockRejectedValueOnce(new Error('Syntax error'));

    const md = `<!-- gn-mermaid: call_flow ERROR -->`;
    const processed = await processMarkdownForLiveDiagrams(md, { id: 'test' });

    expect(processed).toContain('**Error rendering diagram:** Syntax error');
  });
});
