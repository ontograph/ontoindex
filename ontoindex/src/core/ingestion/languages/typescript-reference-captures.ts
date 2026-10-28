import type { Capture, CaptureMatch, ReceiverStep } from 'ontoindex-shared';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import {
  typeScriptTypeArguments,
  validateTypeScriptType,
} from './typescript-declaration-captures.js';

const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

function unsupported(node?: SyntaxNode): never {
  throw new ScopeUnsupportedSyntaxError(
    'TS/JS reference captures require an ordinary supported call with fixed arity',
    node,
  );
}

function rangeOf(node: SyntaxNode): Capture['range'] {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function capture(name: string, node: SyntaxNode, text: string): Capture {
  return { name, text, range: rangeOf(node) };
}

/** Return the expression inside validated transparent parentheses. */
export function unwrapTypeScriptParenthesized(node: SyntaxNode): SyntaxNode {
  while (node.type === 'parenthesized_expression') {
    if (!node.isNamed || node.hasError || node.isMissing) unsupported(node);
    const children = node.children.filter((child) => child.type !== 'comment');
    if (
      children.length !== 3 ||
      children[0]!.type !== '(' ||
      children[0]!.isNamed ||
      !children[1]!.isNamed ||
      children[2]!.type !== ')' ||
      children[2]!.isNamed ||
      children.some((child) => child.hasError || child.isMissing)
    )
      unsupported(node);
    node = children[1]!;
  }
  return node;
}

/** Literal receivers (`[a].map`, `/x/.test`, `"s".length`) carry no named type, so they resolve as unknown receivers. */
export function isTypeScriptLiteralReceiver(node: SyntaxNode): boolean {
  return ['array', 'regex', 'string', 'template_string', 'number'].includes(node.type);
}

/** Validated assertions preserve the identity of a receiver, including dynamic operands. */
export function unwrapTypeScriptReceiver(node: SyntaxNode): SyntaxNode {
  while (true) {
    node = unwrapTypeScriptParenthesized(node);
    if (node.type === 'as_expression') {
      const children = node.children.filter((child) => child.type !== 'comment');
      if (
        !node.isNamed ||
        node.hasError ||
        node.isMissing ||
        children.length !== 3 ||
        !children[0]!.isNamed ||
        children[1]!.type !== 'as' ||
        children[1]!.isNamed ||
        !children[2]!.isNamed ||
        !['type_identifier', 'predefined_type', 'object_type'].includes(children[2]!.type) ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(node);
      validateTypeScriptType(children[2]!);
      node = children[0]!;
      continue;
    }
    if (node.type !== 'non_null_expression') return node;
    const children = node.children.filter((child) => child.type !== 'comment');
    if (
      !node.isNamed ||
      node.hasError ||
      node.isMissing ||
      children.length !== 2 ||
      !children[0]!.isNamed ||
      children[1]!.type !== '!' ||
      children[1]!.isNamed ||
      children.some((child) => child.hasError || child.isMissing)
    )
      unsupported(node);
    node = children[0]!;
  }
}

export function typeScriptSubscriptParts(node: SyntaxNode): {
  object: SyntaxNode;
  index: SyntaxNode;
} {
  const object = node.childForFieldName('object');
  const index = node.childForFieldName('index');
  const children = node.children.filter((child) => child.type !== 'comment');
  if (
    node.type !== 'subscript_expression' ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    !object?.isNamed ||
    !index?.isNamed ||
    children.length !== 4 ||
    children[0]!.id !== object.id ||
    children[1]!.type !== '[' ||
    children[1]!.isNamed ||
    children[2]!.id !== index.id ||
    children[3]!.type !== ']' ||
    children[3]!.isNamed ||
    children.some((child) => child.hasError || child.isMissing)
  )
    unsupported(node);
  return { object, index };
}

function memberParts(
  node: SyntaxNode,
  allowOptional = false,
): { object: SyntaxNode; property: SyntaxNode } {
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  const children = node.children.filter((child) => child.type !== 'comment');
  const separator = children[1];
  if (
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    !object ||
    !object.isNamed ||
    object.hasError ||
    object.isMissing ||
    !property ||
    property.type !== 'property_identifier' ||
    !property.isNamed ||
    property.hasError ||
    property.isMissing ||
    !IDENTIFIER.test(property.text) ||
    children.length !== 3 ||
    children[0]!.id !== object.id ||
    children[2]!.id !== property.id ||
    !separator ||
    !(
      (!separator.isNamed && separator.type === '.') ||
      (allowOptional &&
        separator.isNamed &&
        separator.type === 'optional_chain' &&
        separator.text === '?.')
    ) ||
    children.some((child) => child.hasError || child.isMissing)
  )
    unsupported(node);
  return { object, property };
}

function callParts(node: SyntaxNode): {
  callee: SyntaxNode;
  args: SyntaxNode | null;
  arity: number;
} {
  const constructor = node.type === 'new_expression';
  const callee = node.childForFieldName(constructor ? 'constructor' : 'function');
  const args = node.childForFieldName('arguments');
  const typeArguments = node.childForFieldName('type_arguments');
  const children = node.children.filter((child) => child.type !== 'comment');
  const optionalCall =
    !constructor &&
    callee?.type === 'member_expression' &&
    children.length === 3 &&
    children[0]!.id === callee.id &&
    ((children[1]!.type === '?.' && !children[1]!.isNamed) ||
      (children[1]!.type === 'optional_chain' &&
        children[1]!.isNamed &&
        children[1]!.text === '?.')) &&
    children[2]!.id === args?.id;
  if (typeArguments) {
    if (!constructor) unsupported(typeArguments);
    typeScriptTypeArguments(typeArguments);
  }
  if (
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    !callee ||
    !callee.isNamed ||
    callee.hasError ||
    callee.isMissing ||
    (!args && !constructor) ||
    (args && (args.type !== 'arguments' || !args.isNamed || args.hasError || args.isMissing)) ||
    node.children.some(
      (child) =>
        child.isMissing ||
        child.hasError ||
        (child.id !== callee.id &&
          child.id !== args?.id &&
          child.id !== typeArguments?.id &&
          child.type !== 'comment' &&
          !(optionalCall && child.id === children[1]!.id) &&
          !(constructor && !child.isNamed && child.type === 'new')),
    )
  )
    unsupported(node);
  let arity = 0;
  if (args) {
    let expectingArgument = true;
    const children = args.children.filter((child) => child.type !== 'comment');
    if (children[0]?.type !== '(' || children.at(-1)?.type !== ')') unsupported(args);
    for (const child of children.slice(1, -1)) {
      if (child.isMissing || child.hasError) unsupported(child);
      if (expectingArgument) {
        if (!child.isNamed) unsupported(child);
        if (child.type === 'spread_element') {
          const parts = child.children.filter((part) => part.type !== 'comment');
          if (
            parts.length !== 2 ||
            parts[0]!.type !== '...' ||
            parts[0]!.isNamed ||
            !parts[1]!.isNamed ||
            !['identifier', 'member_expression'].includes(parts[1]!.type) ||
            parts.some((part) => part.hasError || part.isMissing)
          )
            unsupported(child);
        }
        // Match legacy countCallArguments: a spread is one syntactic argument.
        arity++;
      } else if (child.type !== ',' || child.isNamed) unsupported(child);
      expectingArgument = !expectingArgument;
    }
  }
  return { callee, args, arity };
}

function receiverCapture(
  node: SyntaxNode,
  allowOptional = false,
): { receiver: Capture; read: CaptureMatch[] } {
  let current = node;
  const steps: ReceiverStep[] = [];
  let containsCall = false;
  while (true) {
    current = unwrapTypeScriptReceiver(current);
    if (current.type === 'identifier') break;
    if (steps.length === 64) unsupported(current);
    if (current.type === 'member_expression') {
      const { object, property } = memberParts(current, allowOptional);
      steps.push({ kind: 'member', name: property.text, range: rangeOf(property) });
      current = object;
    } else if (current.type === 'call_expression') {
      const { callee, arity } = callParts(current);
      if (callee.type !== 'identifier' && callee.type !== 'member_expression') unsupported(callee);
      steps.push({ kind: 'call', arity, range: rangeOf(current) });
      containsCall = true;
      allowOptional = true;
      current = callee;
    } else if (current.type === 'subscript_expression') {
      typeScriptSubscriptParts(current);
      return {
        receiver: { ...capture('@reference.receiver', node, ''), receiver: { kind: 'unknown' } },
        read: [],
      };
    } else if (isTypeScriptLiteralReceiver(current)) {
      return {
        receiver: { ...capture('@reference.receiver', node, ''), receiver: { kind: 'unknown' } },
        read: [],
      };
    } else if (current.type === 'ternary_expression') {
      const condition = current.childForFieldName('condition');
      const consequence = current.childForFieldName('consequence');
      const alternative = current.childForFieldName('alternative');
      const children = current.children.filter((child) => child.type !== 'comment');
      if (
        !current.isNamed ||
        current.hasError ||
        current.isMissing ||
        !condition?.isNamed ||
        !consequence?.isNamed ||
        !alternative?.isNamed ||
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
      return {
        receiver: { ...capture('@reference.receiver', node, ''), receiver: { kind: 'unknown' } },
        read: [],
      };
    } else if (
      current.type === 'binary_expression' &&
      current.childForFieldName('operator')?.type === '??'
    ) {
      const children = current.children.filter((child) => child.type !== 'comment');
      const left = current.childForFieldName('left');
      const operator = current.childForFieldName('operator');
      const right = current.childForFieldName('right');
      if (
        !current.isNamed ||
        current.hasError ||
        current.isMissing ||
        !left?.isNamed ||
        !operator ||
        operator.isNamed ||
        !right?.isNamed ||
        children.length !== 3 ||
        children[0]!.id !== left.id ||
        children[1]!.id !== operator.id ||
        children[2]!.id !== right.id ||
        children.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      return {
        receiver: { ...capture('@reference.receiver', node, ''), receiver: { kind: 'unknown' } },
        read: [],
      };
    } else unsupported(current);
  }
  if (!current.isNamed || current.hasError || current.isMissing || !IDENTIFIER.test(current.text))
    unsupported(current);
  return {
    receiver:
      steps.length === 0
        ? capture('@reference.receiver', node, current.text)
        : {
            ...capture('@reference.receiver', node, ''),
            receiver: {
              kind: 'chain',
              root: { name: current.text, range: rangeOf(current) },
              steps: steps.reverse(),
            },
          },
    read: containsCall ? [] : emitTypeScriptIdentifierReadCapture(current),
  };
}

/** Detach one selected identifier read without retaining borrowed syntax nodes. */
export function emitTypeScriptIdentifierReadCapture(node: SyntaxNode): CaptureMatch[] {
  if (
    (node.type !== 'identifier' &&
      node.type !== 'shorthand_property_identifier' &&
      (node.type !== 'undefined' || node.text !== 'undefined')) ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    !IDENTIFIER.test(node.text)
  )
    unsupported(node);
  return [
    {
      '@reference.read': capture('@reference.read', node, ''),
      '@reference.name': capture('@reference.name', node, node.text),
    },
  ];
}

/** Detach one selected identifier write without retaining borrowed syntax nodes. */
export function emitTypeScriptIdentifierWriteCapture(node: SyntaxNode): CaptureMatch[] {
  if (
    node.type !== 'identifier' ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    !IDENTIFIER.test(node.text)
  )
    unsupported(node);
  return [
    {
      '@reference.write': capture('@reference.write', node, ''),
      '@reference.name': capture('@reference.name', node, node.text),
    },
  ];
}

/** Detach each property read in a supported member spine and its root identifier read. */
export function emitTypeScriptMemberReadCaptures(node: SyntaxNode): CaptureMatch[] {
  if (node.type !== 'member_expression') unsupported(node);
  let current = node;
  const members: { node: SyntaxNode; object: SyntaxNode; property: SyntaxNode }[] = [];
  while (true) {
    current = unwrapTypeScriptReceiver(current);
    if (current.type !== 'member_expression') break;
    // Bound total accesses: detached receiver prefixes require quadratic output.
    if (members.length === 64) unsupported(current);
    const { object, property } = memberParts(current, true);
    members.push({ node: current, object, property });
    current = object;
  }
  const terminalCall = current.type === 'call_expression';
  const terminalDynamic =
    isTypeScriptLiteralReceiver(current) ||
    current.type === 'subscript_expression' ||
    current.type === 'ternary_expression' ||
    (current.type === 'binary_expression' && current.childForFieldName('operator')?.type === '??');
  if (terminalCall || terminalDynamic) receiverCapture(current, true);
  const directUndefined =
    members.length === 1 && current.type === 'undefined' && current.text === 'undefined';
  if (
    (current.type !== 'identifier' && !directUndefined && !terminalCall && !terminalDynamic) ||
    !current.isNamed ||
    current.hasError ||
    current.isMissing ||
    (!terminalCall && !terminalDynamic && !IDENTIFIER.test(current.text))
  )
    unsupported(current);
  return [
    ...members.map(({ node: member, object, property }) => ({
      '@reference.read': capture('@reference.read', member, ''),
      '@reference.name': capture('@reference.name', property, property.text),
      '@reference.receiver': directUndefined
        ? capture('@reference.receiver', object, object.text)
        : receiverCapture(object, true).receiver,
    })),
    ...(terminalCall || terminalDynamic ? [] : emitTypeScriptIdentifierReadCapture(current)),
  ];
}

/** Collect this supported call subset only; these captures are not a complete provider. */
export function emitTypeScriptReferenceCapturesForFile(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'program' || !root.isNamed || root.hasError || root.isMissing)
    unsupported(root);
  const matches: CaptureMatch[] = [];
  const cursor = root.walk();
  let typeQueries = 0;
  while (true) {
    if (cursor.nodeIsMissing || cursor.nodeType === 'ERROR') unsupported(cursor.currentNode);
    if (cursor.nodeType === 'type_query') typeQueries++;
    if (cursor.nodeType === 'call_expression' || cursor.nodeType === 'new_expression') {
      if (typeQueries > 0) unsupported(cursor.currentNode);
      matches.push(...emitTypeScriptReferenceCaptures(cursor.currentNode));
    }
    if (cursor.gotoFirstChild()) continue;
    while (true) {
      if (cursor.nodeType === 'type_query') typeQueries--;
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) return matches;
    }
  }
}

/** Detach one selected ordinary free/member/constructor call without retaining borrowed syntax nodes. */
export function emitTypeScriptReferenceCaptures(node: SyntaxNode): CaptureMatch[] {
  if (
    !['call_expression', 'new_expression'].includes(node.type) ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing
  )
    unsupported(node);
  const constructor = node.type === 'new_expression';
  const { callee, args, arity } = callParts(node);
  // An arrow invocation has no named target; traversal owns its body and arguments.
  if (
    !constructor &&
    callee.type === 'parenthesized_expression' &&
    unwrapTypeScriptParenthesized(callee).type === 'arrow_function'
  )
    return [];
  let name = callee;
  let receiver: ReturnType<typeof receiverCapture> | null = null;
  let receiverReads: CaptureMatch[] = [];
  if (!constructor && callee.type === 'member_expression') {
    const { object, property } = memberParts(callee, true);
    receiver = receiverCapture(object, true);
    const unwrappedObject = unwrapTypeScriptReceiver(object);
    receiverReads =
      unwrappedObject.type === 'member_expression'
        ? emitTypeScriptMemberReadCaptures(unwrappedObject)
        : receiver.read;
    name = property;
  } else if (callee.type !== 'identifier' || !IDENTIFIER.test(callee.text)) unsupported(callee);
  const anchor = constructor
    ? '@reference.call.constructor'
    : receiver
      ? '@reference.call.member'
      : '@reference.call.free';
  return [
    {
      [anchor]: capture(anchor, node, ''),
      '@reference.name': capture('@reference.name', name, name.text),
      ...(receiver ? { '@reference.receiver': receiver.receiver } : {}),
      // A constructor without parentheses anchors its zero arity at the constructor name.
      '@reference.arity': capture('@reference.arity', args ?? callee, String(arity)),
    },
    ...receiverReads,
  ];
}

function requireDirectConstructorStatement(node: SyntaxNode): void {
  const statement = node.parent;
  const body = statement?.parent;
  const constructor = body?.parent;
  const name = constructor?.childForFieldName('name');
  if (
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    statement?.type !== 'expression_statement' ||
    statement.hasError ||
    statement.isMissing ||
    statement.namedChildren.filter((child) => child.type !== 'comment').length !== 1 ||
    body?.type !== 'statement_block' ||
    constructor?.type !== 'method_definition' ||
    constructor.childForFieldName('body')?.id !== body.id ||
    name?.type !== 'property_identifier' ||
    name.text !== 'constructor' ||
    constructor.parent?.type !== 'class_body'
  )
    unsupported(node);
}

/** Constructor super calls have no legacy call edge; the caller evaluates each returned argument once. */
export function typeScriptSuperCallArguments(
  node: SyntaxNode,
  hasHeritage: boolean,
): readonly SyntaxNode[] {
  requireDirectConstructorStatement(node);
  if (!hasHeritage || node.type !== 'call_expression') unsupported(node);
  const { callee, args } = callParts(node);
  if (callee.type !== 'super' || callee.text !== 'super' || !args) unsupported(node);
  const operands = args.namedChildren.filter((child) => child.type !== 'comment');
  // Keep spread super calls refused until their evaluation is supported explicitly.
  for (const operand of operands) if (operand.type === 'spread_element') unsupported(operand);
  return operands;
}

/** Legacy assignment records own this-field writes; scope traversal evaluates only their RHS. */
export function typeScriptThisMemberWriteValue(node: SyntaxNode): SyntaxNode {
  requireDirectConstructorStatement(node);
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const children = node.children.filter((child) => child.type !== 'comment');
  if (
    node.type !== 'assignment_expression' ||
    !left?.isNamed ||
    !right?.isNamed ||
    children.length !== 3 ||
    children[0]!.id !== left.id ||
    children[1]!.type !== '=' ||
    children[1]!.isNamed ||
    children[2]!.id !== right.id ||
    children.some((child) => child.hasError || child.isMissing)
  )
    unsupported(node);
  let receiver = left;
  let depth = 0;
  while (receiver.type === 'member_expression') {
    if (++depth > 64) unsupported(receiver);
    receiver = memberParts(receiver).object;
  }
  if (
    depth === 0 ||
    receiver.type !== 'this' ||
    receiver.text !== 'this' ||
    !receiver.isNamed ||
    receiver.hasError ||
    receiver.isMissing
  )
    unsupported(receiver);
  return right;
}
