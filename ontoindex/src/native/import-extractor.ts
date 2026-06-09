import { SupportedLanguages } from 'ontoindex-shared';
import { ParseWorkerResult, ExtractedImport } from '../core/ingestion/workers/parse-types.js';
import { extractLightweight } from '../core/ingestion/lightweight-extractor.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let nativeModule: any = null;

try {
  // Try explicit override first, then common monorepo layouts.
  const locations = [
    process.env.ONTOINDEX_NATIVE_MODULE_PATH,
    '../../../ontoindex-native/index.cjs',
    '../../ontoindex-native/index.cjs',
    '../../../../ontoindex-native/index.cjs',
    './ontoindex-native/index.cjs',
  ].filter((loc): loc is string => Boolean(loc));

  const failures: string[] = [];
  for (const loc of locations) {
    try {
      nativeModule = require(loc);
      if (nativeModule) break;
    } catch (e: unknown) {
      failures.push(`${loc}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!nativeModule) {
    console.warn(
      `[native] Failed to load native module from known locations: ${failures.join('; ')}`,
    );
  }
} catch (e) {
  console.warn(
    `[native] Failed to load native module: ${e instanceof Error ? e.message : String(e)}`,
  );
}

/**
 * High-performance import extractor with native kernel.
 * Falls back to regex-based extraction if native module is unavailable.
 */
export function extractImports(
  filePath: string,
  content: string,
  language: SupportedLanguages,
): ParseWorkerResult {
  if (nativeModule?.extractImportsNative) {
    try {
      const languageId =
        language === SupportedLanguages.JavaScript
          ? 'javascript'
          : language === SupportedLanguages.TypeScript
            ? 'typescript'
            : null;

      if (languageId) {
        const nativeImports = nativeModule.extractImportsNative(filePath, content, languageId);

        // Convert NativeImport[] to ExtractedImport[]
        const imports: ExtractedImport[] = nativeImports.map((ni: any) => ({
          filePath: ni.filePath || ni.file_path,
          rawImportPath: ni.rawImportPath || ni.raw_import_path,
          language: language,
        }));

        const result: ParseWorkerResult = {
          nodes: [],
          relationships: [],
          symbols: [],
          imports,
          calls: [],
          assignments: [],
          heritage: [],
          routes: [],
          fetchCalls: [],
          decoratorRoutes: [],
          toolDefs: [],
          ormQueries: [],
          constructorBindings: [],
          fileScopeBindings: [],
          parsedFiles: [],
          processedPaths: [filePath],
          fileTimings: [],
          extractorTimings: [],
          skippedLanguages: {},
          fileCount: 1,
        };
        return result;
      }
    } catch (e) {
      console.warn(`[native] Native import extraction failed for ${filePath}, falling back:`, e);
    }
  }

  // Fallback to pure TS/regex extractor (LCS-015)
  return extractLightweight(filePath, content, language);
}

export function isNativeEnabled(): boolean {
  return !!nativeModule?.extractImportsNative;
}
