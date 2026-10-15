import fs from 'fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../core/tree-sitter/parser-loader.js';
import { resolveSymbolCandidates } from './backend-symbol-resolution.js';
import { guardMutationRange } from './backend-move-symbol.js';
import { resolveContainedRealPath } from './path-util.js';

interface ExtractFunctionRepoHandle {
  id: string;
  repoPath: string;
  storagePath?: string;
}

interface ExtractFunctionDryRunResult {
  success: true;
  dry_run: true;
  uid: string;
  new_name: string;
  preview: string;
  filePath?: undefined;
  warnings?: string[];
}

interface ExtractFunctionApplyResult {
  success: true;
  uid: string;
  new_name: string;
  preview?: undefined;
  filePath: string;
  insertedAt: number;
}

type ExtractFunctionResult = ExtractFunctionDryRunResult | ExtractFunctionApplyResult;

export async function extractFunction(
  repo: ExtractFunctionRepoHandle,
  params: {
    uid: string;
    new_name: string;
    target_file?: string;
    dry_run?: boolean;
    confirm?: boolean;
  },
): Promise<ExtractFunctionResult> {
  const { uid, new_name } = params;
  const dry_run = params.dry_run !== false;

  const outcome = await resolveSymbolCandidates(repo, { uid, include_content: true }, {});
  if (outcome.kind !== 'ok') {
    throw new Error(`Symbol not found: ${uid}`);
  }

  const { name, filePath, startLine, endLine } = outcome.symbol;
  const targetFile = params.target_file ?? filePath;
  const warnings = await guardMutationRange(repo, outcome.symbol, dry_run);

  const sourceAbsolute = await resolveContainedRealPath(repo.repoPath, filePath);
  const destination = await resolveContainedRealPath(repo.repoPath, targetFile);
  if (destination !== sourceAbsolute) throw new Error('Cross-file extraction is unsupported');
  if (!/^[A-Za-z_$][\w$]*$/.test(new_name) || new_name === name) {
    throw new Error('Invalid or unchanged helper name');
  }
  try {
    if (new_name === 'await') throw new Error('Reserved identifier');
    new Script(`"use strict"; function ${new_name}() {}`);
  } catch {
    throw new Error('Invalid helper binding name');
  }
  const extension = path.extname(filePath);
  const language = ['.ts', '.tsx'].includes(extension)
    ? SupportedLanguages.TypeScript
    : ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
      ? SupportedLanguages.JavaScript
      : undefined;
  if (!language) throw new Error('Extraction supports only JavaScript and TypeScript');
  const source = await fs.readFile(sourceAbsolute, 'utf-8');
  const parser = await createParserForLanguage(language, filePath);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) throw new Error('Source has syntax errors');
  const nodes: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    nodes.push(node);
    node.namedChildren.forEach(visit);
  };
  visit(tree.rootNode);
  const declarations = nodes.filter(
    (node) =>
      node.type === 'function_declaration' &&
      node.childForFieldName('name')?.text === name &&
      (node.parent?.type === 'program' || node.parent?.type === 'export_statement') &&
      (node.parent?.type !== 'export_statement' || node.parent.parent?.type === 'program'),
  );
  let declaration = declarations.find(
    (node) => node.startPosition.row + 1 === startLine && node.endPosition.row + 1 === endLine,
  );
  if (!declaration && warnings && dry_run && declarations.length === 1) {
    declaration = declarations[0];
  }
  if (!declaration) throw new Error('Stale range or unsupported function declaration');
  if (
    nodes.some(
      (node) =>
        node !== declaration &&
        ['function_declaration', 'function_signature', 'generator_function_declaration'].includes(
          node.type,
        ) &&
        node.childForFieldName('name')?.text === name,
    )
  ) {
    throw new Error('Overloaded or duplicate function declarations are unsupported');
  }
  const identifier = declaration.childForFieldName('name')!;
  const body = declaration.childForFieldName('body');
  const parameters = declaration.childForFieldName('parameters');
  if (
    !body ||
    !parameters ||
    declaration.children.some((node) => ['async', '*', 'type_parameters'].includes(node.type))
  ) {
    throw new Error('Unsupported function signature');
  }
  for (const parameter of parameters.namedChildren) {
    const simple =
      parameter.type === 'identifier' ||
      (parameter.type === 'required_parameter' &&
        (parameter.childForFieldName('pattern')?.type === 'identifier' ||
          (language === SupportedLanguages.TypeScript &&
            parameter.childForFieldName('pattern')?.type === 'this')) &&
        !parameter.children.some((node) =>
          ['=', '?', 'accessibility_modifier'].includes(node.type),
        ));
    const parameterName =
      parameter.type === 'identifier'
        ? parameter.text
        : parameter.childForFieldName('pattern')?.text;
    if (!simple || parameterName === 'arguments') throw new Error('Unsupported function parameter');
  }
  if (nodes.some((node) => node.type === 'identifier' && node.text === new_name)) {
    throw new Error('Helper name collides with an existing identifier');
  }
  const bodyNodes: Parser.SyntaxNode[] = [];
  const inspectBody = (node: Parser.SyntaxNode): void => {
    bodyNodes.push(node);
    node.namedChildren.forEach(inspectBody);
  };
  inspectBody(body);
  if (
    bodyNodes.some(
      (node) =>
        ['meta_property', 'super', 'function_declaration', 'class_declaration'].includes(
          node.type,
        ) ||
        (node.type === 'identifier' && node.text === 'eval') ||
        (node.type === 'identifier' &&
          node.text === 'arguments' &&
          !(
            (node.parent?.type === 'member_expression' &&
              node.parent.childForFieldName('object')?.id === node.id &&
              node.parent.childForFieldName('property')?.text === 'length') ||
            (node.parent?.type === 'subscript_expression' &&
              node.parent.childForFieldName('object')?.id === node.id &&
              node.parent.childForFieldName('index')?.type === 'number')
          )) ||
        (node.type === 'subscript_expression' &&
          node.childForFieldName('object')?.text === 'arguments' &&
          node.childForFieldName('index')?.type !== 'number') ||
        (node.type === 'member_expression' &&
          node.childForFieldName('object')?.text === 'arguments' &&
          ['callee', 'caller'].includes(node.childForFieldName('property')?.text ?? '')) ||
        (node.type === 'identifier' && node.text === name),
    )
  ) {
    throw new Error('Unsupported binding-sensitive function body');
  }
  // Node indices are UTF-16 offsets in the Node tree-sitter binding; verify them
  // against node.text before using them to splice the current source.
  for (const node of [declaration, identifier, body]) {
    if (source.slice(node.startIndex, node.endIndex) !== node.text) {
      throw new Error('Unsupported parser source offsets');
    }
  }
  const container =
    declaration.parent?.type === 'export_statement' ? declaration.parent : declaration;
  if (source.slice(container.startIndex, container.endIndex) !== container.text) {
    throw new Error('Unsupported parser source offsets');
  }
  const helperText =
    source.slice(declaration.startIndex, identifier.startIndex) +
    new_name +
    source.slice(identifier.endIndex, declaration.endIndex);
  const directives: string[] = [];
  for (const statement of body.namedChildren) {
    if (statement.type === 'comment') continue;
    if (statement.type !== 'expression_statement' || statement.namedChildren[0]?.type !== 'string')
      break;
    directives.push(statement.text);
  }
  const wrapper =
    source.slice(container.startIndex, body.startIndex) +
    `{\n${directives.map((directive) => `  ${directive}\n`).join('')}  return ${new_name}.apply(${bodyNodes.some((node) => node.type === 'this') ? 'this' : 'undefined'}, ${language === SupportedLanguages.TypeScript ? `arguments as unknown as Parameters<typeof ${new_name}>` : 'arguments'});\n}`;
  const newSource =
    source.slice(0, container.startIndex) +
    helperText +
    '\n\n' +
    wrapper +
    source.slice(container.endIndex);
  if (parser.parse(newSource).rootNode.hasError)
    throw new Error('Extracted source has syntax errors');

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      uid,
      new_name,
      preview: newSource,
      ...(warnings ? { warnings } : {}),
    };
  }

  if (params.confirm !== true) {
    throw new Error('Explicit confirmation required (set confirm: true)');
  }

  if ((await fs.readFile(sourceAbsolute, 'utf-8')) !== source)
    throw new Error('Source changed during extraction');
  await fs.writeFile(sourceAbsolute, newSource, 'utf-8');

  const insertedAt = declaration.startPosition.row + 1;
  return {
    success: true,
    uid,
    new_name,
    filePath,
    insertedAt,
  };
}
