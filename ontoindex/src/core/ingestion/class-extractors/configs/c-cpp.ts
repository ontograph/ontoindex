// ontoindex/src/core/ingestion/class-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'ontoindex-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const cClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.C,
  typeDeclarationNodes: ['struct_specifier', 'enum_specifier'],
};

export const cppClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  typeDeclarationNodes: ['class_specifier', 'struct_specifier', 'enum_specifier'],
  ancestorScopeNodeTypes: ['namespace_definition', 'class_specifier', 'struct_specifier'],
  extractName: (node) => {
    if (node.type !== 'class_specifier' && node.type !== 'struct_specifier') return undefined;
    const bodyStart = node.text.indexOf('{');
    const textBeforeBody = bodyStart >= 0 ? node.text.slice(0, bodyStart) : node.text;
    const withoutInheritance = textBeforeBody.replace(/\s:[^:{].*$/, '');
    const match = withoutInheritance.match(/((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*$/);
    return match?.[1]?.split('::').filter(Boolean).pop();
  },
};
