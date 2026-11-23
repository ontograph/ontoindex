import PHP from 'tree-sitter-php';
import Parser from 'tree-sitter';

/** Ignore apparent tags inside strings and comments in tagless PHP. */
export const hasPhpOpenTag = (source: string): boolean => {
  if (!/<\?(?:php\b|=|\s)/i.test(source)) return false;
  if (/^\s*<\?(?:php\b|=|\s)/i.test(source)) return true;
  const parser = new Parser();
  parser.setLanguage(PHP.php_only as Parser.Language);
  return parser.parse(source).rootNode.descendantsOfType('php_tag').length > 0;
};

export const getPhpGrammar = (source?: string) =>
  source && hasPhpOpenTag(source) ? PHP.php : PHP.php_only;
