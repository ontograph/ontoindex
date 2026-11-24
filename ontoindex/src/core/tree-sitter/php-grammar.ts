import PHP from 'tree-sitter-php';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';

export type PhpSourceKind = 'tagged' | 'tagless' | 'inline';

const stripInlinePrefix = (source: string): string => {
  let rest = source.replace(/^\uFEFF/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<!--')) {
      const commentEnd = rest.indexOf('-->');
      if (commentEnd >= 0) {
        rest = rest.slice(commentEnd + 3);
        continue;
      }
    }
    break;
  }
  return rest;
};

const HTML_TAGS = new Set([
  'a', 'article', 'aside', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'code',
  'col', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'img', 'input', 'label', 'li',
  'link', 'main', 'meta', 'nav', 'ol', 'option', 'p', 'pre', 'script', 'section', 'select',
  'small', 'source', 'span', 'style', 'svg', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th',
  'thead', 'title', 'tr', 'ul',
]);

const isInlineHtml = (source: string): boolean => {
  const prefix = stripInlinePrefix(source);
  if (/^<!doctype\s+html\b/i.test(prefix) || /^<\?xml\b/i.test(prefix)) return true;
  const openingTag = prefix.match(/^<([a-z][\w:-]*)(?=[\s/>])/i);
  if (!openingTag || !prefix.includes('>')) return false;
  const tagName = openingTag[1].toLowerCase();
  // Accept custom elements only when the fragment has the shape of markup,
  // while common HTML tags can be recognized from the opening element alone.
  return (
    HTML_TAGS.has(tagName) ||
    (tagName.includes('-') && prefix.toLowerCase().includes(`</${tagName}>`))
  );
};

const isInlineJavaScript = (source: string): boolean => {
  const parser = new Parser();
  parser.setLanguage(JavaScript as Parser.Language);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError || tree.rootNode.namedChildCount === 0) return false;

  const stack = [tree.rootNode];
  let hasJavaScriptOnlySignal = false;
  const browserGlobals = new Set(['window', 'document', 'globalThis']);
  const rootIdentifier = (node: Parser.SyntaxNode | null): string | undefined => {
    if (!node) return undefined;
    if (node.type === 'identifier') return node.text;
    if (node.type === 'member_expression') return rootIdentifier(node.childForFieldName('object'));
    return undefined;
  };
  while (stack.length > 0) {
    const node = stack.pop()!;
    // `$identifier` is valid JavaScript too, but strongly suggests tagless PHP
    // when PHP parsing already failed. Keep its syntax diagnostic, including
    // `$x = typeof window` and `$x = window.foo`.
    if (node.type === 'identifier' && /^\$[A-Za-z_]/.test(node.text)) return false;
    if (
      node.type === 'unary_expression' &&
      node.childForFieldName('operator')?.text === 'typeof' &&
      browserGlobals.has(rootIdentifier(node.childForFieldName('argument')) ?? '')
    ) {
      hasJavaScriptOnlySignal = true;
    }
    if (
      node.type === 'member_expression' &&
      browserGlobals.has(rootIdentifier(node.childForFieldName('object')) ?? '')
    ) {
      hasJavaScriptOnlySignal = true;
    }
    if (node.type === 'lexical_declaration' && /^(?:let|var)\b/.test(node.text)) {
      hasJavaScriptOnlySignal = true;
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return hasJavaScriptOnlySignal;
};

/** Ignore apparent tags inside strings and comments in tagless PHP. */
export const hasPhpOpenTag = (source: string): boolean => {
  if (!/<\?(?:php\b|=|\s)/i.test(source)) return false;
  if (/^\s*<\?(?:php\b|=|\s)/i.test(source)) return true;
  const parser = new Parser();
  parser.setLanguage(PHP.php_only as Parser.Language);
  return parser.parse(source).rootNode.descendantsOfType('php_tag').length > 0;
};

export const classifyPhpSource = (source: string): PhpSourceKind => {
  if (hasPhpOpenTag(source)) return 'tagged';

  const phpParser = new Parser();
  phpParser.setLanguage(PHP.php_only as Parser.Language);
  if (!phpParser.parse(source).rootNode.hasError) return 'tagless';

  if (isInlineHtml(source) || isInlineJavaScript(source)) return 'inline';
  return 'tagless';
};

export const getPhpGrammar = (source?: string) => {
  if (!source) return PHP.php_only;
  return classifyPhpSource(source) === 'tagless' ? PHP.php_only : PHP.php;
};
