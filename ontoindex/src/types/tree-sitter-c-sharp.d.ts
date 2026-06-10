declare module 'tree-sitter-c-sharp' {
  import type Parser from 'tree-sitter';

  const language: Parameters<typeof Parser.prototype.setLanguage>[0];
  export default language;
}
