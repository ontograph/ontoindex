import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractTsNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // import_statement > import_clause > named_imports > import_specifier*
  const importClause = findChild(importNode, 'import_clause');
  if (importClause) {
    const namespaceImport = findChild(importClause, 'namespace_import');
    if (namespaceImport) {
      const alias = findChild(namespaceImport, 'identifier');
      if (!alias) return undefined;
      const bindings: NamedBinding[] = [{ local: alias.text, exported: '*', isModuleAlias: true }];
      // Retain explicit local namespace exports separately from private imports.
      for (const statement of importNode.parent?.namedChildren ?? []) {
        if (statement.type !== 'export_statement' || statement.childForFieldName('source'))
          continue;
        for (const specifier of findChild(statement, 'export_clause')?.namedChildren ?? []) {
          if (specifier.childForFieldName('name')?.text !== alias.text) continue;
          const exported = specifier.childForFieldName('alias')?.text ?? alias.text;
          bindings.push({ local: `#export:${exported}`, exported: '*', isModuleAlias: true });
        }
      }
      return bindings;
    }
    const namedImports = findChild(importClause, 'named_imports');
    if (!namedImports) return undefined; // default import or side-effect

    const bindings: NamedBinding[] = [];
    for (let i = 0; i < namedImports.namedChildCount; i++) {
      const specifier = namedImports.namedChild(i);
      if (specifier?.type !== 'import_specifier') continue;

      const identifiers: string[] = [];
      for (let j = 0; j < specifier.namedChildCount; j++) {
        const child = specifier.namedChild(j);
        if (child?.type === 'identifier') identifiers.push(child.text);
      }

      if (identifiers.length === 1) {
        bindings.push({ local: identifiers[0], exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // import { Foo as Bar } → exported='Foo', local='Bar'
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
      }
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  if (importNode.type === 'export_statement' && importNode.childForFieldName('source')) {
    const namespace = findChild(importNode, 'namespace_export');
    const alias = namespace && findChild(namespace, 'identifier');
    if (alias) return [{ local: `#export:${alias.text}`, exported: '*', isModuleAlias: true }];
    if (!findChild(importNode, 'export_clause')) {
      // A source-qualified key preserves every export-star target in the existing map.
      return [{ local: `*:${importNode.childForFieldName('source')!.text}`, exported: '*' }];
    }
  }

  // Re-export: export { X } from './y' → export_statement > export_clause > export_specifier
  const exportClause = findChild(importNode, 'export_clause');
  if (exportClause) {
    const bindings: NamedBinding[] = [];
    for (let i = 0; i < exportClause.namedChildCount; i++) {
      const specifier = exportClause.namedChild(i);
      if (specifier?.type !== 'export_specifier') continue;

      const identifiers: string[] = [];
      for (let j = 0; j < specifier.namedChildCount; j++) {
        const child = specifier.namedChild(j);
        if (child?.type === 'identifier') identifiers.push(child.text);
      }

      if (identifiers.length === 1) {
        // export { User } from './base' → re-exports User as User
        bindings.push({ local: identifiers[0], exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // export { Repo as Repository } from './models' → name=Repo, alias=Repository
        // For re-exports, the first id is the source name, second is what's exported
        // When another file imports { Repository }, they get Repo from the source
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
      }
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  return undefined;
}
