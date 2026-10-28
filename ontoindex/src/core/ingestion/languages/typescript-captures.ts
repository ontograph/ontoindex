import type { CaptureMatch } from 'ontoindex-shared';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import {
  emitTypeScriptCatchBindingCaptures,
  emitTypeScriptDeclarationCaptures,
  emitTypeScriptLexicalBindingCaptures,
  typeScriptObjectPatternDefaults,
  emitTypeScriptParameterBindingCaptures,
  emitTypeScriptVarBindingCapturesForNodes,
  typeScriptAnnotationType,
  typeScriptForInDeclaration,
  emitTypeScriptMemberCaptures,
  typeScriptConstructorDeclarationCaptures,
  typeScriptSignatureCaptures,
  validateTypeScriptType,
} from './typescript-declaration-captures.js';
import { emitTypeScriptExportCapturesForFile } from './typescript-export-captures.js';
import { emitTypeScriptImportCaptures } from './typescript-import-captures.js';
import {
  emitTypeScriptIdentifierReadCapture,
  emitTypeScriptIdentifierWriteCapture,
  emitTypeScriptMemberReadCaptures,
  emitTypeScriptReferenceCaptures,
  typeScriptSuperCallArguments,
  typeScriptThisMemberWriteValue,
  typeScriptSubscriptParts,
  unwrapTypeScriptParenthesized,
  isTypeScriptLiteralReceiver,
  unwrapTypeScriptReceiver,
} from './typescript-reference-captures.js';
import { emitTypeScriptLexicalScopeCaptures } from './typescript-scope-captures.js';

function unsupported(node?: SyntaxNode): never {
  throw new ScopeUnsupportedSyntaxError('TS/JS captures require the supported module subset', node);
}

function emptyDelimited(node: SyntaxNode, type: string, open: string, close: string): void {
  if (node.type !== type || !node.isNamed || node.hasError || node.isMissing) unsupported(node);
  const children = node.children.filter((child) => child.type !== 'comment');
  if (
    children.length !== 2 ||
    children[0]!.type !== open ||
    children[1]!.type !== close ||
    children.some((child) => child.isNamed || child.hasError || child.isMissing)
  )
    unsupported(node);
}

function appendWriteReferences(
  target: SyntaxNode,
  read: boolean,
  references: CaptureMatch[],
  localCaptures: CaptureMatch[],
): void {
  if (target.type === 'identifier') {
    if (read) references.push(...emitTypeScriptIdentifierReadCapture(target));
    references.push(...emitTypeScriptIdentifierWriteCapture(target));
    return;
  }
  const computed =
    target.type === 'subscript_expression' ? typeScriptSubscriptParts(target) : undefined;
  if (!computed && target.type !== 'member_expression') unsupported(target);
  // Writes require an ordinary, statically named receiver spine.
  let receiver = computed?.object ?? target;
  while (receiver.type === 'member_expression') {
    const parts = receiver.children.filter((child) => child.type !== 'comment');
    const object = receiver.childForFieldName('object');
    const property = receiver.childForFieldName('property');
    if (
      !receiver.isNamed ||
      receiver.hasError ||
      receiver.isMissing ||
      !object ||
      !property ||
      parts.length !== 3 ||
      parts[0]!.id !== object.id ||
      parts[1]!.type !== '.' ||
      parts[1]!.isNamed ||
      parts[2]!.id !== property.id ||
      parts.some((child) => child.hasError || child.isMissing)
    )
      unsupported(receiver);
    receiver = object;
  }
  if (receiver.type !== 'identifier') unsupported(receiver);
  if (computed) {
    // Computed element writes have no ReferenceSite form; retain operand evaluations and any element read.
    if (read) appendExpressionReferences(target, references, localCaptures);
    else {
      appendExpressionReferences(computed.object, references, localCaptures);
      appendExpressionReferences(computed.index, references, localCaptures);
    }
    return;
  }
  const [terminal, ...receiverReads] = emitTypeScriptMemberReadCaptures(target);
  if (!terminal?.['@reference.read']) unsupported(target);
  const { ['@reference.read']: selected, ...metadata } = terminal;
  if (read) references.push(terminal);
  references.push({ ...metadata, '@reference.write': { ...selected, name: '@reference.write' } });
  references.push(...receiverReads);
}

function appendExpressionReferences(
  node: SyntaxNode,
  references: CaptureMatch[],
  localCaptures: CaptureMatch[],
): void {
  const pending: SyntaxNode[] = [node];
  while (pending.length > 0) {
    const current = unwrapTypeScriptParenthesized(pending.pop()!);
    if (!current.isNamed || current.hasError || current.isMissing) unsupported(current);
    if (
      current.type === 'assignment_expression' ||
      current.type === 'augmented_assignment_expression'
    ) {
      let context = current;
      while (context.parent?.type === 'parenthesized_expression') context = context.parent;
      if (
        !['expression_statement', 'for_statement'].includes(context.parent?.type ?? '') &&
        !(current.type === 'assignment_expression' && context.parent?.type === 'arguments')
      )
        unsupported(current);
      const left = current.childForFieldName('left');
      const right = current.childForFieldName('right');
      const augmented = current.type === 'augmented_assignment_expression';
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        !left?.isNamed ||
        !right?.isNamed ||
        children.length !== 3 ||
        children[0]!.id !== left.id ||
        !(augmented
          ? ['+=', '-=', '*=', '??=', '||=', '&&='].includes(children[1]!.type)
          : children[1]!.type === '=') ||
        children[1]!.isNamed ||
        children[2]!.id !== right.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      appendWriteReferences(left, augmented, references, localCaptures);
      pending.push(right);
      continue;
    }
    if (current.type === 'update_expression') {
      let context = current;
      while (context.parent?.type === 'parenthesized_expression') context = context.parent;
      if (!['expression_statement', 'for_statement'].includes(context.parent?.type ?? ''))
        unsupported(current);
      const argument = current.childForFieldName('argument');
      const operator = current.childForFieldName('operator');
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        !argument?.isNamed ||
        !operator ||
        operator.isNamed ||
        !['++', '--'].includes(operator.type) ||
        children.length !== 2 ||
        !(
          (children[0]!.id === argument.id && children[1]!.id === operator.id) ||
          (children[0]!.id === operator.id && children[1]!.id === argument.id)
        ) ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      appendWriteReferences(argument, true, references, localCaptures);
      continue;
    }
    if (current.type === 'method_definition') {
      const name = current.childForFieldName('name');
      const parameters = current.childForFieldName('parameters');
      const body = current.childForFieldName('body');
      const returnType = current.childForFieldName('return_type');
      const children = current.children.filter((child) => child.type !== 'comment');
      const getter = children[0]?.type === 'get' && !children[0].isNamed;
      const offset = Number(getter);
      if (
        current.parent?.type !== 'object' ||
        !name ||
        name.type !== 'property_identifier' ||
        !name.isNamed ||
        !/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name.text) ||
        !parameters ||
        !parameters.isNamed ||
        !body ||
        body.type !== 'statement_block' ||
        !body.isNamed ||
        children.length !== offset + 3 + Number(!!returnType) ||
        children[offset]!.id !== name.id ||
        children[offset + 1]!.id !== parameters.id ||
        (returnType && children[offset + 2]!.id !== returnType.id) ||
        children[children.length - 1]!.id !== body.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      typeScriptSignatureCaptures(current);
      const bindings = emitTypeScriptParameterBindingCaptures(current);
      if (getter && bindings.length !== 0) unsupported(current);
      localCaptures.push(...bindings);
      appendFunctionBodyReferences(
        body,
        references,
        localCaptures,
        new Set(bindings.map((binding) => binding['@declaration.name']!.text)),
      );
      continue;
    }
    if (current.type === 'function_expression') {
      const name = current.childForFieldName('name');
      const parameters = current.childForFieldName('parameters');
      const body = current.childForFieldName('body');
      const returnType = current.childForFieldName('return_type');
      if (returnType) typeScriptAnnotationType(returnType);
      const children = current.children.filter((child) => child.type !== 'comment');
      const expected = [
        'function',
        ...(name ? [name] : []),
        parameters,
        ...(returnType ? [returnType] : []),
        body,
      ];
      if (
        !parameters?.isNamed ||
        body?.type !== 'statement_block' ||
        !body.isNamed ||
        children.length !== expected.length ||
        children.some((child, index) => {
          const part = expected[index];
          return (
            child.hasError ||
            child.isMissing ||
            (typeof part === 'string'
              ? child.isNamed || child.type !== part
              : child.id !== part?.id)
          );
        })
      )
        unsupported(current);
      localCaptures.push(
        ...emitTypeScriptDeclarationCaptures(current).map((match) => ({
          ...match,
          ...typeScriptSignatureCaptures(current),
        })),
      );
      typeScriptSignatureCaptures(current);
      const bindings = emitTypeScriptParameterBindingCaptures(current);
      localCaptures.push(...bindings);
      appendFunctionBodyReferences(
        body,
        references,
        localCaptures,
        new Set(bindings.map((binding) => binding['@declaration.name']!.text)),
      );
      continue;
    }
    if (current.type === 'arrow_function') {
      const parameter = current.childForFieldName('parameter');
      const parameters = current.childForFieldName('parameters');
      const body = current.childForFieldName('body');
      const returnType = current.childForFieldName('return_type');
      if (returnType) typeScriptAnnotationType(returnType);
      const parameterNode = parameter ?? parameters;
      const children = current.children.filter((child) => child.type !== 'comment');
      const parameterIndex = children[0]?.type === 'async' && !children[0].isNamed ? 1 : 0;
      const arrowIndex = parameterIndex + (returnType ? 2 : 1);
      if (
        !parameterNode ||
        (!!parameter && !!parameters) ||
        !body ||
        children.length !== arrowIndex + 2 ||
        children[parameterIndex]!.id !== parameterNode.id ||
        (returnType && children[parameterIndex + 1]!.id !== returnType.id) ||
        children[arrowIndex]!.type !== '=>' ||
        children[arrowIndex]!.isNamed ||
        children[arrowIndex + 1]!.id !== body.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      typeScriptSignatureCaptures(current);
      const bindings = emitTypeScriptParameterBindingCaptures(current);
      localCaptures.push(...bindings);
      if (body.type === 'statement_block') {
        appendFunctionBodyReferences(
          body,
          references,
          localCaptures,
          new Set(bindings.map((binding) => binding['@declaration.name']!.text)),
        );
      } else pending.push(body);
      continue;
    }
    if (['number', 'string', 'true', 'false', 'null'].includes(current.type)) continue;
    if (current.type === 'regex') {
      const pattern = current.childForFieldName('pattern');
      const flags = current.childForFieldName('flags');
      const children = current.children;
      if (
        !pattern ||
        pattern.type !== 'regex_pattern' ||
        !pattern.isNamed ||
        (flags && (flags.type !== 'regex_flags' || !flags.isNamed)) ||
        children.length !== 3 + Number(!!flags) ||
        children[0]!.type !== '/' ||
        children[0]!.isNamed ||
        children[1]!.id !== pattern.id ||
        children[2]!.type !== '/' ||
        children[2]!.isNamed ||
        (flags && children[3]!.id !== flags.id) ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      const seenFlags = new Set<string>();
      for (const flag of flags?.text ?? '') {
        if (
          !'dgimsuvy'.includes(flag) ||
          seenFlags.has(flag) ||
          (flag === 'u' && seenFlags.has('v')) ||
          (flag === 'v' && seenFlags.has('u'))
        )
          unsupported(current);
        seenFlags.add(flag);
      }
      // Validate grammar shape and flags without evaluating pattern semantics.
      continue;
    }
    if (current.type === 'template_string') {
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        children.length < 2 ||
        children[0]!.type !== '`' ||
        children[0]!.isNamed ||
        children[children.length - 1]!.type !== '`' ||
        children[children.length - 1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      const expressions: SyntaxNode[] = [];
      for (const child of children.slice(1, -1)) {
        if (!child.isNamed) unsupported(child);
        if (child.type === 'string_fragment' || child.type === 'escape_sequence') continue;
        if (child.type !== 'template_substitution') unsupported(child);
        const parts = child.children.filter((part) => part.type !== 'comment');
        if (
          parts.length !== 3 ||
          parts[0]!.type !== '${' ||
          parts[0]!.isNamed ||
          !parts[1]!.isNamed ||
          parts[2]!.type !== '}' ||
          parts[2]!.isNamed ||
          parts.some((part) => part.hasError || part.isMissing)
        )
          unsupported(child);
        expressions.push(parts[1]!);
      }
      for (let index = expressions.length - 1; index >= 0; index--)
        pending.push(expressions[index]!);
      continue;
    }
    if (current.type === 'ternary_expression') {
      const condition = current.childForFieldName('condition');
      const consequence = current.childForFieldName('consequence');
      const alternative = current.childForFieldName('alternative');
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        !condition ||
        !condition.isNamed ||
        !consequence ||
        !consequence.isNamed ||
        !alternative ||
        !alternative.isNamed ||
        children.length !== 5 ||
        children[0]!.id !== condition.id ||
        children[1]!.type !== '?' ||
        children[1]!.isNamed ||
        children[2]!.id !== consequence.id ||
        children[3]!.type !== ':' ||
        children[3]!.isNamed ||
        children[4]!.id !== alternative.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      pending.push(alternative, consequence, condition);
      continue;
    }
    if (current.type === 'binary_expression') {
      const left = current.childForFieldName('left');
      const operator = current.childForFieldName('operator');
      const right = current.childForFieldName('right');
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        !left ||
        !left.isNamed ||
        !operator ||
        operator.isNamed ||
        ![
          '<',
          '<=',
          '>',
          '>=',
          '==',
          '!=',
          '===',
          '!==',
          '-',
          '*',
          '/',
          '+',
          '%',
          '**',
          '<<',
          '>>',
          '>>>',
          '&',
          '|',
          '^',
          '&&',
          '||',
          '??',
          'in',
          'instanceof',
        ].includes(operator.type) ||
        !right ||
        !right.isNamed ||
        children.length !== 3 ||
        children[0]!.id !== left.id ||
        children[1]!.id !== operator.id ||
        children[2]!.id !== right.id ||
        children.some((child) => child.hasError || child.isMissing) ||
        // An unparenthesized unary left operand of `**` is a JavaScript early error.
        (operator.type === '**' && left.type === 'unary_expression')
      )
        unsupported(current);
      pending.push(right, left);
      continue;
    }
    if (current.type === 'non_null_expression') {
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        children.length !== 2 ||
        !children[0]!.isNamed ||
        children[1]!.type !== '!' ||
        children[1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      pending.push(children[0]!);
      continue;
    }
    if (current.type === 'await_expression') {
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        children.length !== 2 ||
        children[0]!.type !== 'await' ||
        children[0]!.isNamed ||
        !children[1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      pending.push(children[1]!);
      continue;
    }
    if (current.type === 'unary_expression') {
      const operator = current.childForFieldName('operator');
      const argument = current.childForFieldName('argument');
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        !operator ||
        !['-', '+', '~', '!', 'typeof', 'void'].includes(operator.type) ||
        operator.isNamed ||
        !argument ||
        !argument.isNamed ||
        children.length !== 2 ||
        children[0]!.id !== operator.id ||
        children[1]!.id !== argument.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      pending.push(argument);
      continue;
    }
    if (current.type === 'satisfies_expression') {
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        children.length !== 3 ||
        !children[0]!.isNamed ||
        children[1]!.type !== 'satisfies' ||
        children[1]!.isNamed ||
        !children[2]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      validateTypeScriptType(children[2]!);
      pending.push(children[0]!);
      continue;
    }
    if (current.type === 'as_expression') {
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        children.length !== 3 ||
        !children[0]!.isNamed ||
        children[1]!.type !== 'as' ||
        children[1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      if (children[2]!.isNamed) {
        validateTypeScriptType(children[2]!);
        pending.push(children[0]!);
        continue;
      }
      if (children[2]!.type !== 'const') unsupported(current);
      const operand = unwrapTypeScriptParenthesized(children[0]!);
      if (
        ![
          'number',
          'string',
          'true',
          'false',
          'null',
          'array',
          'object',
          'unary_expression',
        ].includes(operand.type)
      ) {
        unsupported(operand);
      }
      if (
        operand.type === 'unary_expression' &&
        (operand.childForFieldName('operator')?.type !== '-' ||
          operand.childForFieldName('argument')?.type !== 'number')
      ) {
        unsupported(operand);
      }
      pending.push(operand);
      continue;
    }
    if (
      current.type === 'identifier' ||
      current.type === 'undefined' ||
      current.type === 'shorthand_property_identifier'
    ) {
      references.push(...emitTypeScriptIdentifierReadCapture(current));
      continue;
    }
    if (current.type === 'subscript_expression') {
      const { object, index } = typeScriptSubscriptParts(current);
      const selected: Record<string, CaptureMatch[string]> = {};
      for (const [name, node] of [
        ['@reference.read.computed', current],
        ['@reference.object', object],
        ['@reference.index', index],
      ] as const) {
        selected[name] = {
          name,
          text: '',
          range: {
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column,
          },
        };
      }
      references.push(selected);
      pending.push(index, object);
      continue;
    }
    if (current.type === 'member_expression') {
      references.push(...emitTypeScriptMemberReadCaptures(current));
      let terminal = current;
      while (true) {
        terminal = unwrapTypeScriptReceiver(terminal);
        if (terminal.type !== 'member_expression') break;
        terminal = terminal.childForFieldName('object')!;
      }
      if (
        terminal.type === 'call_expression' ||
        isTypeScriptLiteralReceiver(terminal) ||
        terminal.type === 'subscript_expression' ||
        terminal.type === 'ternary_expression' ||
        (terminal.type === 'binary_expression' &&
          terminal.childForFieldName('operator')?.type === '??')
      ) {
        pending.push(terminal);
      }
      continue;
    }
    if (current.type === 'array') {
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        children.length < 2 ||
        children[0]!.type !== '[' ||
        children[0]!.isNamed ||
        children[children.length - 1]!.type !== ']' ||
        children[children.length - 1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      let expectingElement = true;
      const elements: SyntaxNode[] = [];
      for (const child of children.slice(1, -1)) {
        if (expectingElement) {
          if (!child.isNamed) unsupported(child);
          if (child.type === 'spread_element') {
            const parts = child.children.filter((part) => part.type !== 'comment');
            if (
              parts.length !== 2 ||
              parts[0]!.type !== '...' ||
              parts[0]!.isNamed ||
              !parts[1]!.isNamed ||
              parts.some((part) => part.hasError || part.isMissing)
            )
              unsupported(child);
            elements.push(parts[1]!);
          } else elements.push(child);
        } else if (child.isNamed || child.type !== ',') unsupported(child);
        expectingElement = !expectingElement;
      }
      for (let index = elements.length - 1; index >= 0; index--) pending.push(elements[index]!);
      continue;
    }
    if (current.type === 'object') {
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        children.length < 2 ||
        children[0]!.type !== '{' ||
        children[0]!.isNamed ||
        children[children.length - 1]!.type !== '}' ||
        children[children.length - 1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      let expectingPair = true;
      const values: SyntaxNode[] = [];
      for (const child of children.slice(1, -1)) {
        if (expectingPair) {
          if (child.type === 'spread_element' && child.isNamed) {
            const parts = child.children.filter((part) => part.type !== 'comment');
            if (
              parts.length !== 2 ||
              parts[0]!.type !== '...' ||
              parts[0]!.isNamed ||
              !parts[1]!.isNamed ||
              parts.some((part) => part.hasError || part.isMissing)
            )
              unsupported(child);
            values.push(parts[1]!);
            expectingPair = false;
            continue;
          }
          if (child.type === 'shorthand_property_identifier' && child.isNamed) {
            values.push(child);
            expectingPair = false;
            continue;
          }
          if (child.type === 'method_definition' && child.isNamed) {
            values.push(child);
            expectingPair = false;
            continue;
          }
          if (child.type !== 'pair' || !child.isNamed) unsupported(child);
          const key = child.childForFieldName('key');
          const value = child.childForFieldName('value');
          const pairChildren = child.children.filter((part) => part.type !== 'comment');
          if (
            !key ||
            !value ||
            !key.isNamed ||
            !value.isNamed ||
            pairChildren.length !== 3 ||
            pairChildren[0]!.id !== key.id ||
            pairChildren[1]!.type !== ':' ||
            pairChildren[1]!.isNamed ||
            pairChildren[2]!.id !== value.id ||
            pairChildren.some((part) => part.hasError || part.isMissing)
          )
            unsupported(child);
          if (key.type === 'computed_property_name') {
            const parts = key.children.filter((part) => part.type !== 'comment');
            if (
              parts.length !== 3 ||
              parts[0]!.type !== '[' ||
              parts[0]!.isNamed ||
              !parts[1]!.isNamed ||
              parts[2]!.type !== ']' ||
              parts[2]!.isNamed ||
              parts.some((part) => part.hasError || part.isMissing)
            )
              unsupported(key);
            values.push(parts[1]!);
          } else if (
            !['property_identifier', 'string', 'number'].includes(key.type) ||
            key.text.includes('\\') ||
            ['__proto__', "'__proto__'", '"__proto__"'].includes(key.text)
          ) {
            unsupported(child);
          }
          values.push(value);
        } else if (child.isNamed || child.type !== ',') unsupported(child);
        expectingPair = !expectingPair;
      }
      for (let index = values.length - 1; index >= 0; index--) pending.push(values[index]!);
      continue;
    }
    if (!['call_expression', 'new_expression'].includes(current.type)) unsupported(current);
    references.push(...emitTypeScriptReferenceCaptures(current));
    const args = current.childForFieldName('arguments');
    const children = args?.namedChildren ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      if (children[index]!.type === 'comment') continue;
      const child = children[index]!;
      if (child.type === 'spread_element') {
        const parts = child.children.filter((part) => part.type !== 'comment');
        const operand = parts[1];
        if (
          parts.length !== 2 ||
          parts[0]!.type !== '...' ||
          parts[0]!.isNamed ||
          !operand?.isNamed ||
          !['identifier', 'member_expression'].includes(operand.type) ||
          parts.some((part) => part.hasError || part.isMissing)
        )
          unsupported(child);
        pending.push(operand);
      } else pending.push(child);
    }
    // The selected call validates the full receiver chain; each inner call owns
    // its own receiver and arguments so none are visited twice.
    let receiver = current.childForFieldName('function');
    while (receiver) {
      receiver = unwrapTypeScriptReceiver(receiver);
      if (receiver.type !== 'member_expression') {
        if (
          receiver.type === 'call_expression' ||
          isTypeScriptLiteralReceiver(receiver) ||
          receiver.type === 'subscript_expression' ||
          receiver.type === 'arrow_function' ||
          receiver.type === 'ternary_expression' ||
          (receiver.type === 'binary_expression' &&
            receiver.childForFieldName('operator')?.type === '??')
        ) {
          pending.push(receiver);
        }
        break;
      }
      receiver = receiver.childForFieldName('object');
      if (
        receiver?.type === 'call_expression' ||
        (receiver && isTypeScriptLiteralReceiver(receiver)) ||
        receiver?.type === 'ternary_expression' ||
        (receiver?.type === 'binary_expression' &&
          receiver.childForFieldName('operator')?.type === '??')
      ) {
        pending.push(receiver);
        break;
      }
    }
  }
}

function appendExpressionStatementReferences(
  statement: SyntaxNode,
  references: CaptureMatch[],
  localCaptures: CaptureMatch[],
): void {
  if (
    statement.type !== 'expression_statement' ||
    !statement.isNamed ||
    statement.hasError ||
    statement.isMissing
  )
    unsupported(statement);
  const expressions = statement.namedChildren.filter((child) => child.type !== 'comment');
  const expression = expressions[0];
  const value = expression ? unwrapTypeScriptParenthesized(expression) : null;
  if (
    expressions.length !== 1 ||
    !expression ||
    !value ||
    ![
      'identifier',
      'member_expression',
      'subscript_expression',
      'call_expression',
      'new_expression',
      'array',
      'object',
      'as_expression',
      'satisfies_expression',
      'assignment_expression',
      'augmented_assignment_expression',
      'update_expression',
      'await_expression',
    ].includes(value.type) ||
    statement.children.some(
      (child) =>
        child.hasError ||
        child.isMissing ||
        (child.id !== expression.id &&
          child.type !== 'comment' &&
          (child.isNamed || child.type !== ';')),
    )
  )
    unsupported(value ?? expression ?? statement);
  appendExpressionReferences(value, references, localCaptures);
}

function appendReturnOrThrowReferences(
  statement: SyntaxNode,
  references: CaptureMatch[],
  localCaptures: CaptureMatch[],
): void {
  const isThrow = statement.type === 'throw_statement';
  if (
    (!isThrow && statement.type !== 'return_statement') ||
    !statement.isNamed ||
    statement.hasError ||
    statement.isMissing
  )
    unsupported(statement);
  const children = statement.children.filter((child) => child.type !== 'comment');
  if (
    children.length === 0 ||
    children[0]!.type !== (isThrow ? 'throw' : 'return') ||
    children[0]!.isNamed ||
    children.some((child) => child.hasError || child.isMissing)
  )
    unsupported(statement);
  const last = children[children.length - 1]!;
  const expressions = children.slice(1, last.type === ';' && !last.isNamed ? -1 : undefined);
  if (
    expressions.length > 1 ||
    (isThrow && expressions.length !== 1) ||
    expressions.some((child) => !child.isNamed)
  )
    unsupported(statement);
  const expression = expressions[0];
  if (!expression) return;
  if (
    isThrow &&
    /[\r\n\u2028\u2029]/u.test(
      statement.text.slice(
        children[0]!.endIndex - statement.startIndex,
        expression.startIndex - statement.startIndex,
      ),
    )
  )
    unsupported(statement);
  // TS grammars can attach a value across a comment containing a line terminator.
  // Refuse that ambiguous return boundary instead of silently capturing it as a value.
  if (
    statement.children.some(
      (child) =>
        child.type === 'comment' &&
        child.endIndex <= expression.startIndex &&
        /[\r\n\u2028\u2029]/u.test(child.text),
    )
  )
    unsupported(statement);
  appendExpressionReferences(expression, references, localCaptures);
}

function appendFunctionBodyReferences(
  body: SyntaxNode,
  references: CaptureMatch[],
  localCaptures: CaptureMatch[],
  parameterNames: ReadonlySet<string>,
  allowReturn = true,
  moduleVarDeclarations?: SyntaxNode[],
  constructorHasHeritage?: boolean,
): void {
  if (
    ![
      'statement_block',
      'try_statement',
      'for_statement',
      'for_in_statement',
      'while_statement',
      'do_statement',
      'switch_statement',
    ].includes(body.type)
  )
    unsupported(body);
  const declarations: SyntaxNode[] = [];
  const lexicalBindings = new Map<number, CaptureMatch[]>();
  const pending = [{ statement: body, lexicalNames: new Set(parameterNames), insideLoop: false }];
  while (pending.length > 0) {
    const { statement, lexicalNames, insideLoop } = pending.pop()!;
    if (!statement.isNamed) unsupported(statement);
    if (statement.type === 'statement_block') {
      if (statement.hasError || statement.isMissing) unsupported(statement);
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        children.length < 2 ||
        children[0]!.type !== '{' ||
        children[0]!.isNamed ||
        children[children.length - 1]!.type !== '}' ||
        children[children.length - 1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(statement);
      for (let index = children.length - 2; index >= 1; index--) {
        const child = children[index]!;
        pending.push({
          statement: child,
          lexicalNames: child.type === 'statement_block' ? new Set<string>() : lexicalNames,
          insideLoop,
        });
      }
      continue;
    }
    if (statement.type === 'switch_statement') {
      const value = statement.childForFieldName('value');
      const switchBody = statement.childForFieldName('body');
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        statement.hasError ||
        statement.isMissing ||
        !value ||
        value.type !== 'parenthesized_expression' ||
        !value.isNamed ||
        !switchBody ||
        switchBody.type !== 'switch_body' ||
        !switchBody.isNamed ||
        children.length !== 3 ||
        children[0]!.type !== 'switch' ||
        children[0]!.isNamed ||
        children[1]!.id !== value.id ||
        children[2]!.id !== switchBody.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(statement);
      const bodyChildren = switchBody.children.filter((child) => child.type !== 'comment');
      const clauses = bodyChildren.slice(1, -1);
      if (
        switchBody.hasError ||
        switchBody.isMissing ||
        bodyChildren.length < 2 ||
        bodyChildren[0]!.type !== '{' ||
        bodyChildren[0]!.isNamed ||
        bodyChildren[bodyChildren.length - 1]!.type !== '}' ||
        bodyChildren[bodyChildren.length - 1]!.isNamed ||
        bodyChildren.some((child) => child.hasError || child.isMissing) ||
        clauses.some(
          (child) => !child.isNamed || !['switch_case', 'switch_default'].includes(child.type),
        ) ||
        clauses.filter((child) => child.type === 'switch_default').length > 1
      )
        unsupported(switchBody);
      appendExpressionReferences(value, references, localCaptures);
      const switchNames = new Set<string>();
      for (let index = clauses.length - 1; index >= 0; index--)
        pending.push({ statement: clauses[index]!, lexicalNames: switchNames, insideLoop });
      continue;
    }
    if (statement.type === 'switch_case' || statement.type === 'switch_default') {
      const isCase = statement.type === 'switch_case';
      const value = statement.childForFieldName('value');
      const children = statement.children.filter((child) => child.type !== 'comment');
      const headerLength = isCase ? 3 : 2;
      if (
        statement.hasError ||
        statement.isMissing ||
        children.length < headerLength ||
        children[0]!.type !== (isCase ? 'case' : 'default') ||
        children[0]!.isNamed ||
        (isCase ? !value || !value.isNamed || children[1]!.id !== value.id : !!value) ||
        children[headerLength - 1]!.type !== ':' ||
        children[headerLength - 1]!.isNamed ||
        children.some((child) => child.hasError || child.isMissing) ||
        children.slice(headerLength).some((child) => !child.isNamed)
      )
        unsupported(statement);
      if (value) appendExpressionReferences(value, references, localCaptures);
      for (let index = children.length - 1; index >= headerLength; index--) {
        const child = children[index]!;
        pending.push({
          statement: child,
          lexicalNames: child.type === 'statement_block' ? new Set<string>() : lexicalNames,
          insideLoop,
        });
      }
      continue;
    }
    if (statement.type === 'try_statement') {
      const tryBody = statement.childForFieldName('body');
      const handler = statement.childForFieldName('handler');
      const finalizer = statement.childForFieldName('finalizer');
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        statement.hasError ||
        statement.isMissing ||
        (!handler && !finalizer) ||
        !tryBody ||
        tryBody.type !== 'statement_block' ||
        !tryBody.isNamed ||
        children.length !== 2 + Number(!!handler) + Number(!!finalizer) ||
        children[0]!.type !== 'try' ||
        children[0]!.isNamed ||
        children[1]!.id !== tryBody.id ||
        (handler && children[2]!.id !== handler.id) ||
        (finalizer && children[children.length - 1]!.id !== finalizer.id) ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(statement);
      let catchBody: SyntaxNode | undefined;
      if (handler) {
        const handlerBody = handler.childForFieldName('body');
        const parameter = handler.childForFieldName('parameter');
        const catchChildren = handler.children.filter((child) => child.type !== 'comment');
        if (
          handler.type !== 'catch_clause' ||
          !handler.isNamed ||
          handler.hasError ||
          handler.isMissing ||
          handler.childForFieldName('type') ||
          !handlerBody ||
          handlerBody.type !== 'statement_block' ||
          !handlerBody.isNamed ||
          catchChildren.length !== (parameter ? 5 : 2) ||
          catchChildren[0]!.type !== 'catch' ||
          catchChildren[0]!.isNamed ||
          catchChildren[catchChildren.length - 1]!.id !== handlerBody.id ||
          (parameter &&
            (parameter.type !== 'identifier' ||
              !parameter.isNamed ||
              catchChildren[1]!.type !== '(' ||
              catchChildren[1]!.isNamed ||
              catchChildren[2]!.id !== parameter.id ||
              catchChildren[3]!.type !== ')' ||
              catchChildren[3]!.isNamed)) ||
          catchChildren.some((child) => child.hasError || child.isMissing)
        )
          unsupported(handler);
        localCaptures.push(...emitTypeScriptCatchBindingCaptures(handler));
        catchBody = handlerBody;
      }
      if (finalizer) {
        const finallyBody = finalizer.childForFieldName('body');
        const finallyChildren = finalizer.children.filter((child) => child.type !== 'comment');
        if (
          finalizer.type !== 'finally_clause' ||
          !finalizer.isNamed ||
          !finallyBody ||
          finallyBody.type !== 'statement_block' ||
          !finallyBody.isNamed ||
          finallyChildren.length !== 2 ||
          finallyChildren[0]!.type !== 'finally' ||
          finallyChildren[0]!.isNamed ||
          finallyChildren[1]!.id !== finallyBody.id ||
          finallyChildren.some((child) => child.hasError || child.isMissing)
        )
          unsupported(finalizer);
        pending.push({ statement: finallyBody, lexicalNames: new Set<string>(), insideLoop });
      }
      if (catchBody)
        pending.push({ statement: catchBody, lexicalNames: new Set<string>(), insideLoop });
      pending.push({ statement: tryBody, lexicalNames: new Set<string>(), insideLoop });
      continue;
    }
    if (statement.type === 'if_statement') {
      const allowedBranchTypes = [
        'statement_block',
        'if_statement',
        'expression_statement',
        'return_statement',
        'throw_statement',
        'variable_declaration',
        'empty_statement',
        'try_statement',
        'for_in_statement',
        'continue_statement',
        'break_statement',
        'for_statement',
        'while_statement',
        'do_statement',
        'switch_statement',
      ];
      const condition = statement.childForFieldName('condition');
      const consequence = statement.childForFieldName('consequence');
      const alternative = statement.childForFieldName('alternative');
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        statement.hasError ||
        statement.isMissing ||
        !condition ||
        condition.type !== 'parenthesized_expression' ||
        !consequence ||
        !allowedBranchTypes.includes(consequence.type) ||
        !consequence.isNamed ||
        children.length !== (alternative ? 4 : 3) ||
        children[0]!.type !== 'if' ||
        children[0]!.isNamed ||
        children[1]!.id !== condition.id ||
        children[2]!.id !== consequence.id ||
        (alternative && children[3]!.id !== alternative.id) ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(statement);
      let alternativeBody: SyntaxNode | undefined;
      if (alternative) {
        const elseChildren = alternative.children.filter((child) => child.type !== 'comment');
        if (
          alternative.type !== 'else_clause' ||
          !alternative.isNamed ||
          elseChildren.length !== 2 ||
          elseChildren[0]!.type !== 'else' ||
          elseChildren[0]!.isNamed ||
          !allowedBranchTypes.includes(elseChildren[1]!.type) ||
          !elseChildren[1]!.isNamed ||
          elseChildren.some((child) => child.hasError || child.isMissing)
        )
          unsupported(alternative);
        alternativeBody = elseChildren[1]!;
      }
      appendExpressionReferences(condition, references, localCaptures);
      if (alternativeBody)
        pending.push({
          statement: alternativeBody,
          lexicalNames:
            alternativeBody.type === 'statement_block' ? new Set<string>() : lexicalNames,
          insideLoop,
        });
      pending.push({
        statement: consequence,
        lexicalNames: consequence.type === 'statement_block' ? new Set<string>() : lexicalNames,
        insideLoop,
      });
      continue;
    }
    if (statement.type === 'while_statement') {
      const condition = statement.childForFieldName('condition');
      const body = statement.childForFieldName('body');
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        statement.hasError ||
        statement.isMissing ||
        !condition ||
        condition.type !== 'parenthesized_expression' ||
        !condition.isNamed ||
        !body ||
        body.type !== 'statement_block' ||
        !body.isNamed ||
        children.length !== 3 ||
        children[0]!.type !== 'while' ||
        children[0]!.isNamed ||
        children[1]!.id !== condition.id ||
        children[2]!.id !== body.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(statement);
      appendExpressionReferences(condition, references, localCaptures);
      pending.push({ statement: body, lexicalNames: new Set<string>(), insideLoop: true });
      continue;
    }
    if (statement.type === 'do_statement') {
      const loopBody = statement.childForFieldName('body');
      const condition = statement.childForFieldName('condition');
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        !loopBody?.isNamed ||
        loopBody.type !== 'statement_block' ||
        !condition?.isNamed ||
        condition.type !== 'parenthesized_expression' ||
        (children.length !== 4 && children.length !== 5) ||
        children[0]!.type !== 'do' ||
        children[0]!.isNamed ||
        children[1]!.id !== loopBody.id ||
        children[2]!.type !== 'while' ||
        children[2]!.isNamed ||
        children[3]!.id !== condition.id ||
        (children[4] && (children[4].type !== ';' || children[4].isNamed)) ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(statement);
      appendExpressionReferences(condition, references, localCaptures);
      pending.push({ statement: loopBody, lexicalNames: new Set<string>(), insideLoop: true });
      continue;
    }
    if (statement.type === 'for_in_statement') {
      const loop = typeScriptForInDeclaration(statement);
      appendExpressionReferences(loop.right, references, localCaptures);
      declarations.push(statement);
      if (loop.kind.type !== 'var')
        lexicalBindings.set(statement.id, emitTypeScriptLexicalBindingCaptures(statement));
      pending.push({ statement: loop.body, lexicalNames: new Set<string>(), insideLoop: true });
      continue;
    }
    if (statement.type === 'for_statement') {
      const initializer = statement.childForFieldName('initializer');
      const condition = statement.childForFieldName('condition');
      const increment = statement.childForFieldName('increment');
      const loopBody = statement.childForFieldName('body');
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        !initializer?.isNamed ||
        !condition?.isNamed ||
        !loopBody?.isNamed ||
        ![
          'statement_block',
          'expression_statement',
          'empty_statement',
          'if_statement',
          'for_statement',
          'for_in_statement',
          'while_statement',
          'do_statement',
          'break_statement',
          'continue_statement',
        ].includes(loopBody.type)
      )
        unsupported(statement);
      const declaration = ['lexical_declaration', 'variable_declaration'].includes(
        initializer.type,
      );
      const expected = [
        'for',
        '(',
        initializer.id,
        ...(declaration || initializer.type === 'empty_statement' ? [] : [';']),
        condition.id,
        ...(condition.type === 'empty_statement' ? [] : [';']),
        ...(increment ? [increment.id] : []),
        ')',
        loopBody.id,
      ];
      if (
        statement.hasError ||
        statement.isMissing ||
        children.length !== expected.length ||
        children.some(
          (child, index) =>
            child.hasError ||
            child.isMissing ||
            (typeof expected[index] === 'number'
              ? child.id !== expected[index]
              : child.isNamed || child.type !== expected[index]),
        )
      )
        unsupported(statement);
      for (const empty of [initializer, condition].filter(
        (part) => part.type === 'empty_statement',
      )) {
        const tokens = empty.children.filter((child) => child.type !== 'comment');
        if (tokens.length !== 1 || tokens[0]!.type !== ';' || tokens[0]!.isNamed)
          unsupported(empty);
      }
      if (declaration) {
        if (
          initializer.namedChildren.some(
            (declarator) =>
              declarator.type !== 'comment' &&
              declarator.childForFieldName('name')?.type !== 'identifier',
          )
        )
          unsupported(initializer);
        validateDeclaration(initializer, references, [], localCaptures);
        declarations.push(initializer);
        if (initializer.type === 'lexical_declaration') {
          const bindings = emitTypeScriptLexicalBindingCaptures(initializer);
          if (
            new Set(bindings.map((binding) => binding['@declaration.name']!.text)).size !==
            bindings.length
          )
            unsupported(initializer);
          lexicalBindings.set(initializer.id, bindings);
        }
      } else if (initializer.type !== 'empty_statement')
        appendExpressionReferences(initializer, references, localCaptures);
      if (condition.type !== 'empty_statement')
        appendExpressionReferences(condition, references, localCaptures);
      if (increment) appendExpressionReferences(increment, references, localCaptures);
      pending.push({ statement: loopBody, lexicalNames: new Set<string>(), insideLoop: true });
      continue;
    }
    if (statement.type === 'continue_statement' || statement.type === 'break_statement') {
      const children = statement.children.filter((child) => child.type !== 'comment');
      if (
        !insideLoop ||
        statement.hasError ||
        statement.isMissing ||
        children.length < 1 ||
        children.length > 2 ||
        children[0]!.type !== (statement.type === 'break_statement' ? 'break' : 'continue') ||
        children[0]!.isNamed ||
        (children.length === 2 && (children[1]!.type !== ';' || children[1]!.isNamed)) ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(statement);
      continue;
    }
    if (statement.type === 'empty_statement') continue;
    if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
      validateDeclaration(statement, references, [], localCaptures);
      declarations.push(statement);
      if (statement.type === 'lexical_declaration') {
        const bindings = emitTypeScriptLexicalBindingCaptures(statement);
        for (const binding of bindings) {
          const name = binding['@declaration.name']!.text;
          if (lexicalNames.has(name)) unsupported();
          lexicalNames.add(name);
        }
        lexicalBindings.set(statement.id, bindings);
      }
      continue;
    }
    if (
      constructorHasHeritage !== undefined &&
      statement.parent?.id === body.id &&
      statement.type === 'expression_statement'
    ) {
      const expression = statement.namedChildren.find((child) => child.type !== 'comment');
      if (
        expression?.type === 'call_expression' &&
        expression.childForFieldName('function')?.type === 'super'
      ) {
        for (const argument of typeScriptSuperCallArguments(expression, constructorHasHeritage))
          appendExpressionReferences(argument, references, localCaptures);
        continue;
      }
      if (expression?.type === 'assignment_expression') {
        let receiver = expression.childForFieldName('left');
        while (receiver?.type === 'member_expression')
          receiver = receiver.childForFieldName('object');
        if (receiver?.type === 'this') {
          appendExpressionReferences(
            typeScriptThisMemberWriteValue(expression),
            references,
            localCaptures,
          );
          continue;
        }
      }
    }
    if (statement.type === 'return_statement' && !allowReturn) unsupported(statement);
    if (statement.type === 'return_statement' || statement.type === 'throw_statement')
      appendReturnOrThrowReferences(statement, references, localCaptures);
    else appendExpressionStatementReferences(statement, references, localCaptures);
  }
  const varDeclarations = declarations.filter((node) => !lexicalBindings.has(node.id));
  if (moduleVarDeclarations) moduleVarDeclarations.push(...varDeclarations);
  const varGroups = moduleVarDeclarations
    ? []
    : emitTypeScriptVarBindingCapturesForNodes(varDeclarations);
  let varIndex = 0;
  for (const declaration of declarations) {
    const bindings = lexicalBindings.get(declaration.id);
    if (moduleVarDeclarations && !bindings) continue;
    localCaptures.push(...(bindings ?? varGroups[varIndex++]!));
  }
}

function validateDeclaration(
  node: SyntaxNode,
  references: CaptureMatch[],
  parameterCaptures: CaptureMatch[],
  localCaptures: CaptureMatch[],
  ambient = false,
): void {
  if (['enum_declaration', 'interface_declaration', 'type_alias_declaration'].includes(node.type)) {
    if (ambient) unsupported(node);
    emitTypeScriptDeclarationCaptures(node);
    return;
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const tokens = node.type === 'variable_declaration' ? ['var'] : ['let', 'const'];
    const kinds = node.children.filter((child) => !child.isNamed && tokens.includes(child.type));
    if (kinds.length !== 1) unsupported(node);
    const declarators = node.namedChildren.filter((child) => child.type !== 'comment');
    if (
      declarators.length === 0 ||
      node.children.some(
        (child) =>
          child.hasError ||
          child.isMissing ||
          (child.type !== 'comment' &&
            child.type !== 'variable_declarator' &&
            (child.isNamed || ![...tokens, ',', ';'].includes(child.type))),
      )
    )
      unsupported(node);
    if (node.type === 'lexical_declaration') emitTypeScriptLexicalBindingCaptures(node);
    for (const declarator of declarators) {
      if (declarator.type !== 'variable_declarator') unsupported(declarator);
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      const annotation = declarator.childForFieldName('type');
      if (annotation) typeScriptAnnotationType(annotation);
      const initializer = value ? unwrapTypeScriptParenthesized(value) : null;
      const destructured = name?.type === 'array_pattern' || name?.type === 'object_pattern';
      if (
        !name ||
        (!destructured && name.type !== 'identifier') ||
        (destructured && (node.type !== 'lexical_declaration' || ambient || !!annotation)) ||
        (ambient && !!value) ||
        (!ambient && !value && kinds[0]!.type === 'const') ||
        declarator.children.some(
          (child) =>
            child.hasError ||
            child.isMissing ||
            (child.id !== name.id &&
              child.id !== value?.id &&
              child.id !== annotation?.id &&
              child.type !== 'comment' &&
              !(value && !child.isNamed && child.type === '=')),
        )
      )
        unsupported(initializer ?? declarator);
      if (initializer) appendExpressionReferences(initializer, references, localCaptures);
      if (name?.type === 'object_pattern')
        for (const fallback of typeScriptObjectPatternDefaults(name))
          appendExpressionReferences(fallback, references, localCaptures);
    }
    return;
  }
  const isClass = node.type === 'class_declaration';
  const isMethod = node.type === 'method_definition';
  if (
    !isClass &&
    !isMethod &&
    !['function_declaration', 'generator_function_declaration'].includes(node.type)
  )
    unsupported(node);
  const name = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  const parameters = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  const heritage = isClass
    ? node.namedChildren.find((child) => child.type === 'class_heritage')
    : undefined;
  if (heritage) {
    const parts = heritage.children.filter((child) => child.type !== 'comment');
    const clause = parts[0];
    const tokens =
      clause?.type === 'extends_clause'
        ? clause.children.filter((child) => child.type !== 'comment')
        : parts;
    if (
      !heritage.isNamed ||
      heritage.hasError ||
      heritage.isMissing ||
      (clause?.type === 'extends_clause' && parts.length !== 1) ||
      tokens.length !== 2 ||
      tokens[0]!.type !== 'extends' ||
      tokens[0]!.isNamed ||
      tokens[1]!.type !== 'identifier' ||
      !tokens[1]!.isNamed ||
      !/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(tokens[1]!.text) ||
      tokens.some((child) => child.hasError || child.isMissing)
    )
      unsupported(heritage);
  }
  if (returnType) typeScriptAnnotationType(returnType);
  if (!name || !body || (!isClass && !parameters)) unsupported(node);
  if (isClass && parameters) unsupported(node);
  const tokens = isClass
    ? ['class']
    : isMethod
      ? ['async']
      : node.type === 'generator_function_declaration'
        ? ['function', '*']
        : ['async', 'function'];
  if (
    node.children.some(
      (child) =>
        child.hasError ||
        child.isMissing ||
        (child.id !== name.id &&
          child.id !== body.id &&
          child.id !== parameters?.id &&
          child.id !== returnType?.id &&
          child.id !== heritage?.id &&
          child.type !== 'comment' &&
          (child.isNamed || !tokens.includes(child.type))),
    )
  )
    unsupported(node);
  const parameterNames = new Set<string>();
  if (parameters) {
    const bindings = emitTypeScriptParameterBindingCaptures(node);
    for (const binding of bindings) parameterNames.add(binding['@declaration.name']!.text);
    parameterCaptures.push(...bindings);
  }
  if (isClass) {
    if (body.type !== 'class_body' || body.hasError || body.isMissing) unsupported(body);
    const children = body.children.filter((child) => child.type !== 'comment');
    if (children[0]?.type !== '{' || children.at(-1)?.type !== '}') unsupported(body);
    const names = new Set<string>();
    for (const member of children.slice(1, -1)) {
      if (!member.isNamed && member.type === ';') continue;
      if (!member.isNamed || member.hasError || member.isMissing) unsupported(member);
      const memberName = member.childForFieldName('name');
      if (!memberName || memberName.type !== 'property_identifier' || names.has(memberName.text))
        unsupported(member);
      names.add(memberName.text);
      if (memberName.text === 'constructor') {
        localCaptures.push(...typeScriptConstructorDeclarationCaptures(member, node));
        const bindings = emitTypeScriptParameterBindingCaptures(member);
        parameterCaptures.push(...bindings);
        appendFunctionBodyReferences(
          member.childForFieldName('body')!,
          references,
          localCaptures,
          new Set(bindings.map((binding) => binding['@declaration.name']!.text)),
          true,
          undefined,
          !!heritage,
        );
        continue;
      }
      if (member.type === 'method_definition') {
        validateDeclaration(member, references, parameterCaptures, localCaptures);
      } else if (member.type === 'public_field_definition') {
        const annotation = member.childForFieldName('type');
        if (!annotation) unsupported(member);
        typeScriptAnnotationType(annotation);
        if (
          member.children.some(
            (child) =>
              child.id !== memberName.id && child.id !== annotation.id && child.type !== 'comment',
          )
        )
          unsupported(member);
      } else unsupported(member);
      localCaptures.push(...emitTypeScriptMemberCaptures(member, node));
    }
  } else appendFunctionBodyReferences(body, references, localCaptures, parameterNames);
}

function isLeadingShebang(root: SyntaxNode, statement: SyntaxNode): boolean {
  return (
    statement.type === 'hash_bang_line' &&
    statement.id === root.children[0]?.id &&
    statement.isNamed &&
    !statement.hasError &&
    !statement.isMissing
  );
}

/** Compose supported declarations, imports, exports, and module/function call trees. */
export function emitTypeScriptCaptures(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'program' || !root.isNamed || root.hasError || root.isMissing)
    unsupported(root);
  const declarations: SyntaxNode[] = [];
  const imports: SyntaxNode[] = [];
  const references: CaptureMatch[] = [];
  const parameterCaptures: CaptureMatch[] = [];
  const localCaptures: CaptureMatch[] = [];
  const moduleVarDeclarations: SyntaxNode[] = [];
  for (const statement of root.children) {
    if (
      statement.type === 'comment' ||
      statement.type === 'empty_statement' ||
      isLeadingShebang(root, statement)
    )
      continue;
    if (statement.type === 'expression_statement') {
      appendExpressionStatementReferences(statement, references, localCaptures);
      continue;
    }
    if (statement.type === 'throw_statement') {
      appendReturnOrThrowReferences(statement, references, localCaptures);
      continue;
    }
    if (
      [
        'try_statement',
        'statement_block',
        'for_statement',
        'for_in_statement',
        'while_statement',
        'do_statement',
        'switch_statement',
      ].includes(statement.type)
    ) {
      appendFunctionBodyReferences(
        statement,
        references,
        localCaptures,
        new Set(),
        false,
        moduleVarDeclarations,
      );
      continue;
    }
    if (statement.type === 'import_statement') {
      imports.push(statement);
      continue;
    }
    if (statement.type === 'ambient_declaration') {
      const children = statement.children.filter((child) => child.type !== 'comment');
      const declaration = children[1];
      if (
        !statement.isNamed ||
        statement.hasError ||
        statement.isMissing ||
        children.length !== 2 ||
        children[0]!.type !== 'declare' ||
        children[0]!.isNamed ||
        declaration?.type !== 'lexical_declaration' ||
        !declaration.isNamed
      )
        unsupported(statement);
      validateDeclaration(declaration, references, parameterCaptures, localCaptures, true);
      declarations.push(declaration);
      continue;
    }
    if (statement.type === 'export_statement') {
      const declaration = statement.childForFieldName('declaration');
      if (declaration) {
        validateDeclaration(declaration, references, parameterCaptures, localCaptures);
        declarations.push(declaration);
        if (declaration.type === 'variable_declaration') moduleVarDeclarations.push(declaration);
      } else {
        const children = statement.namedChildren.filter((child) => child.type !== 'comment');
        const source = statement.childForFieldName('source');
        if (
          children.length !== (source ? 2 : 1) ||
          children[0]!.type !== 'export_clause' ||
          (source && children[1]!.id !== source.id)
        )
          unsupported(statement);
      }
      continue;
    }
    validateDeclaration(statement, references, parameterCaptures, localCaptures);
    declarations.push(statement);
    if (statement.type === 'variable_declaration') moduleVarDeclarations.push(statement);
  }
  appendNewDefaultReferences(root, references, localCaptures);
  const varGroups = emitTypeScriptVarBindingCapturesForNodes(moduleVarDeclarations);
  const varBindings = new Map(
    moduleVarDeclarations.map((node, index) => [node.id, varGroups[index]!]),
  );
  const directDeclarationIds = new Set(declarations.map((node) => node.id));
  const nonVarDeclarationNames = new Set<string>();
  const captures = [
    ...emitTypeScriptLexicalScopeCaptures(root),
    ...declarations.flatMap((node) => {
      const group =
        node.type === 'lexical_declaration'
          ? emitTypeScriptLexicalBindingCaptures(node)
          : node.type === 'variable_declaration'
            ? varBindings.get(node.id)!
            : emitTypeScriptDeclarationCaptures(node).map((match) =>
                [
                  'class_declaration',
                  'enum_declaration',
                  'interface_declaration',
                  'type_alias_declaration',
                ].includes(node.type)
                  ? match
                  : { ...match, ...typeScriptSignatureCaptures(node) },
              );
      if (node.type !== 'variable_declaration') {
        for (const match of group) {
          const name = match['@declaration.name'];
          if (!name) continue;
          if (nonVarDeclarationNames.has(name.text)) unsupported();
          nonVarDeclarationNames.add(name.text);
        }
      }
      return group;
    }),
    ...moduleVarDeclarations.flatMap((node) =>
      directDeclarationIds.has(node.id) ? [] : varBindings.get(node.id)!,
    ),
    ...imports.flatMap(emitTypeScriptImportCaptures),
    ...emitTypeScriptExportCapturesForFile(root),
    ...references,
  ];
  const declarationNames = new Set<string>();
  const importNames = new Set<string>();
  for (const match of captures) {
    const declaration = match['@declaration.name'];
    if (declaration) {
      if (importNames.has(declaration.text)) unsupported();
      declarationNames.add(declaration.text);
    }
    const binding = match['@import.binding'];
    if (binding && match['@import.kind']?.text !== 'reexport') {
      if (importNames.has(binding.text) || declarationNames.has(binding.text)) unsupported();
      importNames.add(binding.text);
    }
  }
  const allCaptures = [...captures, ...parameterCaptures, ...localCaptures];
  return [
    ...allCaptures,
    ...allCaptures.flatMap((match) => {
      const annotation = match['@typescript.annotation'];
      const name = match['@declaration.name'];
      if (!annotation || !name) return [];
      // A callable const's declaration anchor spans the value, not the name. The type binding is
      // resolved at the name in the enclosing scope, so it must not carry the function anchor.
      if (match['@typescript.callable_binding']) {
        return [
          {
            '@type-binding.variable': { ...name, name: '@type-binding.variable', text: '' },
            '@type-binding.name': { ...name, name: '@type-binding.name' },
            '@type-binding.type': { ...annotation, name: '@type-binding.type' },
          },
        ];
      }
      // Topic partitioning uses the first key; retain declaration metadata for var hoisting.
      return [
        {
          '@type-binding.variable': { ...name, name: '@type-binding.variable', text: '' },
          '@type-binding.name': { ...name, name: '@type-binding.name' },
          '@type-binding.type': { ...annotation, name: '@type-binding.type' },
          ...match,
        },
      ];
    }),
  ];
}

/** Defaults execute in their function scope and share ordinary expression validation. */
function appendNewDefaultReferences(
  root: SyntaxNode,
  references: CaptureMatch[],
  localCaptures: CaptureMatch[],
): void {
  for (const binding of root.descendantsOfType(['required_parameter', 'assignment_pattern'])) {
    const owner = binding.parent?.parent;
    if (
      binding.parent?.type !== 'formal_parameters' ||
      !owner ||
      ![
        'function_declaration',
        'generator_function_declaration',
        'function_expression',
        'generator_function',
        'arrow_function',
        'method_definition',
      ].includes(owner.type)
    )
      continue;
    const value = binding.childForFieldName(
      binding.type === 'assignment_pattern' ? 'right' : 'value',
    );
    if (value?.type === 'new_expression')
      appendExpressionReferences(value, references, localCaptures);
  }
}
