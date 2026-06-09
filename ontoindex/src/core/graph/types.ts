/**
 * CLI-specific graph types.
 *
 * Shared types (NodeLabel, GraphNode, etc.) should be imported
 * directly from 'ontoindex-shared' at call sites.
 *
 * This file only defines the CLI's KnowledgeGraph with mutation methods.
 */
import type { GraphNode, GraphRelationship } from 'ontoindex-shared';

// CLI-specific: full KnowledgeGraph with mutation methods for incremental updates
export interface KnowledgeGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  iterNodes: () => IterableIterator<GraphNode>;
  iterRelationships: () => IterableIterator<GraphRelationship>;
  forEachNode: (fn: (node: GraphNode) => void) => void;
  forEachRelationship: (fn: (rel: GraphRelationship) => void) => void;
  getNode: (id: string) => GraphNode | undefined;
  nodeCount: number;
  relationshipCount: number;
  addNode: (node: GraphNode) => void;
  addRelationship: (relationship: GraphRelationship) => void;
  removeNode: (nodeId: string) => boolean;
  removeNodesByFile: (filePath: string) => number;
  removeRelationship: (relationshipId: string) => boolean;
}
