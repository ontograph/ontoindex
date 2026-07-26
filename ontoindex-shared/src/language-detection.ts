/**
 * Language Detection — maps file paths to SupportedLanguages enum values.
 *
 * Shared between CLI (ingestion pipeline) and web (syntax highlighting).
 *
 * ADDING A NEW LANGUAGE:
 * 1. Add enum member to SupportedLanguages in languages.ts
 * 2. Add file extensions to EXTENSION_MAP below
 * 3. TypeScript will error if you miss either step (exhaustive Record)
 */

import { SupportedLanguages } from './languages.js';

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set([
  'Rakefile',
  'Gemfile',
  'Guardfile',
  'Vagrantfile',
  'Brewfile',
]);

/**
 * Exhaustive map: every SupportedLanguages member → its file extensions.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error: "Property 'NewLang' is missing in type..."
 */
const EXTENSION_MAP: Record<SupportedLanguages, readonly string[]> = {
  [SupportedLanguages.JavaScript]: ['.js', '.jsx', '.mjs', '.cjs'],
  [SupportedLanguages.TypeScript]: ['.ts', '.tsx', '.mts', '.cts'],
  [SupportedLanguages.Python]: ['.py'],
  [SupportedLanguages.Java]: ['.java'],
  [SupportedLanguages.C]: ['.c'],
  [SupportedLanguages.CPlusPlus]: ['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'],
  [SupportedLanguages.CSharp]: ['.cs'],
  [SupportedLanguages.Go]: ['.go'],
  [SupportedLanguages.Ruby]: ['.rb', '.rake', '.gemspec'],
  [SupportedLanguages.Rust]: ['.rs'],
  [SupportedLanguages.PHP]: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'],
  [SupportedLanguages.Kotlin]: ['.kt', '.kts'],
  [SupportedLanguages.Swift]: ['.swift'],
  [SupportedLanguages.Dart]: ['.dart'],
  [SupportedLanguages.Vue]: ['.vue'],
  [SupportedLanguages.Cobol]: ['.cbl', '.cob', '.cpy', '.cobol'],
} satisfies Record<SupportedLanguages, readonly string[]>; // Ensure exhaustiveness

/** Pre-built reverse lookup: extension → language (built once at module load). */
const extToLang = new Map<string, SupportedLanguages>();
for (const [lang, exts] of Object.entries(EXTENSION_MAP) as [
  SupportedLanguages,
  readonly string[],
][]) {
  for (const ext of exts) {
    extToLang.set(ext, lang);
  }
}

/**
 * Map file extension to SupportedLanguage enum.
 * Returns null if the file extension is not recognized.
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  // Fast path: check the extension map
  const lastDot = filename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = filename.slice(lastDot).toLowerCase();
    const lang = extToLang.get(ext);
    if (lang !== undefined) return lang;
  }

  // Ruby extensionless files (Rakefile, Gemfile, etc.)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }

  return null;
};

/**
 * Interpreter basename → language, for the only shebang interpreters that have a
 * SupportedLanguages member, a LanguageProvider, and a parser loader.
 *
 * Shell/bash/zsh/sh are intentionally absent: there is no shell SupportedLanguages
 * member, provider, or parser, so a shell shebang must never be aliased to a
 * supported language.
 */
const SHEBANG_INTERPRETER_MAP: Record<string, SupportedLanguages> = {
  python: SupportedLanguages.Python,
  ruby: SupportedLanguages.Ruby,
  node: SupportedLanguages.JavaScript,
  nodejs: SupportedLanguages.JavaScript,
  php: SupportedLanguages.PHP,
};

/**
 * Additive, content-aware fallback: map a file's shebang to a SupportedLanguage.
 *
 * This is a SEPARATE entry point from getLanguageFromFilename; extension and
 * basename detection always win and should be consulted first. Detection is
 * bounded to the first line — the argument may be the whole file, but only the
 * text up to the first CR or LF is inspected.
 *
 * Returns null when there is no `#!` shebang or the interpreter is unsupported.
 * Handles direct interpreter paths, `/usr/bin/env` with flags or VAR=val prefixes,
 * surrounding whitespace, CRLF line endings, and versioned names (e.g. python3.11).
 */
export const getLanguageFromShebang = (text: string): SupportedLanguages | null => {
  // Bounded to a single line: cut at the first CR or LF.
  const newlineIdx = text.search(/[\r\n]/);
  const line = (newlineIdx >= 0 ? text.slice(0, newlineIdx) : text).trim();
  if (!line.startsWith('#!')) return null;

  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let interpreter = tokens[0];
  // `/usr/bin/env [flags] <interp>`: skip env and any -flags or VAR=val prefixes.
  if ((interpreter.split('/').pop() ?? interpreter) === 'env') {
    const interp = tokens.slice(1).find((t) => !t.startsWith('-') && !t.includes('='));
    if (interp === undefined) return null;
    interpreter = interp;
  }

  const base = (interpreter.split('/').pop() ?? interpreter).toLowerCase();
  // Try exact, then strip a trailing version suffix (python3, python3.11, php8.2).
  return (
    SHEBANG_INTERPRETER_MAP[base] ?? SHEBANG_INTERPRETER_MAP[base.replace(/[0-9.]+$/, '')] ?? null
  );
};

/**
 * Exhaustive map: every SupportedLanguages member → Prism syntax identifier.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error.
 */
const SYNTAX_MAP: Record<SupportedLanguages, string> = {
  [SupportedLanguages.JavaScript]: 'javascript',
  [SupportedLanguages.TypeScript]: 'typescript',
  [SupportedLanguages.Python]: 'python',
  [SupportedLanguages.Java]: 'java',
  [SupportedLanguages.C]: 'c',
  [SupportedLanguages.CPlusPlus]: 'cpp',
  [SupportedLanguages.CSharp]: 'csharp',
  [SupportedLanguages.Go]: 'go',
  [SupportedLanguages.Ruby]: 'ruby',
  [SupportedLanguages.Rust]: 'rust',
  [SupportedLanguages.PHP]: 'php',
  [SupportedLanguages.Kotlin]: 'kotlin',
  [SupportedLanguages.Swift]: 'swift',
  [SupportedLanguages.Dart]: 'dart',
  [SupportedLanguages.Vue]: 'typescript',
  [SupportedLanguages.Cobol]: 'cobol',
} satisfies Record<SupportedLanguages, string>; // Ensure exhaustiveness

/** Non-code file extensions → Prism-compatible syntax identifiers */
const AUXILIARY_SYNTAX_MAP: Record<string, string> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'markup',
  htm: 'markup',
  erb: 'markup',
  xml: 'markup',
  css: 'css',
  scss: 'css',
  sass: 'css',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'docker',
};

/** Extensionless filenames → Prism-compatible syntax identifiers */
const AUXILIARY_BASENAME_MAP: Record<string, string> = {
  Makefile: 'makefile',
  Dockerfile: 'docker',
};

/**
 * Map file path to a Prism-compatible syntax highlight language string.
 * Covers all SupportedLanguages (code files) plus common non-code formats.
 * Returns 'text' for unrecognised files.
 */
export const getSyntaxLanguageFromFilename = (filePath: string): string => {
  const lang = getLanguageFromFilename(filePath);
  if (lang) return SYNTAX_MAP[lang];
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext && ext in AUXILIARY_SYNTAX_MAP) return AUXILIARY_SYNTAX_MAP[ext];
  const basename = filePath.split('/').pop() || '';
  if (basename in AUXILIARY_BASENAME_MAP) return AUXILIARY_BASENAME_MAP[basename];
  return 'text';
};
