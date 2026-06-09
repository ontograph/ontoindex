import { describe, it, expect } from 'vitest';
import { extractImports, isNativeEnabled } from '../../src/native/import-extractor.js';
import { SupportedLanguages } from 'ontoindex-shared';

describe('native-import-extractor', () => {
  it('detects if native is enabled', () => {
    console.log(`[test] Native enabled: ${isNativeEnabled()}`);
  });

  it('extracts imports from JavaScript (hybrid)', () => {
    const content = `
      import { foo } from './foo';
      import bar from 'bar-module';
    `;
    const result = extractImports('test.js', content, SupportedLanguages.JavaScript);
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: './foo' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'bar-module' }));
  });

  it('extracts imports from TypeScript (hybrid)', () => {
    const content = `
      import type { Foo } from './foo';
      import * as bar from "bar-module";
    `;
    const result = extractImports('test.ts', content, SupportedLanguages.TypeScript);
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: './foo' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'bar-module' }));
  });

  it('falls back to regex for non-supported native languages', () => {
    const content = `import os`;
    const result = extractImports('test.py', content, SupportedLanguages.Python);
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'os' }));
  });
});
