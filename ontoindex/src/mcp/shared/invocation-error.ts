const invocationErrorMarker = Symbol.for('ontoindex.invocationError');

/** Reserved marker survives object spread but is omitted by JSON serialization. */
export function markInvocationError<T extends object>(result: T): T {
  Object.defineProperty(result, invocationErrorMarker, { value: true, enumerable: true });
  return result;
}

export function isMarkedInvocationError(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    (result as Record<symbol, unknown>)[invocationErrorMarker] === true
  );
}
