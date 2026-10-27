export class ScopeUnsupportedSyntaxError extends Error {
  constructor(
    message: string,
    node?: { type: string; startPosition: { row: number; column: number } },
  ) {
    const kind = node?.type;
    const position = node?.startPosition;
    const row = position?.row;
    const column = position?.column;
    const context =
      typeof kind === 'string' &&
      /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.exec(kind)?.[0] === kind &&
      typeof row === 'number' &&
      Number.isSafeInteger(row) &&
      row >= 0 &&
      row < Number.MAX_SAFE_INTEGER &&
      typeof column === 'number' &&
      Number.isSafeInteger(column) &&
      column >= 0 &&
      column < Number.MAX_SAFE_INTEGER
        ? ` [node=${kind} at=${row + 1}:${column + 1}]`
        : '';
    super(`${message}${context}`);
    this.name = 'ScopeUnsupportedSyntaxError';
  }
}

export const isScopeUnsupportedSyntax = (e: unknown): e is ScopeUnsupportedSyntaxError =>
  e instanceof ScopeUnsupportedSyntaxError;
