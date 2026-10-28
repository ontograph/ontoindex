/** Leave malformed file paths for the retention stage's own validation. */
export function retainableByFile<T>(
  items: readonly T[],
  filePathOf: (item: T) => unknown,
  hasScopeHook: (filePath: string) => boolean,
): readonly T[] {
  let retained: T[] | undefined;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const filePath = filePathOf(item);
    if (typeof filePath === 'string' && !hasScopeHook(filePath)) {
      retained ??= items.slice(0, index);
    } else {
      retained?.push(item);
    }
  }
  return retained ?? items;
}

/**
 * Without changing the live graph, drop regenerated Section nodes, nodes whose file has a known language without a scope hook, and every edge touching them.
 */
export function createGraphRetentionFilter(isRefusedFile: (filePath: string) => boolean): {
  retainNode(node: unknown): boolean;
  retainRelationship(edge: unknown): boolean;
} {
  const dropped = new Set<string>();
  return {
    retainNode(node) {
      if (!node || typeof node !== 'object') return true;
      const { id, label, properties } = node as {
        id?: unknown;
        label?: unknown;
        properties?: unknown;
      };
      const filePath =
        properties && typeof properties === 'object'
          ? (properties as { filePath?: unknown }).filePath
          : undefined;
      if (
        typeof id !== 'string' ||
        (label !== 'Section' && (typeof filePath !== 'string' || !isRefusedFile(filePath)))
      )
        return true;
      dropped.add(id);
      return false;
    },
    retainRelationship(edge) {
      if (!edge || typeof edge !== 'object') return true;
      const { sourceId, targetId } = edge as { sourceId?: unknown; targetId?: unknown };
      return (
        !(typeof sourceId === 'string' && dropped.has(sourceId)) &&
        !(typeof targetId === 'string' && dropped.has(targetId))
      );
    },
  };
}

/** Keep malformed events for the retention stage's own validation and limits. */
export function shouldRetainRegistration(
  encoded: string,
  hasScopeHook: (filePath: string) => boolean,
): boolean {
  try {
    const event: unknown = JSON.parse(encoded);
    if (!event || typeof event !== 'object' || Array.isArray(event)) return true;
    const record = event as Record<string, unknown>;
    let filePath: unknown;
    switch (record.kind) {
      case 'symbol.add':
        filePath = record.filePath;
        break;
      case 'type.registerClass':
      case 'type.registerImpl':
      case 'method.register':
      case 'field.register': {
        const def = record.def;
        if (!def || typeof def !== 'object' || Array.isArray(def)) return true;
        filePath = (def as Record<string, unknown>).filePath;
        break;
      }
      default:
        return true;
    }
    return typeof filePath !== 'string' || hasScopeHook(filePath);
  } catch {
    return true;
  }
}
