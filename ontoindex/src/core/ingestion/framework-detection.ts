/**
 * Framework Detection — re-export shim
 *
 * All logic has been moved to ./framework-detection/index.ts and per-language modules.
 * This file exists so existing callers need zero changes.
 */
export {
  detectFrameworkFromPath,
  detectFrameworkFromAST,
  FRAMEWORK_AST_PATTERNS,
  AST_FRAMEWORK_PATTERNS_BY_LANGUAGE,
} from './framework-detection/index.js';
export type { FrameworkHint } from './framework-detection/index.js';
