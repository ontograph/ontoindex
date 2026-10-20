import { createHash } from 'node:crypto';

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
  binding?: string;
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
  const binding =
    input.binding === undefined
      ? undefined
      : createHash('sha256').update(input.binding).digest('hex');
  const cursor = parseCursor(input.cursor, input.pageSize, binding);
  const offset = Math.max(0, Math.min(items.length, cursor.offset));
  const end = Math.min(items.length, offset + cursor.pageSize);
  const returned = end - offset;
  const hasMore = end < items.length;
  return {
    items: items.slice(offset, end),
    page: {
      current: encodeCursor({ pageSize: cursor.pageSize, offset }, binding),
      ...(hasMore
        ? { next: encodeCursor({ pageSize: cursor.pageSize, offset: end }, binding) }
        : {}),
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

function parseCursor(
  cursor: string | undefined,
  fallbackPageSize: number,
  binding?: string,
): CursorState {
  if (!Number.isSafeInteger(fallbackPageSize) || fallbackPageSize <= 0) {
    throw new Error('Invalid page size.');
  }
  if (!cursor) {
    return { pageSize: fallbackPageSize, offset: 0 };
  }
  const match =
    cursor.length <= (binding === undefined ? 64 : 128)
      ? /^gn-page-v([12]):(\d+):(\d+)(?::([a-f0-9]{64}))?$/.exec(cursor)
      : null;
  if (!match) throw new Error('Invalid cursor.');
  const [, version, pageSizeText, offsetText, cursorBinding] = match;
  if (
    (version === '1' && cursorBinding !== undefined) ||
    (version === '2' && cursorBinding === undefined) ||
    (binding === undefined && version !== '1')
  ) {
    throw new Error('Invalid cursor.');
  }
  const pageSize = Number(pageSizeText);
  const offset = Number(offsetText);
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > fallbackPageSize ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error('Invalid cursor.');
  }
  if (binding !== undefined && cursorBinding !== binding) {
    throw Object.assign(new Error('Cursor no longer matches this dataset; restart pagination.'), {
      code: 'restart_required',
      retryable: false,
    });
  }
  return {
    pageSize,
    offset,
  };
}

function encodeCursor(state: CursorState, binding?: string): string {
  if (binding !== undefined) {
    return `gn-page-v2:${state.pageSize}:${state.offset}:${binding}`;
  }
  return `${CURSOR_PREFIX}:${state.pageSize}:${state.offset}`;
}
