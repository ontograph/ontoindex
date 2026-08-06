// ontoindex/src/core/ingestion/call-extractors/configs/rust.ts

import { SupportedLanguages } from 'ontoindex-shared';
import type { CallExtractionConfig, ExtractedCallSite } from '../../call-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractRustAssociatedCall(callNode: SyntaxNode): ExtractedCallSite | null {
  if (callNode.type !== 'call_expression') return null;
  const scoped = callNode.childForFieldName('function');
  if (scoped?.type !== 'scoped_identifier') return null;

  const receiver = scoped.childForFieldName('path');
  const name = scoped.childForFieldName('name');
  if (!receiver || !name || !/^[A-Z]/.test(receiver.text)) return null;

  return { calledName: name.text, callForm: 'member', receiverName: receiver.text };
}

export const rustCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.Rust,
  extractLanguageCallSite: extractRustAssociatedCall,
  typeAsReceiverHeuristic: true,
};
