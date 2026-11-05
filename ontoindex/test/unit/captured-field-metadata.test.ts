import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { createFieldExtractor } from '../../src/core/ingestion/field-extractors/generic.js';
import { goConfig } from '../../src/core/ingestion/field-extractors/configs/go.js';
import { phpConfig } from '../../src/core/ingestion/field-extractors/configs/php.js';
import { rubyConfig } from '../../src/core/ingestion/field-extractors/configs/ruby.js';
import type { FieldExtractorContext } from '../../src/core/ingestion/field-types.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import type { TypeEnvironment } from '../../src/core/ingestion/type-env.js';

function context(language: SupportedLanguages, filePath: string): FieldExtractorContext {
  return {
    typeEnv: { fileScope: () => new Map() } as TypeEnvironment,
    symbolTable: createSemanticModel().symbols,
    filePath,
    language,
  };
}

function parse(language: Parameters<Parser['setLanguage']>[0], code: string) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(code);
  expect(tree.rootNode.hasError).toBe(false);
  return tree;
}

describe('captured field declaration metadata', () => {
  it.each([
    ['Address', 'Address'],
    ['*Address', 'Address'],
    ['models.Address', 'Address'],
    ['*models.Address', 'Address'],
  ])('extracts Go %s without an enclosing owner', (annotation, type) => {
    const tree = parse(Go, `package sample\ntype User struct { Home ${annotation} }\n`);
    const field = tree.rootNode.descendantsOfType('field_declaration')[0];
    const extractor = createFieldExtractor(goConfig);
    expect(
      extractor.extractFromNode!(field, context(SupportedLanguages.Go, 'user.go'), 'Home'),
    ).toEqual({
      name: 'Home',
      type,
      visibility: 'public',
      isStatic: false,
      isReadonly: false,
      sourceFile: 'user.go',
      line: 2,
    });
  });

  it('rejects unrecognized Go names and node kinds', () => {
    const tree = parse(Go, 'package sample\ntype User struct { Home, Work Address }\n');
    const field = tree.rootNode.descendantsOfType('field_declaration')[0];
    const extractor = createFieldExtractor(goConfig);
    const ctx = context(SupportedLanguages.Go, 'user.go');
    expect(extractor.extractFromNode!(field, ctx)?.name).toBe('Home');
    expect(extractor.extractFromNode!(field, ctx, 'Work')).toBeNull();
    expect(extractor.extractFromNode!(field, ctx, 'Missing')).toBeNull();
    expect(extractor.extractFromNode!(field, ctx, '')).toBeNull();
    expect(extractor.extractFromNode!(tree.rootNode, ctx, 'Home')).toBeNull();
  });

  it('extracts PHP promoted property type, visibility and readonly metadata', () => {
    const tree = parse(
      PHP.php,
      `<?php
class User {
  public function __construct(private readonly Address $home, protected Service $service, string $ordinary) {}
}`,
    );
    const fields = tree.rootNode.descendantsOfType('property_promotion_parameter');
    expect(fields).toHaveLength(2);
    const extractor = createFieldExtractor(phpConfig);
    const ctx = context(SupportedLanguages.PHP, 'user.php');
    expect(fields.map((field) => extractor.extractFromNode!(field, ctx))).toEqual([
      {
        name: 'home',
        type: 'Address',
        visibility: 'private',
        isStatic: false,
        isReadonly: true,
        sourceFile: 'user.php',
        line: 3,
      },
      {
        name: 'service',
        type: 'Service',
        visibility: 'protected',
        isStatic: false,
        isReadonly: false,
        sourceFile: 'user.php',
        line: 3,
      },
    ]);
    expect(extractor.extractFromNode!(fields[0], ctx, 'service')).toBeNull();
    const ordinary = tree.rootNode.descendantsOfType('simple_parameter')[0];
    expect(ordinary).toBeDefined();
    expect(extractor.extractFromNode!(ordinary, ctx, 'ordinary')).toBeNull();
  });

  it('uses the same metadata for a directly captured and owner-collected PHP field', () => {
    const tree = parse(PHP.php, '<?php class User { protected static Address $home; }');
    const owner = tree.rootNode.descendantsOfType('class_declaration')[0];
    const field = tree.rootNode.descendantsOfType('property_declaration')[0];
    const extractor = createFieldExtractor(phpConfig);
    const ctx = context(SupportedLanguages.PHP, 'user.php');
    expect(extractor.extractFromNode!(field, ctx, 'home')).toEqual(
      extractor.extract(owner, ctx)!.fields[0],
    );
  });

  it('selects only config-declared names from a multi-name Ruby declaration', () => {
    const tree = parse(Ruby, 'class User\n attr_reader :home, :work\nend');
    const field = tree.rootNode.descendantsOfType('call')[0];
    const extractor = createFieldExtractor(rubyConfig);
    const ctx = context(SupportedLanguages.Ruby, 'user.rb');
    expect(extractor.extractFromNode!(field, ctx, 'work')).toMatchObject({
      name: 'work',
      type: null,
      visibility: 'public',
      isReadonly: true,
    });
    expect(extractor.extractFromNode!(field, ctx, 'missing')).toBeNull();
  });
});
