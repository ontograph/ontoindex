export type McpResponseMode = 'full' | 'summary' | 'minimal';

export interface McpResponseCursor {
  current: string;
  next?: string;
  pageSize: number;
  offset: number;
  returned: number;
  total: number;
  hasMore: boolean;
}

interface CursorState {
  pageSize: number;
  offset: number;
}

interface PaginateMcpItemsInput {
  pageSize: number;
  cursor?: string;
}

interface PaginateMcpItemsResult<T> {
  items: T[];
  page: McpResponseCursor;
}

const CURSOR_PREFIX = 'gn-page-v1';

export function resolveMcpResponseMode(options: {
  summary?: boolean;
  minimal?: boolean;
}): McpResponseMode {
  if (options.minimal) return 'minimal';
  if (options.summary) return 'summary';
  return 'full';
}

export function paginateMcpItems<T>(
  items: readonly T[],
  input: PaginateMcpItemsInput,
): PaginateMcpItemsResult<T> {
  const cursor = parseCursor(input.cursor, input.pageSize);
  const offset = Math.max(0, Math.min(items.length, cursor.offset));
  const end = Math.min(items.length, offset + cursor.pageSize);
  const returned = end - offset;
  const hasMore = end < items.length;
  return {
    items: items.slice(offset, end),
    page: {
      current: encodeCursor({ pageSize: cursor.pageSize, offset }),
      ...(hasMore ? { next: encodeCursor({ pageSize: cursor.pageSize, offset: end }) } : {}),
      pageSize: cursor.pageSize,
      offset,
      returned,
      total: items.length,
      hasMore,
    },
  };
}

export function shouldExposeCursor(cursor: McpResponseCursor): boolean {
  return cursor.hasMore || cursor.offset > 0;
}

function parseCursor(cursor: string | undefined, fallbackPageSize: number): CursorState {
  if (!cursor) {
    return { pageSize: fallbackPageSize, offset: 0 };
  }
  const match = /^gn-page-v1:(\d+):(\d+)$/.exec(cursor);
  if (!match) throw new Error(`Invalid cursor: ${cursor}`);
  const [, pageSizeText, offsetText] = match;
  return {
    pageSize: Number.parseInt(pageSizeText, 10),
    offset: Number.parseInt(offsetText, 10),
  };
}

function encodeCursor(state: CursorState): string {
  return `${CURSOR_PREFIX}:${state.pageSize}:${state.offset}`;
}
