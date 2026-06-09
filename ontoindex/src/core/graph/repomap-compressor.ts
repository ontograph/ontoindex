/**
 * Signature-based code compression for the repomap tool.
 *
 * This reduces the token count of the codebase summary by replacing
 * implementation bodies with ellipsis, preserving only the signatures.
 */

/**
 * Compress a symbol's source code by extracting its signature.
 *
 * @param label - The node label (Function, Class, Method, etc.)
 * @param code - The full source code of the symbol
 * @returns Compressed signature with ellipsis body
 */
export function compressSymbol(label: string, code: string): string {
  if (!code) return '';

  // Currently TypeScript-focused as per T-1.1.03
  // Simple heuristic: take the first non-empty line or everything up to the first '{'
  const lines = code.split('\n');
  let firstLine = '';
  for (const line of lines) {
    if (line.trim()) {
      firstLine = line;
      break;
    }
  }

  if (!firstLine) return '';

  // If the first line already contains the whole symbol (e.g. one-liner), return it
  if (firstLine.includes('{') && firstLine.includes('}') && firstLine.trim().endsWith('}')) {
    return firstLine;
  }

  // If it's a class/function/method, it likely has a body starting with {
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx !== -1) {
    return firstLine.substring(0, braceIdx + 1) + ' ... }';
  }

  // If no brace on first line, check if it's a multi-line signature
  // For simplicity in this first version, we'll just append { ... } to the first line
  // if it looks like a declaration.
  if (
    firstLine.includes('function') ||
    firstLine.includes('class') ||
    firstLine.includes('interface') ||
    firstLine.includes('=>') ||
    (label === 'Method' && firstLine.includes('('))
  ) {
    if (firstLine.trim().endsWith(';')) return firstLine; // already a signature
    return firstLine.trimEnd() + ' { ... }';
  }

  return firstLine;
}
