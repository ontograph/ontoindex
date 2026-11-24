/** List properties whose LadybugDB COPY representation must be restored with typed parameters. */
export const STRING_ARRAY_PROPERTIES = {
  Community: ['keywords'],
  Process: ['communities'],
  SummaryNode: [
    'summarizedCommunityIds',
    'summarizedConceptIds',
    'summarizedNodeIds',
    'sourceDocuments',
    'sourceFactKeys',
    'resolutionKeys',
  ],
  Concept: ['aliases', 'sourceDocuments', 'sourceFactKeys', 'resolutionKeys'],
  Route: ['responseKeys', 'errorKeys', 'middleware'],
} as const satisfies Record<string, readonly string[]>;

export const EMPTY_STRING_ARRAY_LITERAL = '[]';

export const isStringArrayProperty = (label: string, property: string): boolean =>
  (
    STRING_ARRAY_PROPERTIES as Readonly<Record<string, readonly string[]>>
  )[label]?.includes(property) ?? false;

export const normalizeStringArrayProperty = (
  label: string,
  property: string,
  value: unknown,
): string[] => {
  if (!Array.isArray(value)) return [];
  const dropEmpty = label === 'Concept' || label === 'SummaryNode';
  return value.filter(
    (item): item is string =>
      typeof item === 'string' && (!dropEmpty || item.length > 0),
  );
};
