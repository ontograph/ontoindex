import { describe, it, expect } from 'vitest';
import { extractLightweight } from '../../src/core/ingestion/lightweight-extractor.js';
import { SupportedLanguages } from 'ontoindex-shared';

describe('lightweight-extractor', () => {
  it('extracts ESM imports from JavaScript/TypeScript', () => {
    const content = `
      import { foo } from './foo';
      import bar from 'bar-module';
      import './side-effect';
      export const x = 1;
    `;
    const result = extractLightweight('test.ts', content, SupportedLanguages.TypeScript);
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: './foo' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'bar-module' }));
    expect(result.imports).toContainEqual(
      expect.objectContaining({ rawImportPath: './side-effect' }),
    );
  });

  it('extracts CommonJS requires', () => {
    const content = `
      const foo = require('./foo');
      require('bar-module');
    `;
    const result = extractLightweight('test.js', content, SupportedLanguages.JavaScript);
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: './foo' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'bar-module' }));
  });

  it('extracts Python imports', () => {
    const content = `
import os
from sys import path
    `;
    const result = extractLightweight('test.py', content, SupportedLanguages.Python);
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'os' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'sys' }));
  });

  it('extracts C++ includes', () => {
    const content = `
#include <iostream>
#include "my_header.h"
    `;
    const result = extractLightweight('test.cpp', content, SupportedLanguages.CPlusPlus);
    expect(result.imports).toContainEqual(expect.objectContaining({ rawImportPath: 'iostream' }));
    expect(result.imports).toContainEqual(
      expect.objectContaining({ rawImportPath: 'my_header.h' }),
    );
  });
});
