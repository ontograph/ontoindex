import { describe, expect, it } from 'vitest';
import {
  renderWikiCommunityPage,
  renderWikiNavigationIndex,
  type WikiNavigationCommunity,
} from '../../src/core/wiki/navigation-pages.js';

describe('renderWikiNavigationIndex', () => {
  it('sorts communities by symbol count descending', () => {
    const communities: WikiNavigationCommunity[] = [
      { id: 'gamma', label: 'Gamma', symbolCount: 7 },
      { id: 'alpha', label: 'Alpha', symbolCount: 12, fileCount: 3 },
      { id: 'beta', label: 'Beta', symbolCount: 15 },
    ];

    const output = renderWikiNavigationIndex({
      projectName: 'Project X',
      communities,
    });

    const alphaIndex = output.indexOf('Alpha');
    const betaIndex = output.indexOf('Beta');
    const gammaIndex = output.indexOf('Gamma');

    expect(betaIndex).toBeLessThan(alphaIndex);
    expect(alphaIndex).toBeLessThan(gammaIndex);
    expect(output).toContain('# Project X Wiki Navigation');
    expect(output).toContain('15 symbols');
    expect(output).toContain('3 files');
  });
});

describe('renderWikiCommunityPage', () => {
  it('renders top symbols, provenance counts, and omitted-symbol notice', () => {
    const output = renderWikiCommunityPage({
      id: 'community-1',
      label: 'Community One',
      symbolCount: 8,
      fileCount: 2,
      topSymbols: ['alpha()', 'beta[]'],
      relatedCommunities: [{ label: 'Related Team', count: 4 }],
      provenanceCounts: {
        extracted: 5,
        inferred: 2,
        ambiguous: 1,
      },
      omittedSymbolCount: 3,
    });

    expect(output).toContain('# Community One');
    expect(output).toContain('- ID: community-1');
    expect(output).toContain('- Symbols: 8');
    expect(output).toContain('- Files: 2');
    expect(output).toContain('## Top Symbols');
    expect(output).toContain('- alpha\\(\\)');
    expect(output).toContain('- beta\\[\\]');
    expect(output).toContain('## Provenance');
    expect(output).toContain('- extracted: 5');
    expect(output).toContain('- inferred: 2');
    expect(output).toContain('- ambiguous: 1');
    expect(output).toContain('## Related Communities');
    expect(output).toContain('- Related Team (4)');
    expect(output).toContain('> 3 symbols were omitted from this page.');
  });

  it('omits optional sections when not provided', () => {
    const output = renderWikiCommunityPage({
      id: 'community-2',
      label: 'Community Two',
      symbolCount: 1,
    });

    expect(output).toContain('# Community Two');
    expect(output).not.toContain('## Top Symbols');
    expect(output).not.toContain('## Provenance');
    expect(output).not.toContain('## Related Communities');
    expect(output).not.toContain('omitted from this page');
  });
});
