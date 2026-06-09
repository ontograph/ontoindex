/**
 * Web-specific graph types.
 *
 * Shared types (NodeLabel, GraphNode, etc.) should be imported
 * directly from 'ontoindex-shared' at call sites.
 *
 * This file only defines web-specific additions.
 */
import type { GraphNode, GraphRelationship } from 'ontoindex-shared';

// Web-specific: in-memory graph container (simpler than CLI version)
export interface KnowledgeGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  nodeCount: number;
  relationshipCount: number;
  addNode: (node: GraphNode) => void;
  addRelationship: (relationship: GraphRelationship) => void;
}
