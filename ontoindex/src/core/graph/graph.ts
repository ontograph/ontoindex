import type { GraphNode, GraphRelationship } from 'ontoindex-shared';
import { KnowledgeGraph } from './types.js';

export const createKnowledgeGraph = (): KnowledgeGraph => {
  const nodeMap = new Map<string, GraphNode>();
  const relationshipMap = new Map<string, GraphRelationship>();

  const addNode = (node: GraphNode) => {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
  };

  const addRelationship = (relationship: GraphRelationship) => {
    if (!relationshipMap.has(relationship.id)) {
      relationshipMap.set(relationship.id, relationship);
    }
  };

  /**
   * Remove a single node and all relationships involving it
   */
  const removeNode = (nodeId: string): boolean => {
    if (!nodeMap.has(nodeId)) return false;

    nodeMap.delete(nodeId);

    // Remove all relationships involving this node
    for (const [relId, rel] of relationshipMap) {
      if (rel.sourceId === nodeId || rel.targetId === nodeId) {
        relationshipMap.delete(relId);
      }
    }
    return true;
  };

  /**
   * Remove a single relationship by id.
   * Returns true if the relationship existed and was removed, false otherwise.
   */
  const removeRelationship = (relationshipId: string): boolean => {
    return relationshipMap.delete(relationshipId);
  };

  /**
   * Remove all nodes belonging to the files, scanning relationships once.
   */
  const removeNodesByFiles: KnowledgeGraph['removeNodesByFiles'] = (filePaths) => {
    const paths = new Set(filePaths);
    const removedIds = new Set<string>();
    const affectedSourceIds = new Set<string>();
    let removedRelationships = 0;
    if (paths.size === 0) {
      return { removedNodes: 0, removedRelationships: 0, affectedSourceIds: [] };
    }

    for (const [nodeId, node] of nodeMap) {
      if (node.properties?.filePath !== undefined && paths.has(node.properties.filePath)) {
        removedIds.add(nodeId);
        nodeMap.delete(nodeId);
      }
    }

    for (const [relId, rel] of relationshipMap) {
      if (removedIds.has(rel.sourceId) || removedIds.has(rel.targetId)) {
        relationshipMap.delete(relId);
        removedRelationships++;
        if (!removedIds.has(rel.sourceId)) affectedSourceIds.add(rel.sourceId);
      }
    }

    return {
      removedNodes: removedIds.size,
      removedRelationships,
      affectedSourceIds: [...affectedSourceIds].sort(),
    };
  };

  /**
   * Remove all nodes (and their relationships) belonging to a file.
   */
  const removeNodesByFile = (filePath: string): number =>
    removeNodesByFiles([filePath]).removedNodes;

  return {
    get nodes() {
      return Array.from(nodeMap.values());
    },

    get relationships() {
      return Array.from(relationshipMap.values());
    },

    iterNodes: () => nodeMap.values(),
    iterRelationships: () => relationshipMap.values(),
    forEachNode(fn: (node: GraphNode) => void) {
      nodeMap.forEach(fn);
    },
    forEachRelationship(fn: (rel: GraphRelationship) => void) {
      relationshipMap.forEach(fn);
    },
    getNode: (id: string) => nodeMap.get(id),

    // O(1) count getters - avoid creating arrays just for length
    get nodeCount() {
      return nodeMap.size;
    },

    get relationshipCount() {
      return relationshipMap.size;
    },

    addNode,
    addRelationship,
    removeNode,
    removeNodesByFile,
    removeNodesByFiles,
    removeRelationship,
  };
};
