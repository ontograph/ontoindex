// ontoindex/src/core/ingestion/field-extractors/configs/helpers.ts

/**
 * Shared AST-walking helpers used by multiple language configs.
 * Keeps individual config files small.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

// ---------------------------------------------------------------------------
// Modifier scanning
// ---------------------------------------------------------------------------

/**
 * Check whether any child of `node` (named or unnamed) has .text matching
 * the given `keyword`.
 *
 * Skips the `name` field child to avoid false positives when a method is
 * named after a contextual keyword (e.g. `abstract()` in TypeScript).
 */
export function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  const nameNode = node.childForFieldName('name');
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child === nameNode) continue;
    if (child.text.trim() === keyword) return true;
  }
  return false;
}

/**
 * Check whether a named child of type `modifierType` contains `keyword`.
 * Useful for languages that group modifiers under a wrapper node
 * (e.g. Java 'modifiers', Kotlin 'modifiers').
 */
export function hasModifier(node: SyntaxNode, modifierType: string, keyword: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === modifierType) {
      for (let j = 0; j < child.childCount; j++) {
        const mod = child.child(j);
        if (mod && mod.text.trim() === keyword) return true;
      }
    }
  }
  return false;
}

/**
 * Return the first matching visibility keyword found either as a direct keyword
 * child or inside a modifier wrapper node.
 * Skips the `name` field child (same rationale as hasKeyword).
 */
export function findVisibility(
  node: SyntaxNode,
  keywords: ReadonlySet<FieldVisibility>,
  defaultVis: FieldVisibility,
  modifierNodeType?: string,
): FieldVisibility {
  const nameNode = node.childForFieldName('name');
  // Direct keyword children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child === nameNode) continue;
    const text = child.text.trim() as FieldVisibility | undefined;
    if (text && (keywords as ReadonlySet<string>).has(text)) return text;
  }
  // Modifier wrapper
  if (modifierNodeType) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === modifierNodeType) {
        for (let j = 0; j < child.childCount; j++) {
          const mod = child.child(j);
          const modText = mod?.text.trim() as FieldVisibility | undefined;
          if (modText && (keywords as ReadonlySet<string>).has(modText)) return modText;
        }
      }
    }
  }
  return defaultVis;
}

// ---------------------------------------------------------------------------
// Name and type extraction
// ---------------------------------------------------------------------------

/**
 * Get type text from a named field on the node, using extractSimpleTypeName.
 * Falls back to raw .text of the field child if extractSimpleTypeName returns undefined.
 */
export function typeFromField(node: SyntaxNode, fieldName: string): string | undefined {
  const typeNode = node.childForFieldName(fieldName);
  if (!typeNode) return undefined;
  return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
}

/**
 * Walk named children looking for a type_annotation node and extract its type.
 */
export function typeFromAnnotation(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'type_annotation') {
      const inner = child.firstNamedChild;
      if (inner) return extractSimpleTypeName(inner) ?? inner.text?.trim();
    }
  }
  return undefined;
}

/**
 * Collect all modifier keyword texts from a declaration node's named `modifier` children.
 * Used by C# configs to detect compound visibilities (protected internal, private protected).
 */
export function collectModifierTexts(node: SyntaxNode): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'modifier') {
      result.add(child.text.trim());
    }
  }
  return result;
}
