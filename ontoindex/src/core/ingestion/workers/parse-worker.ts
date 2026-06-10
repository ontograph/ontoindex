import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import { minimatch } from 'minimatch';
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
import { getProvider } from '../languages/index.js';
import {
  exceedsParseMaxAstDepth,
  getParseMaxAstDepth,
  getParseMaxAstNodes,
  getTreeSitterBufferSize,
  TREE_SITTER_MAX_BUFFER,
} from '../constants.js';
import type { SymbolTableReader } from '../model/symbol-table.js';
import {
  createEmptyResult,
  hydrateParseWorkerInputs,
  mergeParseWorkerResult,
  type HydratedParseWorkerInput,
  type ParseWorkerDiagnostics,
  type ParseFileTiming,
  type ParseWorkerInput,
  type ParseWorkerResult,
  type TreeSitterLanguage,
  type WorkerIncomingMessage,
  type WorkerOutgoingMessage,
  type CppTypeOwnerHint,
} from './parse-types.js';
export type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedDecoratorRoute,
  ExtractedFetchCall,
  ExtractedImport,
  ExtractedORMQuery,
  ExtractedRoute,
  ExtractedToolDef,
  FileConstructorBindings,
  FileScopeBindings,
  ParseExtractorTiming,
  ParseFileTiming,
  ParsedNode,
  ParsedRelationship,
  ParsedSymbol,
  ParseWorkerInput,
  ParseWorkerResult,
} from './parse-types.js';

// tree-sitter-swift is an optionalDependency — may not be installed
const _require = createRequire(import.meta.url);
let Swift: TreeSitterLanguage | null = null;
try {
  Swift = _require('tree-sitter-swift');
} catch {}

// tree-sitter-dart is an optionalDependency — may not be installed
let Dart: TreeSitterLanguage | null = null;
try {
  Dart = _require('tree-sitter-dart');
} catch {}

// tree-sitter-kotlin is an optionalDependency — may not be installed
let Kotlin: TreeSitterLanguage | null = null;
try {
  Kotlin = _require('tree-sitter-kotlin');
} catch {}
import { getLanguageFromFilename } from 'ontoindex-shared';
import {
  FUNCTION_NODE_TYPES,
  getDefinitionNodeFromCaptures,
  findEnclosingClassInfo,
  type EnclosingClassInfo,
  getLabelFromCaptures,
  genericFuncName,
  inferFunctionLabel,
  CLASS_CONTAINER_TYPES,
  type SyntaxNode,
} from '../utils/ast-helpers.js';
import { extractCallArgTypes } from '../utils/call-analysis.js';
import { buildTypeEnv } from '../type-env.js';
import { detectFrameworkFromAST } from '../framework-detection.js';
import { generateId } from '../../../lib/utils.js';
import { preprocessImportPath } from '../import-processor.js';
import {
  extractVueScript,
  extractTemplateComponents,
  extractJsxComponents,
  isVueSetupTopLevel,
} from '../vue-sfc-extractor.js';
import { extractImports, isNativeEnabled } from '../../../native/import-extractor.js';
import type { NodeLabel } from 'ontoindex-shared';
import type { FieldInfo, FieldExtractorContext } from '../field-types.js';
import type { MethodInfo, MethodExtractorContext } from '../method-types.js';
import type { VariableExtractorContext } from '../variable-types.js';
import {
  buildMethodProps,
  arityForIdFromInfo,
  typeTagForId,
  constTagForId,
  buildCollisionGroups,
} from '../utils/method-props.js';
import type { LanguageProvider } from '../language-provider.js';
import { extractParsedFile } from '../scope-extractor-bridge.js';
import { extractLaravelRoutes } from './route-extractor.js';
import { extractORMQueries } from './orm-extractor.js';

const sendToParent = (message: WorkerOutgoingMessage): void => {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  if (typeof process.send === 'function') {
    process.send(message);
    return;
  }
  throw new Error('parse-worker started without worker_threads parentPort or child_process IPC');
};

const onParentMessage = (handler: (message: WorkerIncomingMessage) => void): void => {
  if (parentPort) {
    parentPort.on('message', handler);
    return;
  }
  process.on('message', (message) => handler(message as WorkerIncomingMessage));
};

// ============================================================================
// Worker-local parser + language map
// ============================================================================

const parser = new Parser();

const PARSER_TIMEOUT_MICROS = 10_000_000; // 10 seconds in microseconds

const asTreeSitterLanguage = (value: unknown): TreeSitterLanguage => value as TreeSitterLanguage;

type ParserWithOptionalTimeoutMicros = {
  setTimeoutMicros?: unknown;
};

const supportsSetTimeoutMicros = (
  candidate: ParserWithOptionalTimeoutMicros,
): candidate is { setTimeoutMicros: (timeoutMicros: number) => void } =>
  typeof candidate.setTimeoutMicros === 'function';

// Probe whether tree-sitter setTimeoutMicros is available; set if so
if (supportsSetTimeoutMicros(parser)) {
  parser.setTimeoutMicros(PARSER_TIMEOUT_MICROS);
} else {
  console.warn('[parse-worker] tree-sitter setTimeoutMicros unavailable — external watchdog only');
}

const languageMap = {
  [SupportedLanguages.JavaScript]: asTreeSitterLanguage(JavaScript),
  [SupportedLanguages.TypeScript]: asTreeSitterLanguage(TypeScript.typescript),
  [`${SupportedLanguages.TypeScript}:tsx`]: asTreeSitterLanguage(TypeScript.tsx),
  [SupportedLanguages.Python]: asTreeSitterLanguage(Python),
  [SupportedLanguages.Java]: asTreeSitterLanguage(Java),
  [SupportedLanguages.C]: asTreeSitterLanguage(C),
  [SupportedLanguages.CPlusPlus]: asTreeSitterLanguage(CPP),
  [SupportedLanguages.CSharp]: asTreeSitterLanguage(CSharp),
  [SupportedLanguages.Go]: asTreeSitterLanguage(Go),
  [SupportedLanguages.Rust]: asTreeSitterLanguage(Rust),
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  [SupportedLanguages.PHP]: asTreeSitterLanguage(PHP.php_only),
  [SupportedLanguages.Ruby]: asTreeSitterLanguage(Ruby),
  [SupportedLanguages.Vue]: asTreeSitterLanguage(TypeScript.typescript),
  ...(Dart ? { [SupportedLanguages.Dart]: Dart } : {}),
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
} as Record<string, TreeSitterLanguage>;

/**
 * Check if a language grammar is available in this worker.
 * Duplicated from parser-loader.ts because workers can't import from the main thread.
 * Extra filePath parameter needed to distinguish .tsx from .ts (different grammars
 * under the same SupportedLanguages.TypeScript key).
 */
const isLanguageAvailable = (language: SupportedLanguages, filePath: string): boolean => {
  const key =
    language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
      ? `${language}:tsx`
      : language;
  return key in languageMap && languageMap[key] != null;
};

const setLanguage = (language: SupportedLanguages, filePath: string): void => {
  const key =
    language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
      ? `${language}:tsx`
      : language;
  const lang = languageMap[key];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  parser.setLanguage(lang);
};

// ============================================================================
// Per-file O(1) memoization — avoids repeated parent-chain walks per symbol.
// Three bare Maps cleared at file boundaries. Map.get() returns undefined for
// missing keys, so `cached !== undefined` distinguishes "not computed" from
// a stored null (enclosing class/function not found = top-level).
// ============================================================================

const classIdCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
const functionIdCache = new Map<SyntaxNode, string | null>();
const exportCache = new Map<SyntaxNode, boolean>();

const clearCaches = (): void => {
  classIdCache.clear();
  functionIdCache.clear();
  exportCache.clear();
  fieldInfoCache.clear();
  methodInfoCache.clear();
};

// ============================================================================
// FieldExtractor cache — extract field metadata once per class, reuse for each property.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const fieldInfoCache = new Map<number, Map<string, FieldInfo>>();

type CppQualifiedOwnerInfo = EnclosingClassInfo & {
  classFilePath?: string;
  declarationStartLine?: number;
  declarationEndLine?: number;
};

const normalizeCppScope = (scopeText: string): string => scopeText.replace(/\s+/g, '');

const cppScopeSimpleName = (scopeText: string): string =>
  normalizeCppScope(scopeText).split('::').filter(Boolean).pop() ?? '';

const cppStem = (filePath: string): string =>
  path.basename(filePath).replace(/\.(?:cxx|cpp|cc|c|hxx|hpp|hh|h)$/i, '');

const stripCppInheritanceClause = (declarationPrefix: string): string => {
  for (let i = 0; i < declarationPrefix.length; i++) {
    if (
      declarationPrefix[i] === ':' &&
      declarationPrefix[i - 1] !== ':' &&
      declarationPrefix[i + 1] !== ':'
    ) {
      return declarationPrefix.slice(0, i);
    }
  }
  return declarationPrefix;
};

const extractCppTypeDeclarationName = (declarationPrefix: string): string | null => {
  const withoutInheritance = stripCppInheritanceClause(declarationPrefix);
  const match = withoutInheritance.match(/((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*$/);
  if (!match?.[1]) return null;
  return cppScopeSimpleName(match[1]);
};

const extractCppTypeDeclarationNameAt = (
  content: string,
  startIndex: number,
  options: { allowForwardDeclaration?: boolean } = {},
): string | null => {
  const declarationMatch = /\b(class|struct)\b/.exec(content.slice(startIndex));
  if (!declarationMatch) return null;
  const declarationStart = startIndex + declarationMatch.index;
  const bodyStart = content.indexOf('{', declarationStart + declarationMatch[0].length);
  const nextSemicolon = content.indexOf(';', declarationStart + declarationMatch[0].length);
  const declarationEnd =
    bodyStart >= 0 && (nextSemicolon < 0 || bodyStart < nextSemicolon)
      ? bodyStart
      : options.allowForwardDeclaration && nextSemicolon >= 0
        ? nextSemicolon
        : -1;
  if (declarationEnd < 0) return null;
  return extractCppTypeDeclarationName(
    content.slice(declarationStart + declarationMatch[0].length, declarationEnd),
  );
};

const CPP_MEMBER_DECL_RE =
  /(?:^|[;{}]\s*|(?:public|private|protected)\s*:\s*)[^;{}()]*?\b(~?[A-Za-z_]\w*|operator\s*[^\s(]+)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:=\s*(?:0|default|delete)\s*)?;/g;

const lineNumberAtIndex = (content: string, index: number): number => {
  let line = 0;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
};

const normalizeCppMemberDeclarationName = (name: string): string =>
  name.startsWith('operator') ? name.replace(/\s+/g, ' ').trim() : name;

const extractCppMemberDeclarationHints = (
  content: string,
  baseLine = 0,
): NonNullable<CppTypeOwnerHint['memberDeclarations']> => {
  const declarations: NonNullable<CppTypeOwnerHint['memberDeclarations']> = [];
  for (const match of content.matchAll(CPP_MEMBER_DECL_RE)) {
    const name = match[1];
    if (!name) continue;
    const matchStartIndex = match.index ?? 0;
    const nameOffset = match[0].lastIndexOf(name);
    const startIndex = matchStartIndex + (nameOffset >= 0 ? nameOffset : 0);
    const endIndex = matchStartIndex + match[0].length;
    declarations.push({
      name: normalizeCppMemberDeclarationName(name),
      startLine: baseLine + lineNumberAtIndex(content, startIndex),
      endLine: baseLine + lineNumberAtIndex(content, endIndex),
    });
  }
  return declarations;
};

const findCppMemberDeclarationHint = (
  ownerHint: CppTypeOwnerHint,
  memberName: string,
): NonNullable<CppTypeOwnerHint['memberDeclarations']>[number] | undefined =>
  ownerHint.memberDeclarations?.find((declaration) => declaration.name === memberName);

const isRelatedCppPath = (sourceFilePath: string, ownerFilePath: string): boolean => {
  const sourceStem = cppStem(sourceFilePath);
  const ownerStem = cppStem(ownerFilePath);
  return (
    sourceStem === ownerStem ||
    sourceStem.startsWith(ownerStem) ||
    ownerStem.startsWith(sourceStem) ||
    path.dirname(sourceFilePath) === path.dirname(ownerFilePath)
  );
};

const uniqueCppHints = (hints: CppTypeOwnerHint[]): CppTypeOwnerHint[] => {
  const seen = new Set<string>();
  const result: CppTypeOwnerHint[] = [];
  for (const hint of hints) {
    const key = `${hint.label}:${hint.filePath}:${hint.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hint);
  }
  return result;
};

const resolveCppTypeOwnerHint = (
  scopeText: string,
  filePath: string,
  localHints: readonly CppTypeOwnerHint[],
  externalHints: readonly CppTypeOwnerHint[] = [],
): CppTypeOwnerHint | null => {
  const scopeName = cppScopeSimpleName(scopeText);
  if (!scopeName) return null;

  const localCandidates = localHints.filter((hint) => hint.name === scopeName);
  if (localCandidates.length === 1) return localCandidates[0];

  const candidates = uniqueCppHints([...localCandidates, ...externalHints]).filter(
    (hint) => hint.name === scopeName,
  );
  if (candidates.length === 1) return candidates[0];

  const related = candidates.filter((hint) => isRelatedCppPath(filePath, hint.filePath));
  return related.length === 1 ? related[0] : null;
};

/**
 * Walk up from a definition node to find the nearest enclosing class/struct/interface
 * AST node. Returns the SyntaxNode itself (not an ID) for passing to FieldExtractor.
 */
function findEnclosingClassNode(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      // Return singleton_class directly so the method extractor sees it as
      // the owner node and correctly marks methods as static. Name resolution
      // for qualified names is handled separately by findEnclosingClassInfo.
      return current;
    }
    current = current.parent;
  }
  return null;
}

const isCppClassMemberDeclarationNode = (node: SyntaxNode | null | undefined): boolean => {
  let current = node?.parent ?? null;
  while (current) {
    if (current.type === 'class_specifier' || current.type === 'struct_specifier') return true;
    if (current.type === 'function_definition' && /^\s*(class|struct)\b/.test(current.text))
      return true;
    current = current.parent;
  }
  return false;
};

function isCppTemporaryReceiverCall(callNode: SyntaxNode, language: SupportedLanguages): boolean {
  if (language !== SupportedLanguages.CPlusPlus || callNode.type !== 'call_expression') {
    return false;
  }

  const parent = callNode.parent;
  if (parent?.type !== 'field_expression') {
    return false;
  }

  const receiverNode = parent.childForFieldName?.('argument') ?? parent.namedChildren?.[0];
  return receiverNode === callNode && parent.parent?.type === 'call_expression';
}

/**
 * For C++ out-of-class method definitions (e.g. `void Foo::bar() {}`), extract the
 * class name from the qualified_identifier scope and find the class declaration in the
 * file's AST. Returns the class SyntaxNode or null if not found.
 *
 * Handles pointer/reference return types where function_declarator is nested inside
 * pointer_declarator or reference_declarator.
 */
function findClassNodeByQualifiedName(node: SyntaxNode): SyntaxNode | null {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;

  // Find the function_declarator, recursively unwrapping pointer_declarator /
  // reference_declarator chains (e.g. int** Foo::bar() has
  // pointer_declarator → pointer_declarator → function_declarator).
  let funcDecl: SyntaxNode | null = null;
  if (declarator.type === 'function_declarator') {
    funcDecl = declarator;
  } else {
    let current: SyntaxNode | null = declarator;
    while (current && !funcDecl) {
      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === 'function_declarator') {
          funcDecl = child;
          break;
        }
      }
      if (!funcDecl) {
        const next = current.namedChildren.find(
          (c) => c.type === 'pointer_declarator' || c.type === 'reference_declarator',
        );
        current = next ?? null;
      }
    }
  }
  if (!funcDecl) return null;

  // Check if the inner declarator is a qualified_identifier (Foo::bar)
  const innerDecl = funcDecl.childForFieldName('declarator');
  if (!innerDecl || innerDecl.type !== 'qualified_identifier') return null;

  const scope = innerDecl.childForFieldName('scope');
  if (!scope) return null;
  const className = scope.text;

  // Search the file for a matching class/struct specifier, including inside
  // namespace_definition blocks (the majority of production C++ uses namespaces).
  const root = node.tree.rootNode;
  const classTypes = new Set(['class_specifier', 'struct_specifier']);
  const searchIn = (parent: SyntaxNode): SyntaxNode | null => {
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (!child) continue;
      if (classTypes.has(child.type)) {
        const nameNode = child.childForFieldName('name');
        if (nameNode?.text === className) return child;
      }
      // Recurse into namespace blocks
      if (child.type === 'namespace_definition') {
        const found = searchIn(child);
        if (found) return found;
      }
    }
    return null;
  };
  return searchIn(root);
}

/**
 * Minimal no-op SymbolTable stub for FieldExtractorContext in the worker.
 * Field extraction only uses symbolTable.lookupExactAll for optional type
 * resolution — returning [] causes the extractor to use the raw type
 * string, which is fine for us. Every other method is a no-op so the
 * stub remains safe if a future FieldExtractor consults it through the
 * full {@link SymbolTableReader} surface.
 */
const NOOP_SYMBOL_TABLE: SymbolTableReader = {
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
  lookupExactAll: () => [],
  lookupCallableByName: () => [],
  getFiles: () => [][Symbol.iterator](),
  getStats: () => ({ fileCount: 0 }),
};

/**
 * Get (or extract and cache) field info for a class node.
 * Returns a name→FieldInfo map, or undefined if the provider has no field extractor
 * or the class yielded no fields.
 */
function getFieldInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
  if (!provider.fieldExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = fieldInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.fieldExtractor.extract(classNode, context);
  if (!result?.fields?.length) return undefined;

  cached = new Map<string, FieldInfo>();
  for (const field of result.fields) {
    cached.set(field.name, field);
  }
  fieldInfoCache.set(cacheKey, cached);
  return cached;
}

// ============================================================================
// MethodExtractor cache — extract method metadata once per class, reuse for each method.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const methodInfoCache = new Map<number, Map<string, MethodInfo>>();

/**
 * Get (or extract and cache) method info for a class node.
 * Returns a "name:line" → MethodInfo map, or undefined if the provider has no method extractor
 * or the class yielded no methods.
 * Keyed by name:line (not name alone) to support overloaded methods in Java/Kotlin.
 */
function getMethodInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: MethodExtractorContext,
): Map<string, MethodInfo> | undefined {
  if (!provider.methodExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = methodInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.methodExtractor.extract(classNode, context);
  if (!result?.methods?.length) return undefined;

  cached = new Map<string, MethodInfo>();
  for (const method of result.methods) {
    cached.set(`${method.name}:${method.line}`, method);
  }
  methodInfoCache.set(cacheKey, cached);
  return cached;
}

// ============================================================================
// Enclosing function detection (for call extraction) — cached
// ============================================================================

/** Walk up AST to find enclosing function, return its generateId or null for top-level.
 *  Applies provider.labelOverride so the label matches the definition phase (single source of truth). */
const findEnclosingFunctionId = (
  node: SyntaxNode,
  filePath: string,
  provider: LanguageProvider,
): string | null => {
  const cached = functionIdCache.get(node);
  if (cached !== undefined) return cached;

  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const efnResult = provider.methodExtractor?.extractFunctionName?.(current);
      const funcName = efnResult?.funcName ?? genericFuncName(current);
      const label = efnResult?.label ?? inferFunctionLabel(current.type);
      if (funcName) {
        // Apply labelOverride so label matches definition phase (e.g., Kotlin Function→Method).
        // null means "skip as definition" — keep original label for scope identification.
        let finalLabel = label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current, label);
          if (override !== null) finalLabel = override;
        }
        // Qualify with enclosing class to match definition-phase node IDs
        const classInfo = cachedFindEnclosingClassInfo(
          current,
          filePath,
          provider.resolveEnclosingOwner,
        );
        const qualifiedName = classInfo ? `${classInfo.className}.${funcName}` : funcName;
        // Include #<arity> suffix to match definition-phase Method/Constructor IDs.
        // Use the same MethodExtractor (getMethodInfo) as the definition phase.
        // When same-arity collisions exist, also append ~type1,type2.
        let arity: number | undefined;
        let encTypeTag = '';
        if (finalLabel === 'Method' || finalLabel === 'Constructor') {
          const encLang = getLanguageFromFilename(filePath);
          const classNode =
            findEnclosingClassNode(current) ?? findClassNodeByQualifiedName(current);
          let info: MethodInfo | undefined;
          if (classNode && encLang) {
            const methodMap = getMethodInfo(classNode, provider, {
              filePath,
              language: encLang,
            });
            const defLine = current.startPosition.row + 1;
            info = methodMap?.get(`${funcName}:${defLine}`);
            if (info) {
              arity = info.parameters.some((p) => p.isVariadic)
                ? undefined
                : info.parameters.length;
              if (methodMap && arity !== undefined) {
                const g = buildCollisionGroups(methodMap);
                encTypeTag =
                  typeTagForId(methodMap, funcName, arity, info, encLang, g) +
                  constTagForId(methodMap, funcName, arity, info, g);
              }
            }
          }
          if (!info && provider.methodExtractor?.extractFromNode && encLang) {
            const nodeInfo = provider.methodExtractor.extractFromNode(current, {
              filePath,
              language: encLang,
            });
            if (nodeInfo) {
              arity = nodeInfo.parameters.some((p) => p.isVariadic)
                ? undefined
                : nodeInfo.parameters.length;
            }
          }
        }
        const arityTag = arity !== undefined ? `#${arity}${encTypeTag}` : '';
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    // Language-specific enclosing function resolution (e.g., Dart where
    // function_body is a sibling of function_signature, not a child).
    if (provider.enclosingFunctionFinder) {
      const customResult = provider.enclosingFunctionFinder(current);
      if (customResult) {
        let finalLabel: NodeLabel = customResult.label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current.previousSibling, finalLabel);
          if (override !== null) finalLabel = override;
        }
        // Qualify custom result with enclosing class
        const classInfo = cachedFindEnclosingClassInfo(
          current.previousSibling ?? current,
          filePath,
          provider.resolveEnclosingOwner,
        );
        const qualifiedName = classInfo
          ? `${classInfo.className}.${customResult.funcName}`
          : customResult.funcName;
        // Include #<arity> suffix to match definition-phase Method/Constructor IDs.
        // When same-arity collisions exist, also append ~type1,type2.
        const sigNode = current.previousSibling ?? current;
        let arity2: number | undefined;
        let encTypeTag2 = '';
        if (finalLabel === 'Method' || finalLabel === 'Constructor') {
          const encLang2 = getLanguageFromFilename(filePath);
          const classNode2 =
            findEnclosingClassNode(sigNode) ?? findClassNodeByQualifiedName(sigNode);
          if (classNode2 && encLang2) {
            const methodMap2 = getMethodInfo(classNode2, provider, {
              filePath,
              language: encLang2,
            });
            const defLine2 = sigNode.startPosition.row + 1;
            const info2 = methodMap2?.get(`${customResult.funcName}:${defLine2}`);
            if (info2) {
              arity2 = info2.parameters.some((p) => p.isVariadic)
                ? undefined
                : info2.parameters.length;
              if (methodMap2 && arity2 !== undefined) {
                const g2 = buildCollisionGroups(methodMap2);
                encTypeTag2 =
                  typeTagForId(methodMap2, customResult.funcName, arity2, info2, encLang2, g2) +
                  constTagForId(methodMap2, customResult.funcName, arity2, info2, g2);
              }
            }
          }
        }
        const arityTag2 = arity2 !== undefined ? `#${arity2}${encTypeTag2}` : '';
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag2}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    current = current.parent;
  }
  functionIdCache.set(node, null);
  return null;
};

/** Cached wrapper for findEnclosingClassInfo — avoids repeated parent walks. */
const cachedFindEnclosingClassInfo = (
  node: SyntaxNode,
  filePath: string,
  resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): EnclosingClassInfo | null => {
  const cached = classIdCache.get(node);
  if (cached !== undefined) return cached;

  const result = findEnclosingClassInfo(node, filePath, resolveEnclosingOwner);
  classIdCache.set(node, result);
  return result;
};

/** Cached wrapper for export checking — avoids repeated parent walks per symbol. */
const cachedExportCheck = (
  checker: (node: SyntaxNode, name: string) => boolean,
  node: SyntaxNode,
  name: string,
): boolean => {
  const cached = exportCache.get(node);
  if (cached !== undefined) return cached;

  const result = checker(node, name);
  exportCache.set(node, result);
  return result;
};

const findFunctionDeclarator = (node: SyntaxNode): SyntaxNode | null => {
  let current = node.childForFieldName?.('declarator') ?? null;
  while (
    current &&
    (current.type === 'pointer_declarator' || current.type === 'reference_declarator')
  ) {
    current = current.childForFieldName?.('declarator') ?? null;
  }
  return current?.type === 'function_declarator' ? current : null;
};

const findCppQualifiedOwnerInfo = (
  node: SyntaxNode,
  filePath: string,
  language: SupportedLanguages,
  knownTypeOwnerHints: readonly CppTypeOwnerHint[],
  cppTypeOwnerHints: readonly CppTypeOwnerHint[] = [],
  memberName?: string,
): CppQualifiedOwnerInfo | null => {
  if (language !== SupportedLanguages.CPlusPlus || node.type !== 'function_definition') return null;

  const functionDeclarator = findFunctionDeclarator(node);
  const qualifiedIdentifier = functionDeclarator?.childForFieldName?.('declarator');
  if (qualifiedIdentifier?.type !== 'qualified_identifier') return null;

  const scopeNode =
    qualifiedIdentifier.childForFieldName?.('scope') ??
    qualifiedIdentifier.children?.find((child) =>
      ['namespace_identifier', 'type_identifier', 'identifier', 'qualified_identifier'].includes(
        child.type,
      ),
    );
  const scopeText = scopeNode?.text;
  if (!scopeText) return null;
  const ownerHint = resolveCppTypeOwnerHint(
    scopeText,
    filePath,
    knownTypeOwnerHints,
    cppTypeOwnerHints,
  );
  if (!ownerHint) return null;
  const declarationHint = memberName
    ? findCppMemberDeclarationHint(ownerHint, memberName)
    : undefined;

  return {
    classId: generateId(ownerHint.label, `${ownerHint.filePath}:${ownerHint.name}`),
    className: ownerHint.name,
    classFilePath: ownerHint.filePath,
    ...(declarationHint
      ? {
          declarationStartLine: declarationHint.startLine,
          declarationEndLine: declarationHint.endLine,
        }
      : {}),
  };
};

const collectKnownTypeOwnerHints = (
  matches: readonly Parser.QueryMatch[],
  provider: LanguageProvider,
  filePath: string,
): CppTypeOwnerHint[] => {
  const knownTypeOwnerHints: CppTypeOwnerHint[] = [];
  for (const match of matches) {
    const captureMap = buildCaptureMap(match);
    const label = getLabelFromCaptures(captureMap, provider);
    const name = captureMap['name']?.text;
    if (name && (label === 'Class' || label === 'Struct')) {
      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const memberDeclarations =
        definitionNode?.text && typeof definitionNode.startPosition?.row === 'number'
          ? extractCppMemberDeclarationHints(definitionNode.text, definitionNode.startPosition.row)
          : [];
      knownTypeOwnerHints.push({
        name,
        label,
        filePath,
        ...(memberDeclarations.length > 0 ? { memberDeclarations } : {}),
      });
    }
  }
  return uniqueCppHints(knownTypeOwnerHints);
};

// Label detection moved to shared getLabelFromCaptures in utils.ts

// DEFINITION_CAPTURE_KEYS and getDefinitionNodeFromCaptures imported from ../utils.js

// ============================================================================
// Process a batch of files
// ============================================================================

const processBatch = async (
  files: ParseWorkerInput[],
  onProgress?: (filesProcessed: number, filePath?: string) => void,
  onFileStart?: (filePath: string) => void,
): Promise<ParseWorkerResult> => {
  const hydratedFiles = await hydrateParseWorkerInputs(files);
  const result: ParseWorkerResult = {
    nodes: [],
    relationships: [],
    symbols: [],
    imports: [],
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
    processedPaths: [],
    fileTimings: [],
    extractorTimings: [],
    skippedLanguages: {},
    fileCount: 0,
  };

  // Group by language to minimize setLanguage calls
  const byLanguage = new Map<SupportedLanguages, HydratedParseWorkerInput[]>();
  for (const file of hydratedFiles) {
    const lang = getLanguageFromFilename(file.path);
    if (!lang) continue;
    let list = byLanguage.get(lang);
    if (!list) {
      list = [];
      byLanguage.set(lang, list);
    }
    list.push(file);
  }

  let totalProcessed = 0;
  let lastReported = 0;
  const PROGRESS_INTERVAL = Math.max(
    1,
    Number.parseInt(process.env.ONTOINDEX_PARSE_PROGRESS_INTERVAL ?? '1', 10) || 1,
  );

  const onFileProcessed = onProgress
    ? (filePath: string) => {
        totalProcessed++;
        if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
          lastReported = totalProcessed;
          onProgress(totalProcessed, filePath);
        }
      }
    : undefined;

  for (const [language, langFiles] of byLanguage) {
    const provider = getProvider(language);
    const queryString = provider.treeSitterQueries;
    if (!queryString) continue;

    // Track if we need to handle tsx separately
    const tsxFiles: HydratedParseWorkerInput[] = [];
    const regularFiles: HydratedParseWorkerInput[] = [];

    if (language === SupportedLanguages.TypeScript) {
      for (const f of langFiles) {
        if (f.path.endsWith('.tsx')) {
          tsxFiles.push(f);
        } else {
          regularFiles.push(f);
        }
      }
    } else {
      // Manual loop (not spread) — `push(...arr)` blows the stack on very
      // large arrays when langFiles has tens of thousands of entries.
      for (const f of langFiles) regularFiles.push(f);
    }

    // Process regular files for this language
    if (regularFiles.length > 0) {
      if (isLanguageAvailable(language, regularFiles[0].path)) {
        try {
          setLanguage(language, regularFiles[0].path);
          processFileGroup(
            regularFiles,
            language,
            queryString,
            result,
            onFileProcessed,
            onFileStart,
          );
        } catch (err) {
          // parser unavailable — skip this language group
          emitWorkerWarning(
            `Skipping ${language} files after worker parse error: ${err instanceof Error ? err.message : String(err)}`,
            {
              phase: 'language-group',
              currentFilePath: regularFiles[0]?.path,
              firstFilePath: regularFiles[0]?.path,
              lastFilePath: regularFiles[regularFiles.length - 1]?.path,
            },
          );
        }
      } else {
        result.skippedLanguages[language] =
          (result.skippedLanguages[language] || 0) + regularFiles.length;
      }
    }

    // Process tsx files separately (different grammar)
    if (tsxFiles.length > 0) {
      if (isLanguageAvailable(language, tsxFiles[0].path)) {
        try {
          setLanguage(language, tsxFiles[0].path);
          processFileGroup(tsxFiles, language, queryString, result, onFileProcessed, onFileStart);
        } catch (err) {
          // parser unavailable — skip this language group
          emitWorkerWarning(
            `Skipping ${language} TSX files after worker parse error: ${err instanceof Error ? err.message : String(err)}`,
            {
              phase: 'language-group',
              currentFilePath: tsxFiles[0]?.path,
              firstFilePath: tsxFiles[0]?.path,
              lastFilePath: tsxFiles[tsxFiles.length - 1]?.path,
            },
          );
        }
      } else {
        result.skippedLanguages[language] =
          (result.skippedLanguages[language] || 0) + tsxFiles.length;
      }
    }
  }

  return result;
};

// Route extraction constants shared with the remaining in-file extractors.
const EXPRESS_ROUTE_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'all',
  'use',
  'route',
]);

// HTTP client methods that are ONLY used by clients, not Express route registration.
// Methods like get/post/put/delete/patch overlap with Express — those are captured by
// the express_route handler as route definitions, not consumers. The fetch() global
// function is captured separately by the route.fetch query.
const HTTP_CLIENT_ONLY_METHODS = new Set(['head', 'options', 'request', 'ajax']);

// Known HTTP client receivers u2014 skip these, they're API consumers not routes
const HTTP_CLIENT_RECEIVERS = new Set([
  'axios',
  'request',
  'fetch',
  'http',
  'https',
  'got',
  'ky',
  'superagent',
  'needle',
  'undici',
  'apiclient',
  'client',
  'httpclient',
  'api',
  '$http',
  'session',
  'httpservice',
  'conn',
]);

// Decorator names that indicate HTTP route handlers (NestJS, Flask, FastAPI, Spring)
const ROUTE_DECORATOR_NAMES = new Set([
  'Get',
  'Post',
  'Put',
  'Delete',
  'Patch',
  'Route',
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'route',
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
]);

const appendSupplementalFreeCalls = (
  filePath: string,
  calledNames: readonly string[],
  result: ParseWorkerResult,
): void => {
  for (const calledName of calledNames) {
    result.calls.push({
      filePath,
      calledName,
      sourceId: generateId('File', filePath),
      callForm: 'free',
    });
  }
};

const shouldExtractJsxComponentCalls = (
  language: SupportedLanguages,
  filePath: string,
  componentFilePatterns: readonly string[] | undefined,
): boolean => {
  if (language !== SupportedLanguages.TypeScript && language !== SupportedLanguages.JavaScript) {
    return false;
  }

  return (
    (language === SupportedLanguages.TypeScript &&
      (filePath.endsWith('.tsx') || filePath.endsWith('.jsx'))) ||
    (language === SupportedLanguages.JavaScript && filePath.endsWith('.jsx')) ||
    matchesModelPackPattern(filePath, componentFilePatterns)
  );
};

const matchesModelPackPattern = (
  filePath: string,
  filePatterns: readonly string[] | undefined,
): boolean => {
  if (!filePatterns || filePatterns.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return filePatterns.some((pattern) => minimatch(normalized, pattern, { dot: true }));
};

const appendSupplementalFileExtractions = (
  file: HydratedParseWorkerInput,
  language: SupportedLanguages,
  parseContent: string,
  tree: Parser.Tree,
  provider: LanguageProvider,
  result: ParseWorkerResult,
): void => {
  if (
    provider.isRouteFile?.(file.path) ||
    matchesModelPackPattern(file.path, file.routeFilePatterns)
  ) {
    const extractedRoutes = extractLaravelRoutes(tree, file.path);
    for (const route of extractedRoutes) result.routes.push(route);
  }

  extractORMQueries(file.path, parseContent, result.ormQueries, {
    prismaClientIdentifiers: file.prismaClientIdentifiers,
    supabaseClientIdentifiers: file.supabaseClientIdentifiers,
  });

  if (language === SupportedLanguages.Vue) {
    appendSupplementalFreeCalls(file.path, extractTemplateComponents(file.content), result);
  }

  if (shouldExtractJsxComponentCalls(language, file.path, file.componentFilePatterns)) {
    appendSupplementalFreeCalls(file.path, extractJsxComponents(file.content), result);
  }
};

const buildCaptureMap = (match: Parser.QueryMatch): Record<string, SyntaxNode> => {
  const captureMap: Record<string, SyntaxNode> = {};
  for (const capture of match.captures) {
    captureMap[capture.name] = capture.node;
  }
  return captureMap;
};

const buildHeritageParentMap = (
  matches: Parser.QueryMatch[],
  provider: LanguageProvider,
  filePath: string,
  language: SupportedLanguages,
): ReadonlyMap<string, readonly string[]> => {
  const fileParentMap = new Map<string, string[]>();
  if (!provider.heritageExtractor) return fileParentMap;

  for (const match of matches) {
    const captureMap = buildCaptureMap(match);
    if (!captureMap['heritage.class']) continue;

    const heritageItems = provider.heritageExtractor.extract(captureMap, {
      filePath,
      language,
    });
    for (const item of heritageItems) {
      if (item.kind !== 'extends') continue;
      let parents = fileParentMap.get(item.className);
      if (!parents) {
        parents = [];
        fileParentMap.set(item.className, parents);
      }
      if (!parents.includes(item.parentName)) parents.push(item.parentName);
    }
  }

  return fileParentMap;
};

const appendTypeEnvArtifacts = (
  filePath: string,
  typeEnv: ReturnType<typeof buildTypeEnv>,
  result: ParseWorkerResult,
): void => {
  if (typeEnv.constructorBindings.length > 0) {
    result.constructorBindings.push({
      filePath,
      bindings: [...typeEnv.constructorBindings],
    });
  }

  const fileScope = typeEnv.fileScope();
  if (fileScope.size > 0) {
    const scopeBindings: [string, string][] = [];
    for (const [varName, typeName] of fileScope) {
      scopeBindings.push([varName, typeName]);
    }
    result.fileScopeBindings.push({ filePath, bindings: scopeBindings });
  }
};

let activeDiagnostics: ParseWorkerDiagnostics | undefined;
let activePhase: string | undefined;
let activeCurrentFilePath: string | undefined;
let activeLastProcessedFilePath: string | undefined;

const buildActiveDiagnostics = (
  overrides: ParseWorkerDiagnostics = {},
): ParseWorkerDiagnostics | undefined => {
  const diagnostics = {
    ...activeDiagnostics,
    phase: overrides.phase ?? activePhase,
    currentFilePath: overrides.currentFilePath ?? activeCurrentFilePath,
    lastProcessedFilePath: overrides.lastProcessedFilePath ?? activeLastProcessedFilePath,
    ...overrides,
  };
  return Object.values(diagnostics).some((value) => value !== undefined) ? diagnostics : undefined;
};

const emitWorkerDiagnostic = (diagnostics: ParseWorkerDiagnostics): void => {
  sendToParent({ type: 'diagnostic', diagnostics });
};

const emitWorkerWarning = (message: string, diagnostics?: ParseWorkerDiagnostics): void => {
  sendToParent({ type: 'warning', message, diagnostics: buildActiveDiagnostics(diagnostics) });
};

interface PreparedFileContext {
  parseContent: string;
  lineOffset: number;
  isVueSetup: boolean;
  tree: Parser.Tree;
  matches: Parser.QueryMatch[];
  provider: LanguageProvider;
}

interface FileProcessingState extends PreparedFileContext {
  file: HydratedParseWorkerInput;
  language: SupportedLanguages;
  typeEnv: ReturnType<typeof buildTypeEnv>;
  callRouter: LanguageProvider['callRouter'];
}

const prepareFileContext = (
  file: HydratedParseWorkerInput,
  language: SupportedLanguages,
  query: Parser.Query,
): PreparedFileContext | null => {
  if (file.content.length > TREE_SITTER_MAX_BUFFER) return null;

  let parseContent = file.content;
  let lineOffset = 0;
  let isVueSetup = false;
  if (language === SupportedLanguages.Vue) {
    const extracted = extractVueScript(file.content);
    if (!extracted) return null;
    parseContent = extracted.scriptContent;
    lineOffset = extracted.lineOffset;
    isVueSetup = extracted.isSetup;
  }

  clearCaches();

  let tree: Parser.Tree;
  try {
    tree = parser.parse(parseContent, undefined, {
      bufferSize: getTreeSitterBufferSize(parseContent.length),
    });
  } catch (err) {
    emitWorkerWarning(
      `Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      { phase: 'parse', currentFilePath: file.path },
    );
    return null;
  }

  const maxAstNodes = getParseMaxAstNodes();
  const astNodeCount = tree.rootNode.descendantCount + 1;
  if (maxAstNodes !== null && astNodeCount > maxAstNodes) {
    return null;
  }

  const maxAstDepth = getParseMaxAstDepth();
  if (maxAstDepth !== null && exceedsParseMaxAstDepth(tree.rootNode, maxAstDepth)) {
    return null;
  }

  let matches: Parser.QueryMatch[];
  try {
    matches = query.matches(tree.rootNode);
  } catch (err) {
    emitWorkerWarning(
      `Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      { phase: 'query', currentFilePath: file.path },
    );
    return null;
  }

  return {
    parseContent,
    lineOffset,
    isVueSetup,
    tree,
    matches,
    provider: getProvider(language),
  };
};

const appendParsedFileArtifact = (
  filePath: string,
  provider: LanguageProvider,
  parseContent: string,
  result: ParseWorkerResult,
): void => {
  // RFC #909 Ring 2: produce a `ParsedFile` for the new scope-based
  // resolution pipeline. No-op (returns undefined) for every language
  // today — only fires once a provider implements `emitScopeCaptures`.
  // Runs BEFORE legacy extraction and its result is independent: a
  // failure here is caught inside `extractParsedFile` and does NOT
  // affect the legacy DAG path that follows.
  const parsedFile = extractParsedFile(provider, parseContent, filePath, emitWorkerWarning);
  if (parsedFile !== undefined) result.parsedFiles.push(parsedFile);
};

const createFileProcessingState = (
  file: HydratedParseWorkerInput,
  language: SupportedLanguages,
  fileContext: PreparedFileContext,
): FileProcessingState => {
  const parentMap = buildHeritageParentMap(
    fileContext.matches,
    fileContext.provider,
    file.path,
    language,
  );
  const typeEnv = buildTypeEnv(fileContext.tree, language, {
    parentMap,
    enclosingFunctionFinder: fileContext.provider?.enclosingFunctionFinder,
    extractFunctionName: fileContext.provider?.methodExtractor?.extractFunctionName,
  });

  return {
    ...fileContext,
    file,
    language,
    typeEnv,
    callRouter: fileContext.provider.callRouter,
  };
};

const processFileMatches = (state: FileProcessingState, result: ParseWorkerResult): void => {
  const { file, language, lineOffset, isVueSetup, matches, provider, typeEnv, callRouter } = state;

  // Per-file map: decorator end-line → decorator info, for associating with definitions
  const fileDecorators = new Map<number, { name: string; arg?: string; isTool?: boolean }>();
  const knownTypeOwnerHints = collectKnownTypeOwnerHints(matches, provider, file.path);

  // Track start indices of definition nodes already processed by higher-priority captures
  // (e.g. @definition.function) to avoid duplicate nodes when @definition.const/@definition.variable
  // patterns overlap with the same source range.
  const processedDefinitionNodes = new Set<number>();

  for (const match of matches) {
    const captureMap = buildCaptureMap(match);

    // Extract import paths before skipping
    if (captureMap['import'] && captureMap['import.source']) {
      const rawImportPath = preprocessImportPath(
        captureMap['import.source'].text,
        captureMap['import'],
        provider,
      );
      if (!rawImportPath) continue;
      const extractor = provider.namedBindingExtractor;
      const namedBindings = extractor ? extractor(captureMap['import']) : undefined;
      result.imports.push({
        filePath: file.path,
        rawImportPath,
        language: language,
        ...(namedBindings ? { namedBindings } : {}),
      });
      continue;
    }

    // Extract assignment sites (field write access)
    if (
      captureMap['assignment'] &&
      captureMap['assignment.receiver'] &&
      captureMap['assignment.property']
    ) {
      const receiverText = captureMap['assignment.receiver'].text;
      const propertyName = captureMap['assignment.property'].text;
      if (receiverText && propertyName) {
        const srcId =
          findEnclosingFunctionId(captureMap['assignment'], file.path, provider) ||
          generateId('File', file.path);
        let receiverTypeName: string | undefined;
        if (typeEnv) {
          receiverTypeName = typeEnv.lookup(receiverText, captureMap['assignment']) ?? undefined;
        }
        result.assignments.push({
          filePath: file.path,
          sourceId: srcId,
          receiverText,
          propertyName,
          ...(receiverTypeName ? { receiverTypeName } : {}),
        });
      }
      if (!captureMap['call']) continue;
    }

    // Store decorator metadata for later association with definitions
    if (captureMap['decorator'] && captureMap['decorator.name']) {
      const decoratorName = captureMap['decorator.name'].text;
      const decoratorArg = captureMap['decorator.arg']?.text;
      const decoratorNode = captureMap['decorator'];
      // Store by the decorator's end line — the definition follows immediately after
      fileDecorators.set(decoratorNode.endPosition.row, {
        name: decoratorName,
        arg: decoratorArg,
      });

      if (ROUTE_DECORATOR_NAMES.has(decoratorName)) {
        const routePath = decoratorArg || '';
        const method = decoratorName.replace('Mapping', '').toUpperCase();
        const httpMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
          ? method
          : 'GET';
        result.decoratorRoutes.push({
          filePath: file.path,
          routePath,
          httpMethod,
          decoratorName,
          lineNumber: decoratorNode.startPosition.row + lineOffset,
        });
      }
      // MCP/RPC tool detection: @mcp.tool(), @app.tool(), @server.tool()
      if (decoratorName === 'tool') {
        // Re-store with isTool flag for the definition handler
        fileDecorators.set(decoratorNode.endPosition.row, {
          name: decoratorName,
          arg: decoratorArg,
          isTool: true,
        });
      }
      continue;
    }

    // Extract HTTP consumer URLs: fetch(), axios.get(), $.get(), requests.get(), etc.
    if (captureMap['route.fetch']) {
      const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
      if (urlNode) {
        result.fetchCalls.push({
          filePath: file.path,
          fetchURL: urlNode.text,
          lineNumber: captureMap['route.fetch'].startPosition.row + lineOffset,
        });
      }
      continue;
    }

    // HTTP client calls: axios.get('/path'), $.post('/path'), requests.get('/path')
    // Skip methods also in EXPRESS_ROUTE_METHODS to avoid double-registering Express
    // routes as both route definitions AND consumers (both queries match same AST node)
    if (captureMap['http_client'] && captureMap['http_client.url']) {
      const method = captureMap['http_client.method']?.text;
      const url = captureMap['http_client.url'].text;
      if (method && HTTP_CLIENT_ONLY_METHODS.has(method) && url.startsWith('/')) {
        result.fetchCalls.push({
          filePath: file.path,
          fetchURL: url,
          lineNumber: captureMap['http_client'].startPosition.row + lineOffset,
        });
      }
      continue;
    }

    // Express/Hono route registration: app.get('/path', handler)
    if (
      captureMap['express_route'] &&
      captureMap['express_route.method'] &&
      captureMap['express_route.path']
    ) {
      const method = captureMap['express_route.method'].text;
      const routePath = captureMap['express_route.path'].text;
      if (EXPRESS_ROUTE_METHODS.has(method) && routePath.startsWith('/')) {
        // Extract the receiver (the object the method is called on) to filter out
        // HTTP client calls like axios.get('/api/users') that match the same pattern
        // as Express route registrations.
        const callNode = captureMap['express_route'];
        const funcNode = callNode.childForFieldName?.('function') ?? callNode.children?.[0];
        // Walk through nested member_expressions and call_expressions to
        // reach the innermost receiver identifier.  Handles chains like:
        //   this.httpService.get('/path')   -> member chain    -> 'httpservice'
        //   getClient().get('/path')         -> call_expression -> 'getclient'
        //   axios.get('/path')               -> bare identifier -> 'axios'
        let receiverNode = funcNode?.childForFieldName?.('object') ?? funcNode?.children?.[0];
        while (
          receiverNode?.type === 'member_expression' ||
          receiverNode?.type === 'call_expression'
        ) {
          if (receiverNode.type === 'member_expression') {
            // Drill into the property (rightmost part) of the member expression
            const propNode = receiverNode.childForFieldName?.('property');
            if (propNode) {
              receiverNode = propNode;
            } else {
              break;
            }
          } else {
            // call_expression: unwrap to the function being called
            const innerFunc =
              receiverNode.childForFieldName?.('function') ?? receiverNode.children?.[0];
            if (innerFunc && innerFunc !== receiverNode) {
              receiverNode = innerFunc;
            } else {
              break;
            }
          }
        }
        const receiverText = receiverNode?.text?.toLowerCase() ?? '';

        if (HTTP_CLIENT_RECEIVERS.has(receiverText)) {
          // This is an HTTP client call, not a route definition — skip it
          continue;
        }

        const httpMethod =
          method === 'all' || method === 'use' || method === 'route' ? 'GET' : method.toUpperCase();
        result.decoratorRoutes.push({
          filePath: file.path,
          routePath,
          httpMethod,
          decoratorName: `express.${method}`,
          lineNumber: captureMap['express_route'].startPosition.row + lineOffset,
        });
      }
      continue;
    }

    // Extract call sites
    if (captureMap['call']) {
      const callNode = captureMap['call'];
      if (isCppTemporaryReceiverCall(callNode, language)) {
        continue;
      }

      const callNameNode = captureMap['call.name'];
      const callExtractor = provider.callExtractor;

      if (callExtractor) {
        // ── Path 1: Language-specific call site (bypasses routing) ────
        // Try language-specific extraction (e.g. Java `::` method references)
        // without callNameNode.  If successful, skip routing and the generic
        // path entirely.
        const langCallSite = callExtractor.extract(callNode, undefined);
        if (langCallSite) {
          if (!provider.isBuiltInName(langCallSite.calledName)) {
            const sourceId =
              findEnclosingFunctionId(callNode, file.path, provider) ||
              generateId('File', file.path);
            const receiverName =
              langCallSite.callForm === 'member' ? langCallSite.receiverName : undefined;
            let receiverTypeName = receiverName
              ? typeEnv.lookup(receiverName, callNode)
              : undefined;
            // Type-as-receiver heuristic (e.g. Java `User::getName`)
            if (
              langCallSite.typeAsReceiverHeuristic &&
              receiverName !== undefined &&
              receiverTypeName === undefined &&
              langCallSite.callForm === 'member'
            ) {
              const c0 = receiverName.charCodeAt(0);
              if (c0 >= 65 && c0 <= 90) receiverTypeName = receiverName;
            }
            result.calls.push({
              filePath: file.path,
              calledName: langCallSite.calledName,
              sourceId,
              callForm: langCallSite.callForm,
              ...(receiverName !== undefined ? { receiverName } : {}),
              ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
            });
          }
          continue;
        }

        // ── Path 2: Generic extraction via @call.name ────────────────
        if (callNameNode) {
          const calledName = callNameNode.text;

          // Check heritage extractor for call-based heritage (e.g., Ruby include/extend/prepend)
          if (provider.heritageExtractor?.extractFromCall) {
            const heritageItems = provider.heritageExtractor.extractFromCall(calledName, callNode, {
              filePath: file.path,
              language,
            });
            if (heritageItems !== null) {
              for (const item of heritageItems) {
                result.heritage.push({
                  filePath: file.path,
                  className: item.className,
                  parentName: item.parentName,
                  kind: item.kind,
                });
              }
              continue;
            }
          }

          // Dispatch: route language-specific calls (properties, imports)
          // Heritage routing is handled by heritageExtractor.extractFromCall above.
          const routed = callRouter?.(calledName, captureMap['call']);
          if (routed) {
            if (routed.kind === 'skip') continue;

            if (routed.kind === 'import') {
              result.imports.push({
                filePath: file.path,
                rawImportPath: routed.importPath,
                language,
              });
              continue;
            }

            if (routed.kind === 'properties') {
              const propEnclosingInfo = cachedFindEnclosingClassInfo(
                captureMap['call'],
                file.path,
                provider.resolveEnclosingOwner,
              );
              const propEnclosingClassId = propEnclosingInfo?.classId ?? null;
              // Enrich routed properties with FieldExtractor metadata
              let routedFieldMap: Map<string, FieldInfo> | undefined;
              if (provider.fieldExtractor && typeEnv) {
                const classNode = findEnclosingClassNode(captureMap['call']);
                if (classNode) {
                  routedFieldMap = getFieldInfo(classNode, provider, {
                    typeEnv,
                    symbolTable: NOOP_SYMBOL_TABLE,
                    filePath: file.path,
                    language,
                  });
                }
              }
              for (const item of routed.items) {
                const routedFieldInfo = routedFieldMap?.get(item.propName);
                const propQualifiedName = propEnclosingInfo
                  ? `${propEnclosingInfo.className}.${item.propName}`
                  : item.propName;
                const nodeId = generateId('Property', `${file.path}:${propQualifiedName}`);
                result.nodes.push({
                  id: nodeId,
                  label: 'Property',
                  properties: {
                    name: item.propName,
                    filePath: file.path,
                    startLine: item.startLine,
                    endLine: item.endLine,
                    language,
                    isExported: true,
                    description: item.accessorType,
                    ...(item.declaredType
                      ? { declaredType: item.declaredType }
                      : routedFieldInfo?.type
                        ? { declaredType: routedFieldInfo.type }
                        : {}),
                    ...(routedFieldInfo?.visibility !== undefined
                      ? { visibility: routedFieldInfo.visibility }
                      : {}),
                    ...(routedFieldInfo?.isStatic !== undefined
                      ? { isStatic: routedFieldInfo.isStatic }
                      : {}),
                    ...(routedFieldInfo?.isReadonly !== undefined
                      ? { isReadonly: routedFieldInfo.isReadonly }
                      : {}),
                  },
                });
                result.symbols.push({
                  filePath: file.path,
                  name: item.propName,
                  nodeId,
                  type: 'Property',
                  ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                  ...(item.declaredType
                    ? { declaredType: item.declaredType }
                    : routedFieldInfo?.type
                      ? { declaredType: routedFieldInfo.type }
                      : {}),
                  ...(routedFieldInfo?.visibility !== undefined
                    ? { visibility: routedFieldInfo.visibility }
                    : {}),
                  ...(routedFieldInfo?.isStatic !== undefined
                    ? { isStatic: routedFieldInfo.isStatic }
                    : {}),
                  ...(routedFieldInfo?.isReadonly !== undefined
                    ? { isReadonly: routedFieldInfo.isReadonly }
                    : {}),
                });
                const fileId = generateId('File', file.path);
                const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
                result.relationships.push({
                  id: relId,
                  sourceId: fileId,
                  targetId: nodeId,
                  type: 'DEFINES',
                  confidence: 1.0,
                  reason: '',
                });
                if (propEnclosingClassId) {
                  result.relationships.push({
                    id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                    sourceId: propEnclosingClassId,
                    targetId: nodeId,
                    type: 'HAS_PROPERTY',
                    confidence: 1.0,
                    reason: '',
                  });
                }
              }
              continue;
            }

            // kind === 'call' — fall through to normal call processing below
          }

          if (!provider.isBuiltInName(calledName)) {
            const callSite = callExtractor.extract(callNode, callNameNode);
            if (callSite) {
              const sourceId =
                findEnclosingFunctionId(callNode, file.path, provider) ||
                generateId('File', file.path);
              let receiverTypeName = callSite.receiverName
                ? typeEnv.lookup(callSite.receiverName, callNode)
                : undefined;

              // Type-as-receiver heuristic
              if (
                callSite.typeAsReceiverHeuristic &&
                callSite.receiverName !== undefined &&
                receiverTypeName === undefined &&
                callSite.callForm === 'member'
              ) {
                const c0 = callSite.receiverName.charCodeAt(0);
                if (c0 >= 65 && c0 <= 90) receiverTypeName = callSite.receiverName;
              }

              const inferLiteralType = provider.typeConfig?.inferLiteralType;
              // Skip when no arg list / zero args: nothing to infer for overload typing
              const argTypes =
                inferLiteralType && callSite.argCount !== undefined && callSite.argCount > 0
                  ? extractCallArgTypes(callNode, inferLiteralType, (varName, cn) =>
                      typeEnv.lookup(varName, cn),
                    )
                  : undefined;

              result.calls.push({
                filePath: file.path,
                calledName: callSite.calledName,
                sourceId,
                ...(callSite.argCount !== undefined ? { argCount: callSite.argCount } : {}),
                ...(callSite.callForm !== undefined ? { callForm: callSite.callForm } : {}),
                ...(callSite.receiverName !== undefined
                  ? { receiverName: callSite.receiverName }
                  : {}),
                ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
                ...(callSite.receiverMixedChain !== undefined
                  ? { receiverMixedChain: callSite.receiverMixedChain }
                  : {}),
                ...(argTypes !== undefined ? { argTypes } : {}),
              });
            }
          }
        }
      }
      continue;
    }

    // Extract heritage (extends/implements) via provider heritage extractor
    if (captureMap['heritage.class']) {
      if (provider.heritageExtractor) {
        const heritageItems = provider.heritageExtractor.extract(captureMap, {
          filePath: file.path,
          language,
        });
        for (const item of heritageItems) {
          result.heritage.push({
            filePath: file.path,
            className: item.className,
            parentName: item.parentName,
            kind: item.kind,
          });
        }
        // When the extractor consumes the match, skip symbol processing below.
        if (heritageItems.length > 0) {
          continue;
        }
      }
      // Fallback: the extractor returned [] (or is absent), but the match still
      // carries a heritage-specific capture. The match belongs to a heritage
      // clause and must not fall through to generic symbol processing.
      if (
        captureMap['heritage.extends'] ||
        captureMap['heritage.implements'] ||
        captureMap['heritage.trait']
      ) {
        continue;
      }
    }

    const definitionNode = getDefinitionNodeFromCaptures(captureMap);
    const defaultNodeLabel = getLabelFromCaptures(captureMap, provider);
    if (!defaultNodeLabel) continue;

    const nameNode = captureMap['name'];
    const extractedClassSymbol =
      definitionNode && provider.classExtractor?.isTypeDeclaration(definitionNode)
        ? provider.classExtractor.extract(definitionNode, {
            name: nameNode?.text,
            type: defaultNodeLabel,
          })
        : null;
    let nodeLabel = extractedClassSymbol?.type ?? defaultNodeLabel;

    // Dedup: variable captures (Const/Static/Variable) may overlap with higher-priority
    // captures (e.g. `const fn = () => {}` matches both @definition.function and @definition.const).
    // Skip variable captures whose definition node was already processed.
    if (
      (nodeLabel === 'Const' || nodeLabel === 'Static' || nodeLabel === 'Variable') &&
      definitionNode &&
      processedDefinitionNodes.has(definitionNode.startIndex)
    ) {
      continue;
    }
    if (definitionNode) {
      processedDefinitionNodes.add(definitionNode.startIndex);
    }

    // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
    if (!nameNode && nodeLabel !== 'Constructor' && !extractedClassSymbol) continue;
    const cppTypeDeclarationName =
      language === SupportedLanguages.CPlusPlus &&
      (nodeLabel === 'Class' || nodeLabel === 'Struct') &&
      definitionNode
        ? extractCppTypeDeclarationNameAt(file.content, definitionNode.startIndex, {
            allowForwardDeclaration: true,
          })
        : null;
    const nodeName =
      cppTypeDeclarationName ?? extractedClassSymbol?.name ?? (nameNode ? nameNode.text : 'init');
    const startLine = definitionNode
      ? definitionNode.startPosition.row + lineOffset
      : nameNode
        ? nameNode.startPosition.row + lineOffset
        : lineOffset;

    // Compute enclosing class BEFORE node ID — needed to qualify method IDs
    const needsOwner =
      nodeLabel === 'Method' ||
      nodeLabel === 'Constructor' ||
      nodeLabel === 'Property' ||
      nodeLabel === 'Function';
    const qualifiedOwnerInfo = definitionNode
      ? findCppQualifiedOwnerInfo(
          definitionNode,
          file.path,
          language,
          knownTypeOwnerHints,
          file.cppTypeOwnerHints,
          nodeName,
        )
      : null;
    const enclosingClassInfo =
      qualifiedOwnerInfo ??
      (needsOwner
        ? cachedFindEnclosingClassInfo(
            nameNode || definitionNode,
            file.path,
            provider.resolveEnclosingOwner,
          )
        : null);
    const enclosingClassId = enclosingClassInfo?.classId ?? null;
    if (
      language === SupportedLanguages.CPlusPlus &&
      nodeLabel === 'Function' &&
      enclosingClassInfo
    ) {
      nodeLabel = 'Method';
    }
    if (
      language === SupportedLanguages.CPlusPlus &&
      nodeLabel === 'Function' &&
      isCppClassMemberDeclarationNode(definitionNode ?? nameNode)
    ) {
      continue;
    }

    // Qualify method/property IDs with enclosing class name to avoid collisions
    const qualifiedName = enclosingClassInfo
      ? `${enclosingClassInfo.className}.${nodeName}`
      : nodeName;

    // Extract method metadata BEFORE generating node ID — parameterCount is needed
    // to disambiguate overloaded methods via #<arity> suffix in the ID.
    let declaredType: string | undefined;
    let methodProps: Record<string, unknown> = {};
    let arityForId: number | undefined; // raw param count for ID, even for variadic
    let defMethodMap: Map<string, MethodInfo> | undefined;
    let defMethodInfo: MethodInfo | undefined;
    if (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') {
      // Use MethodExtractor for method metadata — provides parameterCount, parameterTypes,
      // returnType, isAbstract/isFinal/annotations, visibility, and more.
      let enrichedByMethodExtractor = false;
      if (provider.methodExtractor && definitionNode) {
        const classNode =
          findEnclosingClassNode(definitionNode) ?? findClassNodeByQualifiedName(definitionNode);
        if (classNode) {
          const methodMap = getMethodInfo(classNode, provider, {
            filePath: file.path,
            language,
          });
          const defLine = definitionNode.startPosition.row + 1;
          const info = methodMap?.get(`${nodeName}:${defLine}`);
          if (info) {
            enrichedByMethodExtractor = true;
            arityForId = arityForIdFromInfo(info);
            methodProps = buildMethodProps(info);
            defMethodMap = methodMap;
            defMethodInfo = info;
          }
        }
      }

      // For top-level methods (e.g. Go method_declaration), try extractFromNode
      if (
        !enrichedByMethodExtractor &&
        provider.methodExtractor?.extractFromNode &&
        definitionNode
      ) {
        const info = provider.methodExtractor.extractFromNode(definitionNode, {
          filePath: file.path,
          language,
        });
        if (info) {
          enrichedByMethodExtractor = true;
          arityForId = arityForIdFromInfo(info);
          methodProps = buildMethodProps(info);
        }
      }
    }

    // Append #<paramCount> to Method/Constructor IDs to disambiguate overloads.
    // Swift class members may be emitted as Function nodes, so suffix those too.
    // When same-arity collisions exist, append ~type1,type2 for further disambiguation.
    const needsAritySuffix =
      nodeLabel === 'Method' ||
      nodeLabel === 'Constructor' ||
      (nodeLabel === 'Function' && language === SupportedLanguages.Swift && !!enclosingClassInfo);
    let arityTag = needsAritySuffix && arityForId !== undefined ? `#${arityForId}` : '';
    if (arityTag && defMethodMap && defMethodInfo) {
      const groups = buildCollisionGroups(defMethodMap);
      arityTag += typeTagForId(defMethodMap, nodeName, arityForId, defMethodInfo, language, groups);
      arityTag += constTagForId(defMethodMap, nodeName, arityForId, defMethodInfo, groups);
    }
    const nodeIdFilePath =
      qualifiedOwnerInfo?.classFilePath &&
      (nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Function')
        ? qualifiedOwnerInfo.classFilePath
        : file.path;
    const nodeId = generateId(nodeLabel, `${nodeIdFilePath}:${qualifiedName}${arityTag}`);
    const isSplitCppDefinition = Boolean(
      qualifiedOwnerInfo?.classFilePath && qualifiedOwnerInfo.classFilePath !== file.path,
    );
    const classNodeForSymbol = definitionNode || nameNode;
    const qualifiedTypeName =
      cppTypeDeclarationName ??
      extractedClassSymbol?.qualifiedName ??
      (classNodeForSymbol && provider.classExtractor?.isTypeDeclaration(classNodeForSymbol)
        ? (provider.classExtractor.extractQualifiedName(classNodeForSymbol, nodeName) ?? nodeName)
        : undefined);

    const description = provider.descriptionExtractor?.(nodeLabel, nodeName, captureMap);

    let frameworkHint = definitionNode
      ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
      : null;

    // Suppress Spring framework hint for methods inside interfaces
    // (Feign clients, JAX-RS proxies are consumers, not providers)
    if (frameworkHint && definitionNode) {
      let classCheck = definitionNode.parent;
      while (classCheck) {
        if (classCheck.type === 'interface_declaration') {
          frameworkHint = null;
          break;
        }
        if (classCheck.type === 'class_declaration' || classCheck.type === 'program') {
          break;
        }
        classCheck = classCheck.parent;
      }
    }

    // Decorators appear on lines immediately before their definition; allow up to
    // MAX_DECORATOR_SCAN_LINES gap for blank lines / multi-line decorator stacks.
    const MAX_DECORATOR_SCAN_LINES = 5;
    if (definitionNode) {
      const defStartLine = definitionNode.startPosition.row;
      for (
        let checkLine = defStartLine - 1;
        checkLine >= Math.max(0, defStartLine - MAX_DECORATOR_SCAN_LINES);
        checkLine--
      ) {
        const dec = fileDecorators.get(checkLine);
        if (dec) {
          // Use first (closest) decorator found for framework hint
          if (!frameworkHint) {
            frameworkHint = {
              framework: 'decorator',
              entryPointMultiplier: 1.2,
              reason: `@${dec.name}${dec.arg ? `("${dec.arg}")` : ''}`,
            };
          }
          // Emit tool definition if this is a @tool decorator
          if (dec.isTool) {
            result.toolDefs.push({
              filePath: file.path,
              toolName: nodeName,
              description: dec.arg || '',
              lineNumber: definitionNode.startPosition.row + lineOffset,
            });
          }
          fileDecorators.delete(checkLine);
        }
      }
    }

    // Property metadata extraction (not needed before nodeId — Properties don't overload)
    if (nodeLabel === 'Property' && definitionNode) {
      // FieldExtractor is the single source of truth when available
      if (provider.fieldExtractor && typeEnv) {
        const classNode = findEnclosingClassNode(definitionNode);
        if (classNode) {
          const fieldMap = getFieldInfo(classNode, provider, {
            typeEnv,
            symbolTable: NOOP_SYMBOL_TABLE,
            filePath: file.path,
            language,
          });
          const info = fieldMap?.get(nodeName);
          if (info) {
            declaredType = info.type ?? undefined;
            methodProps.visibility = info.visibility;
            methodProps.isStatic = info.isStatic;
            methodProps.isReadonly = info.isReadonly;
          }
        }
      }
    }

    // Variable/Const/Static metadata extraction via VariableExtractor
    if (
      (nodeLabel === 'Const' || nodeLabel === 'Static' || nodeLabel === 'Variable') &&
      definitionNode &&
      provider.variableExtractor
    ) {
      const varCtx: VariableExtractorContext = {
        filePath: file.path,
        language,
      };
      const varInfo = provider.variableExtractor.extract(definitionNode, varCtx);
      if (varInfo) {
        if (varInfo.type) declaredType = varInfo.type;
        methodProps.visibility = varInfo.visibility;
        methodProps.isStatic = varInfo.isStatic;
        methodProps.isConst = varInfo.isConst;
        methodProps.isMutable = varInfo.isMutable;
        methodProps.scope = varInfo.scope;
      }
    }

    result.nodes.push({
      id: nodeId,
      label: nodeLabel,
      properties: {
        name: nodeName,
        filePath: file.path,
        startLine: definitionNode ? definitionNode.startPosition.row + lineOffset : startLine,
        endLine: definitionNode ? definitionNode.endPosition.row + lineOffset : startLine,
        ...(isSplitCppDefinition
          ? {
              declarationFilePath: qualifiedOwnerInfo!.classFilePath,
              ...(typeof qualifiedOwnerInfo!.declarationStartLine === 'number'
                ? { declarationStartLine: qualifiedOwnerInfo!.declarationStartLine }
                : {}),
              ...(typeof qualifiedOwnerInfo!.declarationEndLine === 'number'
                ? { declarationEndLine: qualifiedOwnerInfo!.declarationEndLine }
                : {}),
              definitionFilePath: file.path,
              definitionStartLine: definitionNode
                ? definitionNode.startPosition.row + lineOffset
                : startLine,
              definitionEndLine: definitionNode
                ? definitionNode.endPosition.row + lineOffset
                : startLine,
            }
          : {}),
        language: language,
        isExported:
          language === SupportedLanguages.Vue && isVueSetup
            ? isVueSetupTopLevel(nameNode || definitionNode)
            : cachedExportCheck(provider.exportChecker, nameNode || definitionNode, nodeName),
        ...(qualifiedTypeName !== undefined ? { qualifiedName: qualifiedTypeName } : {}),
        ...(frameworkHint
          ? {
              astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
              astFrameworkReason: frameworkHint.reason,
            }
          : {}),
        ...(description !== undefined ? { description } : {}),
        ...methodProps,
        ...(declaredType !== undefined ? { declaredType } : {}),
      },
    });

    result.symbols.push({
      filePath: file.path,
      name: nodeName,
      nodeId,
      type: nodeLabel,
      ...(qualifiedTypeName !== undefined ? { qualifiedName: qualifiedTypeName } : {}),
      parameterCount: methodProps.parameterCount as number | undefined,
      requiredParameterCount: methodProps.requiredParameterCount as number | undefined,
      parameterTypes: methodProps.parameterTypes as string[] | undefined,
      returnType: methodProps.returnType as string | undefined,
      ...(declaredType !== undefined ? { declaredType } : {}),
      ...(enclosingClassId ? { ownerId: enclosingClassId } : {}),
      ...(isSplitCppDefinition
        ? {
            declarationFilePath: qualifiedOwnerInfo!.classFilePath,
            ...(typeof qualifiedOwnerInfo!.declarationStartLine === 'number'
              ? { declarationStartLine: qualifiedOwnerInfo!.declarationStartLine }
              : {}),
            ...(typeof qualifiedOwnerInfo!.declarationEndLine === 'number'
              ? { declarationEndLine: qualifiedOwnerInfo!.declarationEndLine }
              : {}),
            definitionFilePath: file.path,
            definitionStartLine: definitionNode
              ? definitionNode.startPosition.row + lineOffset
              : startLine,
            definitionEndLine: definitionNode
              ? definitionNode.endPosition.row + lineOffset
              : startLine,
          }
        : {}),
      visibility: methodProps.visibility as string | undefined,
      isStatic: methodProps.isStatic as boolean | undefined,
      isReadonly: methodProps.isReadonly as boolean | undefined,
      isAbstract: methodProps.isAbstract as boolean | undefined,
      isFinal: methodProps.isFinal as boolean | undefined,
      ...(methodProps.isVirtual !== undefined
        ? { isVirtual: methodProps.isVirtual as boolean }
        : {}),
      ...(methodProps.isOverride !== undefined
        ? { isOverride: methodProps.isOverride as boolean }
        : {}),
      ...(methodProps.isAsync !== undefined ? { isAsync: methodProps.isAsync as boolean } : {}),
      ...(methodProps.isPartial !== undefined
        ? { isPartial: methodProps.isPartial as boolean }
        : {}),
      ...(methodProps.annotations !== undefined
        ? { annotations: methodProps.annotations as string[] }
        : {}),
    });

    const fileId = generateId('File', file.path);
    const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
    result.relationships.push({
      id: relId,
      sourceId: fileId,
      targetId: nodeId,
      type: 'DEFINES',
      confidence: 1.0,
      reason: '',
    });

    // ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
    if (enclosingClassId) {
      const memberEdgeType = nodeLabel === 'Property' ? 'HAS_PROPERTY' : 'HAS_METHOD';
      result.relationships.push({
        id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
        sourceId: enclosingClassId,
        targetId: nodeId,
        type: memberEdgeType,
        confidence: 1.0,
        reason: '',
      });
    }
  }
};

const processPreparedWorkerFile = (
  file: HydratedParseWorkerInput,
  language: SupportedLanguages,
  query: Parser.Query,
  result: ParseWorkerResult,
  onFileProcessed?: (filePath: string) => void,
  onFileStart?: (filePath: string) => void,
): void => {
  const started = Date.now();
  let status: ParseFileTiming['status'] = 'skipped';
  const timeFamily = <T>(family: string, fn: () => T, count?: number): T => {
    const familyStarted = Date.now();
    try {
      return fn();
    } finally {
      result.extractorTimings.push({
        family,
        filePath: file.path,
        language,
        durationMs: Date.now() - familyStarted,
        count,
      });
    }
  };

  try {
    onFileStart?.(file.path);
    const fileContext = timeFamily('prepare', () => prepareFileContext(file, language, query));
    if (!fileContext) {
      // Lightweight fallback for oversized or unparseable files
      const native = isNativeEnabled();
      console.warn(
        `[worker] Using ${native ? 'native' : 'lightweight'} fallback for ${file.path} (exceeds Tree-sitter AST or size limits)`,
      );
      const lightweightResult = extractImports(file.path, file.content, language);
      mergeParseWorkerResult(result, lightweightResult);
      status = 'processed';
      return;
    }

    result.fileCount++;
    result.processedPaths.push(file.path);
    onFileProcessed?.(file.path);

    timeFamily('scope-artifact', () =>
      appendParsedFileArtifact(file.path, fileContext.provider, fileContext.parseContent, result),
    );
    const fileState = timeFamily('type-env', () =>
      createFileProcessingState(file, language, fileContext),
    );
    timeFamily('type-env-artifacts', () =>
      appendTypeEnvArtifacts(file.path, fileState.typeEnv, result),
    );
    timeFamily('query-match-extractors', () => processFileMatches(fileState, result));
    timeFamily(
      'supplemental-extractors',
      () =>
        appendSupplementalFileExtractions(
          file,
          language,
          fileState.parseContent,
          fileState.tree,
          fileState.provider,
          result,
        ),
      fileState.matches.length,
    );
    status = 'processed';
  } catch (err) {
    status = 'error';
    throw err;
  } finally {
    result.fileTimings.push({
      filePath: file.path,
      language,
      durationMs: Date.now() - started,
      status,
    });
  }
};

const processFileGroup = (
  files: HydratedParseWorkerInput[],
  language: SupportedLanguages,
  queryString: string,
  result: ParseWorkerResult,
  onFileProcessed?: (filePath: string) => void,
  onFileStart?: (filePath: string) => void,
): void => {
  let query: Parser.Query;
  try {
    const lang = parser.getLanguage();
    query = new Parser.Query(lang, queryString);
  } catch (err) {
    const message = `Query compilation failed for ${language}: ${err instanceof Error ? err.message : String(err)}`;
    emitWorkerWarning(message);
    return;
  }

  for (const file of files) {
    try {
      processPreparedWorkerFile(file, language, query, result, onFileProcessed, onFileStart);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed while processing ${file.path}: ${message}`, { cause: err });
    }
  }
};

// ============================================================================
// Worker message handler — supports sub-batch streaming
// ============================================================================

/** Accumulated result across sub-batches */
let accumulated: ParseWorkerResult = createEmptyResult();
let cumulativeProcessed = 0;

onParentMessage(async (msg: WorkerIncomingMessage) => {
  try {
    // Legacy single-message mode (backward compat): array of files
    if (Array.isArray(msg)) {
      activeDiagnostics = undefined;
      activePhase = 'legacy-batch';
      const result = await processBatch(
        msg,
        (filesProcessed, filePath) => {
          activeLastProcessedFilePath = filePath ?? activeLastProcessedFilePath;
          sendToParent({ type: 'progress', filesProcessed, filePath });
        },
        (filePath) => {
          activePhase = 'process-file';
          activeCurrentFilePath = filePath;
          emitWorkerDiagnostic(
            buildActiveDiagnostics({
              phase: activePhase,
              currentFilePath: filePath,
              filesProcessed: 0,
            }) ?? { phase: activePhase, currentFilePath: filePath, filesProcessed: 0 },
          );
        },
      );
      sendToParent({ type: 'result', data: result });
      return;
    }

    // Sub-batch mode: { type: 'sub-batch', files: [...] }
    if (msg.type === 'sub-batch') {
      activeDiagnostics = msg.diagnostics;
      activePhase = 'sub-batch';
      activeCurrentFilePath = undefined;
      const result = await processBatch(
        msg.files,
        (filesProcessed, filePath) => {
          activeLastProcessedFilePath = filePath ?? activeLastProcessedFilePath;
          sendToParent({
            type: 'progress',
            filesProcessed: cumulativeProcessed + filesProcessed,
            filePath,
          });
        },
        (filePath) => {
          activePhase = 'process-file';
          activeCurrentFilePath = filePath;
          emitWorkerDiagnostic(
            buildActiveDiagnostics({
              phase: activePhase,
              currentFilePath: filePath,
              filesProcessed: cumulativeProcessed,
            }) ?? {
              phase: activePhase,
              currentFilePath: filePath,
              filesProcessed: cumulativeProcessed,
            },
          );
        },
      );
      sendToParent({
        type: 'progress',
        filesProcessed: cumulativeProcessed + result.fileCount,
        filePath: result.processedPaths[result.processedPaths.length - 1],
      });
      cumulativeProcessed += result.fileCount;
      activePhase = 'sub-batch-done';
      activeCurrentFilePath = undefined;
      sendToParent({ type: 'result-part', data: result });
      sendToParent({
        type: 'progress',
        filesProcessed: cumulativeProcessed,
        filePath: result.processedPaths[result.processedPaths.length - 1],
      });
      // Signal ready for next sub-batch
      sendToParent({ type: 'sub-batch-done' });
      return;
    }

    // Flush: send accumulated results
    if (msg.type === 'flush') {
      activeDiagnostics = msg.diagnostics;
      activePhase = 'flush';
      activeCurrentFilePath = undefined;
      sendToParent({
        type: 'progress',
        filesProcessed: cumulativeProcessed,
        filePath: accumulated.processedPaths[accumulated.processedPaths.length - 1],
      });
      sendToParent({ type: 'result' });
      // Reset for potential reuse
      accumulated = createEmptyResult();
      cumulativeProcessed = 0;
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendToParent({ type: 'error', error: message, diagnostics: buildActiveDiagnostics() });
  }
});
