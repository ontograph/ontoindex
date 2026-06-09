import type { FrameworkHint } from './types.js';

/**
 * Go framework detection.
 * Covers: handlers, routes, controllers, main.go entry point.
 */
export function detectGoFramework(p: string): FrameworkHint | null {
  // Go handlers
  if ((p.includes('/handlers/') || p.includes('/handler/')) && p.endsWith('.go')) {
    return { framework: 'go-http', entryPointMultiplier: 2.5, reason: 'go-handlers' };
  }

  // Go routes
  if (p.includes('/routes/') && p.endsWith('.go')) {
    return { framework: 'go-http', entryPointMultiplier: 2.5, reason: 'go-routes' };
  }

  // Go controllers
  if (p.includes('/controllers/') && p.endsWith('.go')) {
    return { framework: 'go-mvc', entryPointMultiplier: 2.5, reason: 'go-controller' };
  }

  // Go main.go files (THE entry point) — only match main.go, not arbitrary .go files under cmd/
  if (p.endsWith('/main.go')) {
    return { framework: 'go', entryPointMultiplier: 3.0, reason: 'go-main' };
  }

  return null;
}
