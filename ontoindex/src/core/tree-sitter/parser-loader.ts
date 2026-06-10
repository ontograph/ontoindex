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

type TreeSitterGrammar = Parameters<typeof Parser.prototype.setLanguage>[0];

const asTreeSitterGrammar = (value: unknown): TreeSitterGrammar =>
  value as TreeSitterGrammar;

const loadOptionalGrammar = (packageName: string): TreeSitterGrammar | null => {
  try {
    const grammar: unknown = _require(packageName);
    return asTreeSitterGrammar(grammar);
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
  [SupportedLanguages.JavaScript]: asTreeSitterGrammar(JavaScript),
  [SupportedLanguages.TypeScript]: asTreeSitterGrammar(TypeScript.typescript),
  [`${SupportedLanguages.TypeScript}:tsx`]: asTreeSitterGrammar(TypeScript.tsx),
  [SupportedLanguages.Python]: asTreeSitterGrammar(Python),
  [SupportedLanguages.Java]: asTreeSitterGrammar(Java),
  [SupportedLanguages.C]: asTreeSitterGrammar(C),
  [SupportedLanguages.CPlusPlus]: asTreeSitterGrammar(CPP),
  [SupportedLanguages.CSharp]: asTreeSitterGrammar(CSharp),
  [SupportedLanguages.Go]: asTreeSitterGrammar(Go),
  [SupportedLanguages.Rust]: asTreeSitterGrammar(Rust),
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  [SupportedLanguages.PHP]: asTreeSitterGrammar(PHP.php_only),
  [SupportedLanguages.Ruby]: asTreeSitterGrammar(Ruby),
  [SupportedLanguages.Vue]: asTreeSitterGrammar(TypeScript.typescript),
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
