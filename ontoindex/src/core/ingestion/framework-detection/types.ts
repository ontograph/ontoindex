/**
 * Shared types for per-language framework detection modules.
 */

export interface FrameworkHint {
  framework: string;
  entryPointMultiplier: number;
  reason: string;
}
