import { KnowledgeGraph } from '../../graph/types.js';
import { ResolutionContext } from '../model/resolution-context.js';
import { BindingAccumulator } from '../binding-accumulator.js';
import { ExtractedAssignment, FileConstructorBindings } from '../workers/parse-worker.js';
import { generateId } from '../../../lib/utils.js';
import {
  buildFileReceiverTypeIndexes,
  extractFuncNameFromSourceId,
  lookupReceiverType,
  resolveFieldOwnership,
  CLASS_LIKE_TYPES,
} from './utils.js';

/**
 * Resolve pre-extracted field write assignments to ACCESSES {reason: 'write'} edges.
 * Accepts optional constructorBindings for return-type-aware receiver inference.
 */
export const processAssignmentsFromExtracted = (
  graph: KnowledgeGraph,
  assignments: ExtractedAssignment[],
  ctx: ResolutionContext,
  constructorBindings?: FileConstructorBindings[],
  bindingAccumulator?: BindingAccumulator,
): void => {
  const fileReceiverTypes = buildFileReceiverTypeIndexes(
    constructorBindings,
    ctx,
    graph,
    bindingAccumulator,
  );

  for (const asn of assignments) {
    // Resolve the receiver type
    let receiverTypeName = asn.receiverTypeName;
    // Tier 2: verified constructor bindings (return-type inference)
    if (!receiverTypeName && fileReceiverTypes.size > 0) {
      const receiverMap = fileReceiverTypes.get(asn.filePath);
      if (receiverMap) {
        const funcName = extractFuncNameFromSourceId(asn.sourceId);
        receiverTypeName = lookupReceiverType(receiverMap, funcName, asn.receiverText);
      }
    }
    // Tier 3: static class-as-receiver fallback
    if (!receiverTypeName) {
      const resolved = ctx.resolve(asn.receiverText, asn.filePath);
      if (resolved?.candidates.some((d) => CLASS_LIKE_TYPES.has(d.type))) {
        receiverTypeName = asn.receiverText;
      }
    }
    if (!receiverTypeName) continue;
    const fieldOwner = resolveFieldOwnership(receiverTypeName, asn.propertyName, asn.filePath, ctx);
    if (!fieldOwner) continue;
    graph.addRelationship({
      id: generateId('ACCESSES', `${asn.sourceId}:${fieldOwner.nodeId}:write`),
      sourceId: asn.sourceId,
      targetId: fieldOwner.nodeId,
      type: 'ACCESSES',
      confidence: 1.0,
      reason: 'write',
    });
  }
};
