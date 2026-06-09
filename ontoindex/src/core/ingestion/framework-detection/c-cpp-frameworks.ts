import type { FrameworkHint } from './types.js';

/**
 * C / C++ framework detection.
 * Covers: main entry points, src/ app entry files.
 */
export function detectCCppFramework(p: string): FrameworkHint | null {
  // C/C++ main files
  if (p.endsWith('/main.c') || p.endsWith('/main.cpp') || p.endsWith('/main.cc')) {
    return { framework: 'c-cpp', entryPointMultiplier: 3.0, reason: 'c-main' };
  }

  // C/C++ src folder entry points (if named specifically)
  if (p.includes('/src/') && (p.endsWith('/app.c') || p.endsWith('/app.cpp'))) {
    return { framework: 'c-cpp', entryPointMultiplier: 2.5, reason: 'c-app' };
  }

  return null;
}
