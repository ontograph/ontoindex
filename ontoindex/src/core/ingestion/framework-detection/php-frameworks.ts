import type { FrameworkHint } from './types.js';

/**
 * PHP / Laravel framework detection.
 * Covers: routes, controllers, console commands, jobs, listeners,
 * middleware, service providers, policies, models, services, repositories.
 */
export function detectPhpFramework(p: string): FrameworkHint | null {
  // Laravel routes (highest - these ARE the entry point definitions)
  if (p.includes('/routes/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 3.0, reason: 'laravel-routes' };
  }

  // Laravel controllers (very high - receive HTTP requests)
  if ((p.includes('/http/controllers/') || p.includes('/controllers/')) && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 3.0, reason: 'laravel-controller' };
  }

  // Laravel controller by file name convention
  if (p.endsWith('controller.php')) {
    return { framework: 'laravel', entryPointMultiplier: 3.0, reason: 'laravel-controller-file' };
  }

  // Laravel console commands
  if ((p.includes('/console/commands/') || p.includes('/commands/')) && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-command' };
  }

  // Laravel jobs (queue entry points)
  if (p.includes('/jobs/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-job' };
  }

  // Laravel listeners (event-driven entry points)
  if (p.includes('/listeners/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-listener' };
  }

  // Laravel middleware
  if (p.includes('/http/middleware/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-middleware' };
  }

  // Laravel service providers
  if (p.includes('/providers/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.8, reason: 'laravel-provider' };
  }

  // Laravel policies
  if (p.includes('/policies/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.0, reason: 'laravel-policy' };
  }

  // Laravel models (important but not entry points per se)
  if (p.includes('/models/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.5, reason: 'laravel-model' };
  }

  // Laravel services (Service Repository pattern)
  if (p.includes('/services/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.8, reason: 'laravel-service' };
  }

  // Laravel repositories (Service Repository pattern)
  if (p.includes('/repositories/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.5, reason: 'laravel-repository' };
  }

  return null;
}
