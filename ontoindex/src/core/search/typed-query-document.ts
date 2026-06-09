export const TYPED_QUERY_LINE_TYPES = [
  'intent',
  'filter',
  'symbol',
  'file',
  'lex',
  'vec',
  'graph',
  'hyde',
] as const;

export type TypedQueryLineType = (typeof TYPED_QUERY_LINE_TYPES)[number];
export type SearchableTypedQueryLineType = Exclude<TypedQueryLineType, 'intent' | 'filter'>;

export type FilterField = 'kind' | 'filePath' | 'repo' | 'language' | 'freshness' | 'capability';
export type FilterOperator = '=' | '!=' | '~';

export interface TypedQueryFilter {
  field: FilterField;
  operator: FilterOperator;
  value: string;
  lineNumber: number;
}

export interface TypedQueryLine {
  type: SearchableTypedQueryLineType;
  query: string;
  lineNumber: number;
}

export interface TypedQueryRequest {
  intent?: string;
  filters?: TypedQueryFilter[];
  lines: TypedQueryLine[];
}

export type TypedQueryDocumentParseErrorCode =
  | 'UNKNOWN_TYPE'
  | 'DUPLICATE_INTENT'
  | 'INTENT_ALONE'
  | 'EMPTY_LINE_VALUE'
  | 'INVALID_FILTER_FORMAT'
  | 'UNSUPPORTED_FILTER_FIELD'
  | 'UNSUPPORTED_FILTER_OPERATOR';

export class TypedQueryDocumentParseError extends Error {
  constructor(
    message: string,
    public readonly code: TypedQueryDocumentParseErrorCode,
    public readonly lineNumber?: number,
  ) {
    super(message);
    this.name = 'TypedQueryDocumentParseError';
  }
}

const ALLOWED_TYPES = new Set<string>(TYPED_QUERY_LINE_TYPES);
const TYPED_LINE_PATTERN = /^([A-Za-z]+)\s*:\s*(.*)$/;

export function parseTypedQueryDocument(input: string): TypedQueryRequest {
  const request: TypedQueryRequest = { lines: [] };

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const match = TYPED_LINE_PATTERN.exec(line);
    if (!match) {
      request.lines.push({ type: 'lex', query: line, lineNumber });
      continue;
    }

    const [, rawType, rawQuery] = match;
    const type = rawType.toLowerCase();
    const query = rawQuery.trim();

    if (!ALLOWED_TYPES.has(type)) {
      throw new TypedQueryDocumentParseError(
        `Unknown typed query line type "${rawType}" on line ${lineNumber}`,
        'UNKNOWN_TYPE',
        lineNumber,
      );
    }

    if (query.length === 0) {
      throw new TypedQueryDocumentParseError(
        `Typed query line "${rawType}" on line ${lineNumber} must include a value`,
        'EMPTY_LINE_VALUE',
        lineNumber,
      );
    }

    if (type === 'intent') {
      if (request.intent !== undefined) {
        throw new TypedQueryDocumentParseError(
          `Duplicate intent line on line ${lineNumber}`,
          'DUPLICATE_INTENT',
          lineNumber,
        );
      }
      request.intent = query;
      continue;
    }

    if (type === 'filter') {
      const filterMatch = query.match(/^([a-zA-Z]+)\s*(=|!=|~)\s*(.*)$/);
      if (!filterMatch) {
        throw new TypedQueryDocumentParseError(
          `Invalid filter format on line ${lineNumber}`,
          'INVALID_FILTER_FORMAT',
          lineNumber,
        );
      }
      const [, rawField, operator, value] = filterMatch;
      const field = rawField as FilterField;
      if (!['kind', 'filePath', 'repo', 'language', 'freshness', 'capability'].includes(field)) {
        throw new TypedQueryDocumentParseError(
          `Unsupported filter field "${rawField}" on line ${lineNumber}`,
          'UNSUPPORTED_FILTER_FIELD',
          lineNumber,
        );
      }
      if (!['=', '!=', '~'].includes(operator)) {
        throw new TypedQueryDocumentParseError(
          `Unsupported filter operator "${operator}" on line ${lineNumber}`,
          'UNSUPPORTED_FILTER_OPERATOR',
          lineNumber,
        );
      }
      if (!request.filters) {
        request.filters = [];
      }
      request.filters.push({
        field,
        operator: operator as FilterOperator,
        value: value.trim(),
        lineNumber,
      });
      continue;
    }

    request.lines.push({
      type: type as SearchableTypedQueryLineType,
      query,
      lineNumber,
    });
  }

  if (request.intent !== undefined && request.lines.length === 0) {
    throw new TypedQueryDocumentParseError(
      'Typed query document must include at least one searchable line when intent is provided',
      'INTENT_ALONE',
    );
  }

  return request;
}
