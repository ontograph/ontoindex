import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import C from 'tree-sitter-c';
import CPP from 'tree-sitter-cpp';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import { createRequire } from 'node:module';
import { SupportedLanguages } from 'ontoindex-shared';

const _require = createRequire(import.meta.url);

type TreeSitterGrammar = {
  name: string;
  language: unknown;
  nodeTypeInfo: readonly unknown[];
};

const isTreeSitterGrammar = (value: unknown): value is TreeSitterGrammar =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { name?: unknown }).name === 'string' &&
  'language' in value &&
  Array.isArray((value as { nodeTypeInfo?: unknown }).nodeTypeInfo);

const loadOptionalGrammar = (packageName: string): TreeSitterGrammar | null => {
  try {
    const grammar: unknown = _require(packageName);
    return isTreeSitterGrammar(grammar) ? grammar : null;
  } catch {
    return null;
  }
};

// tree-sitter-swift and tree-sitter-dart are optionalDependencies — may not be installed
const Swift = loadOptionalGrammar('tree-sitter-swift');
const Dart = loadOptionalGrammar('tree-sitter-dart');

// tree-sitter-kotlin is an optionalDependency — may not be installed
const Kotlin = loadOptionalGrammar('tree-sitter-kotlin');

let parser: Parser | null = null;

const languageMap: Record<string, TreeSitterGrammar> = {
  [SupportedLanguages.JavaScript]: JavaScript,
  [SupportedLanguages.TypeScript]: TypeScript.typescript,
  [`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
  [SupportedLanguages.Python]: Python,
  [SupportedLanguages.Java]: Java,
  [SupportedLanguages.C]: C,
  [SupportedLanguages.CPlusPlus]: CPP,
  [SupportedLanguages.CSharp]: CSharp,
  [SupportedLanguages.Go]: Go,
  [SupportedLanguages.Rust]: Rust,
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  [SupportedLanguages.PHP]: PHP.php_only,
  [SupportedLanguages.Ruby]: Ruby,
  [SupportedLanguages.Vue]: TypeScript.typescript,
  ...(Dart ? { [SupportedLanguages.Dart]: Dart } : {}),
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};

export const isLanguageAvailable = (language: SupportedLanguages): boolean =>
  language in languageMap;

export const resolveLanguageKey = (language: SupportedLanguages, filePath?: string): string =>
  language === SupportedLanguages.TypeScript && filePath?.endsWith('.tsx')
    ? `${language}:tsx`
    : language;

export const getLanguageGrammar = (
  language: SupportedLanguages,
  filePath?: string,
): TreeSitterGrammar => {
  const key = resolveLanguageKey(language, filePath);
  const lang = languageMap[key];
  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }
  return lang;
};

export const loadParser = async (): Promise<Parser> => {
  if (parser) return parser;
  parser = new Parser();
  return parser;
};

export const loadLanguage = async (
  language: SupportedLanguages,
  filePath?: string,
): Promise<void> => {
  if (!parser) await loadParser();
  parser!.setLanguage(getLanguageGrammar(language, filePath));
};

export const createParserForLanguage = async (
  language: SupportedLanguages,
  filePath?: string,
): Promise<Parser> => {
  const freshParser = new Parser();
  freshParser.setLanguage(getLanguageGrammar(language, filePath));
  return freshParser;
};
