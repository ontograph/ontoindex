// ontoindex/src/core/ingestion/class-extractors/configs/dart.ts

import { SupportedLanguages } from 'ontoindex-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const dartClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Dart,
  typeDeclarationNodes: ['class_definition', 'extension_declaration', 'enum_declaration'],
  ancestorScopeNodeTypes: ['class_definition', 'extension_declaration', 'enum_declaration'],
};
