export interface WikiNavigationCommunity {
  id: string;
  label: string;
  symbolCount: number;
  fileCount?: number;
  topSymbols?: string[];
  relatedCommunities?: Array<{ label: string; count: number }>;
  provenanceCounts?: Partial<Record<'extracted' | 'inferred' | 'ambiguous', number>>;
  omittedSymbolCount?: number;
}

const PROVENANCE_ORDER: Array<keyof NonNullable<WikiNavigationCommunity['provenanceCounts']>> = [
  'extracted',
  'inferred',
  'ambiguous',
];

function esc(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/_/g, '\\_');
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function renderProvenanceCounts(
  provenanceCounts: WikiNavigationCommunity['provenanceCounts'],
): string[] {
  if (!provenanceCounts) return [];

  const lines = PROVENANCE_ORDER.flatMap((key) => {
    const count = provenanceCounts[key];
    if (count === undefined) return [];
    return [`- ${key}: ${count}`];
  });

  return lines.length > 0 ? ['## Provenance', ...lines] : [];
}

function renderRelatedCommunities(
  relatedCommunities: NonNullable<WikiNavigationCommunity['relatedCommunities']>,
): string[] {
  if (relatedCommunities.length === 0) return [];

  return [
    '## Related Communities',
    ...relatedCommunities.map((community) => `- ${esc(community.label)} (${community.count})`),
  ];
}

function renderTopSymbols(topSymbols: string[]): string[] {
  if (topSymbols.length === 0) return [];

  return ['## Top Symbols', ...topSymbols.map((symbol) => `- ${esc(symbol)}`)];
}

export function renderWikiNavigationIndex(input: {
  projectName: string;
  communities: WikiNavigationCommunity[];
}): string {
  const communities = [...input.communities].sort((a, b) => {
    if (b.symbolCount !== a.symbolCount) return b.symbolCount - a.symbolCount;
    return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
  });

  const lines: string[] = [];
  lines.push(`# ${esc(input.projectName)} Wiki Navigation`);
  lines.push('');
  lines.push('## Communities');

  for (const community of communities) {
    const parts = [formatCountLabel(community.symbolCount, 'symbol', 'symbols')];
    if (community.fileCount !== undefined) {
      parts.push(formatCountLabel(community.fileCount, 'file', 'files'));
    }
    lines.push(`- ${esc(community.label)} (${esc(community.id)}) - ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

export function renderWikiCommunityPage(input: WikiNavigationCommunity): string {
  const lines: string[] = [];
  lines.push(`# ${esc(input.label)}`);
  lines.push('');
  lines.push(`- ID: ${esc(input.id)}`);
  lines.push(`- Symbols: ${input.symbolCount}`);
  if (input.fileCount !== undefined) {
    lines.push(`- Files: ${input.fileCount}`);
  }
  if (typeof input.omittedSymbolCount === 'number' && input.omittedSymbolCount > 0) {
    lines.push(
      `- Omitted symbols: ${formatCountLabel(
        input.omittedSymbolCount,
        'symbol',
        'symbols',
      )}`,
    );
  }

  const sections = [
    renderTopSymbols(input.topSymbols ?? []),
    renderProvenanceCounts(input.provenanceCounts),
    renderRelatedCommunities(input.relatedCommunities ?? []),
  ].filter((section) => section.length > 0);

  for (const section of sections) {
    lines.push('');
    lines.push(...section);
  }

  if (typeof input.omittedSymbolCount === 'number' && input.omittedSymbolCount > 0) {
    lines.push('');
    lines.push(
      `> ${formatCountLabel(input.omittedSymbolCount, 'symbol was', 'symbols were')} omitted from this page.`,
    );
  }

  return lines.join('\n');
}
