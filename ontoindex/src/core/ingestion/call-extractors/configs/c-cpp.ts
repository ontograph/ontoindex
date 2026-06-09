// ontoindex/src/core/ingestion/call-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'ontoindex-shared';
import type { CallExtractionConfig, ExtractedCallSite } from '../../call-types.js';
import { countCallArguments } from '../../utils/call-analysis.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractCppTemporaryMemberCall(callNode: SyntaxNode): ExtractedCallSite | null {
  if (callNode.type !== 'call_expression') return null;

  const functionNode = callNode.childForFieldName('function');
  if (functionNode?.type !== 'field_expression') return null;

  const fieldNode = functionNode.childForFieldName('field');
  const receiverNode = functionNode.childForFieldName('argument');
  if (!fieldNode?.text || receiverNode?.type !== 'call_expression') return null;

  const receiverFunction = receiverNode.childForFieldName('function');
  if (
    receiverFunction?.type !== 'identifier' &&
    receiverFunction?.type !== 'type_identifier' &&
    receiverFunction?.type !== 'qualified_identifier'
  ) {
    return null;
  }

  const receiverName = receiverFunction.text.split('::').pop();
  if (!receiverName || !/^[A-Z_]/.test(receiverName)) return null;

  return {
    calledName: fieldNode.text,
    callForm: 'member',
    receiverName,
    argCount: countCallArguments(callNode),
    typeAsReceiverHeuristic: true,
  };
}

export const cCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.C,
};

export const cppCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  extractLanguageCallSite: extractCppTemporaryMemberCall,
};
