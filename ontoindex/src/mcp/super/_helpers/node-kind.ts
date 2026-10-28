import { NODE_TABLES } from 'ontoindex-shared';

const NODE_TABLE_LABELS: ReadonlySet<string> = new Set(NODE_TABLES);

/** Returns the row kind, or recovers it from a canonical "Label:..." node id when the label is empty. */
export function nodeKind(kind: string, nodeId: string): string {
  if (kind) return kind;
  const separator = nodeId.indexOf(':');
  const label = nodeId.slice(0, separator);
  return separator > 0 && separator < nodeId.length - 1 && NODE_TABLE_LABELS.has(label)
    ? label
    : '';
}
