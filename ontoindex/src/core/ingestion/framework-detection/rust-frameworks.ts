import type { FrameworkHint } from './types.js';

/**
 * Rust framework detection.
 * Covers: handlers/routes, main.rs entry point, bin/ executables.
 */
export function detectRustFramework(p: string): FrameworkHint | null {
  // Rust handlers/routes
  if ((p.includes('/handlers/') || p.includes('/routes/')) && p.endsWith('.rs')) {
    return { framework: 'rust-web', entryPointMultiplier: 2.5, reason: 'rust-handlers' };
  }

  // Rust main.rs (THE entry point)
  if (p.endsWith('/main.rs')) {
    return { framework: 'rust', entryPointMultiplier: 3.0, reason: 'rust-main' };
  }

  // Rust bin folder (executables)
  if (p.includes('/bin/') && p.endsWith('.rs')) {
    return { framework: 'rust', entryPointMultiplier: 2.5, reason: 'rust-bin' };
  }

  return null;
}
