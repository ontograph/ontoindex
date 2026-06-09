import type { FrameworkHint } from './types.js';

/**
 * Ruby framework detection.
 * Covers: bin/exe CLI entry points, Rakefile/rake tasks.
 */
export function detectRubyFramework(p: string): FrameworkHint | null {
  // Ruby: bin/ or exe/ (CLI entry points)
  if ((p.includes('/bin/') || p.includes('/exe/')) && p.endsWith('.rb')) {
    return { framework: 'ruby', entryPointMultiplier: 2.5, reason: 'ruby-executable' };
  }

  // Ruby: Rakefile or *.rake (task definitions)
  if (p.endsWith('/rakefile') || p.endsWith('.rake')) {
    return { framework: 'ruby', entryPointMultiplier: 1.5, reason: 'ruby-rake' };
  }

  return null;
}
