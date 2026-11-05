// ontoindex/src/core/ingestion/call-extractors/configs/go.ts

import { SupportedLanguages } from 'ontoindex-shared';
import type { CallExtractionConfig } from '../../call-types.js';

export const goCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.Go,
  extractLanguageCallSite(callNode) {
    if (callNode.type !== 'call_expression') return null;
    const selector = callNode.childForFieldName('function');
    if (selector?.type !== 'selector_expression') return null;
    const receiver = selector.childForFieldName('operand');
    const method = selector.childForFieldName('field');
    if (receiver?.type !== 'index_expression' || !method) return null;
    return {
      calledName: method.text,
      callForm: 'member',
      receiverName: receiver.text,
      argCount: callNode.childForFieldName('arguments')?.namedChildCount,
    };
  },
};
