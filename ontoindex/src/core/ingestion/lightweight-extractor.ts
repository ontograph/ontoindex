import { SupportedLanguages } from 'ontoindex-shared';
import { ParseWorkerResult, createEmptyResult } from './workers/parse-types.js';

/**
 * Lightweight regex-based extractor for files that exceed Tree-sitter limits.
 * Focuses on extracting imports and exports to maintain graph connectivity.
 */
export function extractLightweight(
  filePath: string,
  content: string,
  language: SupportedLanguages,
): ParseWorkerResult {
  const result = createEmptyResult();
  result.processedPaths.push(filePath);
  result.fileCount = 1;

  // Basic regexes for imports across common languages
  const importPatterns: {
    regex: RegExp;
    type: 'esm' | 'cjs' | 'python' | 'cpp' | 'go' | 'rust';
  }[] = [
    {
      // import { ... } from 'module' or import 'module'
      regex: /import\s+(?:[\w*{}\s,]+from\s+)?['"](.*?)['"]/g,
      type: 'esm',
    },
    {
      // require('module')
      regex: /require\(['"](.*?)['"]\)/g,
      type: 'cjs',
    },
    {
      // from module import ... or import module
      regex: /^\s*(?:import|from)\s+([a-zA-Z0-9_.]+)/gm,
      type: 'python',
    },
    {
      // #include <header> or #include "header"
      regex: /^\s*#include\s+[<"](.*?)[>"]/gm,
      type: 'cpp',
    },
    {
      // import "module"
      regex: /import\s+['"](.*?)['"]/g,
      type: 'go',
    },
    {
      // use module::...
      regex: /use\s+([a-zA-Z0-9_:]+)/g,
      type: 'rust',
    },
  ];

  for (const { regex } of importPatterns) {
    let match;
    // Reset regex state for global searches
    regex.lastIndex = 0;
    while ((match = regex.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath) {
        result.imports.push({
          filePath,
          rawImportPath: importPath,
          language,
        });
      }
    }
  }

  // Basic regex for exports (primarily for JS/TS connectivity)
  if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
    const exportRegex =
      /export\s+(?:const|let|var|function|class|interface|type|enum)\s+([a-zA-Z0-9_$]+)/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
      const name = match[1];
      // We don't create full Symbol nodes here, but we could potentially
      // add them to result.symbols if we want them searchable.
      // For now, focus on imports to keep the extractor "light".
    }
  }

  return result;
}
