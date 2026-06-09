import type { FrameworkHint } from './types.js';

/**
 * Dart / Flutter framework detection.
 * Covers: main/app entry points, screens/pages/views, routes,
 * BLoC/controllers/state management, services/domain, widgets.
 */
export function detectDartFramework(p: string): FrameworkHint | null {
  // Flutter main/app entry points
  if (p.endsWith('/main.dart') || p.endsWith('/app.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 3.0, reason: 'flutter-main' };
  }

  // Flutter screens/pages/views (high priority - route entry points)
  if (
    (p.includes('/screens/') || p.includes('/pages/') || p.includes('/views/')) &&
    p.endsWith('.dart')
  ) {
    return { framework: 'flutter', entryPointMultiplier: 2.5, reason: 'flutter-screen' };
  }

  // Flutter routes
  if (p.includes('/routes/') && p.endsWith('.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 2.5, reason: 'flutter-routes' };
  }

  // Flutter BLoC / controllers / presentation (state management entry points)
  if (
    (p.includes('/bloc/') ||
      p.includes('/controllers/') ||
      p.includes('/cubit/') ||
      p.includes('/presentation/')) &&
    p.endsWith('.dart')
  ) {
    return { framework: 'flutter', entryPointMultiplier: 2.0, reason: 'flutter-state-management' };
  }

  // Flutter services / domain
  if ((p.includes('/services/') || p.includes('/domain/')) && p.endsWith('.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 1.8, reason: 'flutter-service' };
  }

  // Flutter widgets (reusable components)
  if (p.includes('/widgets/') && p.endsWith('.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 1.5, reason: 'flutter-widget' };
  }

  return null;
}
