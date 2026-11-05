// ontoindex/src/core/ingestion/field-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'ontoindex-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword, findVisibility, typeFromAnnotation } from './helpers.js';
import type { FieldInfo, FieldVisibility } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { isNameShadowed } from '../../type-extractors/shared.js';

const VISIBILITY_KEYWORDS = new Set<FieldVisibility>(['public', 'private', 'protected']);

function constructorAssignments(owner: SyntaxNode): SyntaxNode[] {
  const body = owner.childForFieldName('body');
  if (body?.type !== 'class_body') return [];
  const assignments: SyntaxNode[] = [];
  for (const method of body.namedChildren) {
    if (method.type !== 'method_definition') continue;
    const name = method.childForFieldName('name');
    if (name?.type !== 'property_identifier' || name.text !== 'constructor') continue;
    if (
      method.children.some((child) => ['static', 'async', 'get', 'set', '*'].includes(child.type))
    )
      continue;
    for (const statement of method.childForFieldName('body')?.namedChildren ?? []) {
      if (statement.type !== 'expression_statement') continue;
      const assignment = statement.firstNamedChild;
      if (assignment?.type === 'assignment_expression' && constructorAssignmentName(assignment)) {
        assignments.push(assignment);
      }
    }
  }
  return assignments;
}

function constructorAssignmentName(node: SyntaxNode): string | undefined {
  const left = node.childForFieldName('left');
  const property = left?.childForFieldName('property');
  return left?.type === 'member_expression' &&
    left.childForFieldName('object')?.type === 'this' &&
    property?.type === 'property_identifier'
    ? property.text
    : undefined;
}

/** Select one assignment capture, with explicit class declarations taking precedence. */
export function isConstructorFieldDefinition(node: SyntaxNode): boolean {
  // assignment_expression → expression_statement → statement_block →
  // method_definition → class_body → class; any other shape is not a field.
  const statement = node.parent;
  const block = statement?.type === 'expression_statement' ? statement.parent : null;
  const method = block?.type === 'statement_block' ? block.parent : null;
  const classBody = method?.type === 'method_definition' ? method.parent : null;
  const owner = classBody?.type === 'class_body' ? classBody.parent : null;
  if (!owner || !['class_declaration', 'class'].includes(owner.type)) return false;
  const name = constructorAssignmentName(node);
  if (!name) return false;
  const body = owner.childForFieldName('body');
  if (
    body?.namedChildren.some(
      (field) =>
        field.type === 'field_definition' && field.childForFieldName('property')?.text === name,
    )
  )
    return false;
  return (
    constructorAssignments(owner).find(
      (assignment) => constructorAssignmentName(assignment) === name,
    )?.id === node.id
  );
}

const shared: Omit<FieldExtractionConfig, 'language'> = {
  typeDeclarationNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
  ],
  fieldNodeTypes: ['public_field_definition', 'property_signature', 'field_definition'],
  bodyNodeTypes: ['class_body', 'interface_body', 'object_type'],
  defaultVisibility: 'public',

  extractName(node) {
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
    return nameNode?.text;
  },

  extractType(node) {
    // tree-sitter TS uses a named 'type' field for type_annotation
    const typeField = node.childForFieldName('type');
    if (typeField) {
      if (typeField.type === 'type_annotation') {
        const inner = typeField.firstNamedChild;
        return inner?.text?.trim();
      }
      return typeField.text?.trim();
    }
    return typeFromAnnotation(node);
  },

  extractVisibility(node) {
    // TypeScript accessibility_modifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'accessibility_modifier') {
        const t = child.text.trim() as FieldVisibility;
        if (VISIBILITY_KEYWORDS.has(t)) return t;
      }
    }
    return findVisibility(node, VISIBILITY_KEYWORDS, 'public', 'modifiers');
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'readonly');
  },
};

export const typescriptConfig: FieldExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
};

export const javascriptConfig: FieldExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
  extractPrimaryFields(owner, context) {
    const fields = new Map<string, FieldInfo>();
    const declared = new Set(
      owner
        .childForFieldName('body')
        ?.namedChildren.filter((node) => node.type === 'field_definition')
        .map((node) => node.childForFieldName('property')?.text),
    );
    for (const assignment of constructorAssignments(owner)) {
      const name = constructorAssignmentName(assignment)!;
      if (declared.has(name)) continue;
      const existing = fields.get(name);
      if (existing) {
        // Multiple writes do not establish a stable field type, even if equal.
        existing.type = null;
        continue;
      }
      const statement = assignment.parent!;
      const comment = statement.previousNamedSibling;
      const jsdoc =
        comment?.type === 'comment' &&
        comment.text.startsWith('/**') &&
        statement.startPosition.row - comment.endPosition.row <= 1
          ? comment.text.match(/@type\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1]
          : undefined;
      const right = assignment.childForFieldName('right');
      const constructor =
        right?.type === 'new_expression' ? right.childForFieldName('constructor') : null;
      const inferred =
        constructor?.type === 'identifier' && !isNameShadowed(constructor, constructor.text)
          ? constructor.text
          : undefined;
      fields.set(name, {
        name,
        type: jsdoc && inferred && jsdoc !== inferred ? null : (jsdoc ?? inferred ?? null),
        visibility: 'public',
        isStatic: false,
        isReadonly: false,
        sourceFile: context.filePath,
        line: assignment.startPosition.row + 1,
      });
    }
    return [...fields.values()];
  },
};
