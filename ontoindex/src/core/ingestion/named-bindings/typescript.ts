import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

/** Explicit local public names, collected once from the module's top level. */
export function extractTsLocalExportBindings(root: SyntaxNode): NamedBinding[] {
  const bindings: NamedBinding[] = [];
  const add = (publicName: string, localName: string): void => {
    bindings.push({ local: `#local-export:${publicName}`, exported: localName });
  };
  for (const statement of root.namedChildren) {
    if (statement.type !== 'export_statement' || statement.childForFieldName('source')) continue;
    const clause = findChild(statement, 'export_clause');
    if (clause) {
      for (const specifier of clause.namedChildren) {
        if (specifier.type !== 'export_specifier') continue;
        const name = specifier.childForFieldName('name');
        if (name?.type !== 'identifier') continue;
        add(specifier.childForFieldName('alias')?.text ?? name.text, name.text);
      }
      continue;
    }
    const declaration = statement.childForFieldName('declaration');
    if (statement.children.some((child) => child.type === 'default')) {
      const value = statement.childForFieldName('value') ?? declaration;
      const name = value?.type === 'identifier' ? value : value?.childForFieldName('name');
      if (name?.type === 'identifier' || name?.type === 'type_identifier')
        add('default', name.text);
      continue;
    }
    if (!declaration) continue;
    if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
      for (const declarator of declaration.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        if (name?.type === 'identifier') add(name.text, name.text);
      }
    } else if (
      [
        'class_declaration',
        'abstract_class_declaration',
        'interface_declaration',
        'function_declaration',
        'generator_function_declaration',
        'function_signature',
        'type_alias_declaration',
        'enum_declaration',
      ].includes(declaration.type)
    ) {
      const name = declaration.childForFieldName('name');
      if (name) add(name.text, name.text);
    }
  }
  return bindings;
}

export function extractTsNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // import_statement > import_clause > named_imports > import_specifier*
  const importClause = findChild(importNode, 'import_clause');
  if (importClause) {
    const namespaceImport = findChild(importClause, 'namespace_import');
    if (namespaceImport) {
      const alias = findChild(namespaceImport, 'identifier');
      if (!alias) return undefined;
      return [{ local: alias.text, exported: '*', isModuleAlias: true }];
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
        bindings.push({ local: `#import:${identifiers[0]}`, exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // import { Foo as Bar } → exported='Foo', local='Bar'
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
        bindings.push({ local: `#import:${identifiers[1]}`, exported: identifiers[0] });
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
  if (exportClause && importNode.childForFieldName('source')) {
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
        bindings.push({ local: `#export:${identifiers[0]}`, exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // export { Repo as Repository } from './models' → name=Repo, alias=Repository
        // For re-exports, the first id is the source name, second is what's exported
        // When another file imports { Repository }, they get Repo from the source
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
        bindings.push({ local: `#export:${identifiers[1]}`, exported: identifiers[0] });
      }
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  return undefined;
}
