import type { FrameworkHint } from './types.js';

/**
 * Kotlin framework detection.
 * Covers: Spring Boot, Ktor, Android Activities/Fragments, main/application entry points.
 */
export function detectKotlinFramework(p: string): FrameworkHint | null {
  // Spring Boot Kotlin controllers
  if ((p.includes('/controller/') || p.includes('/controllers/')) && p.endsWith('.kt')) {
    return {
      framework: 'spring-kotlin',
      entryPointMultiplier: 3.0,
      reason: 'spring-kotlin-controller',
    };
  }

  // Spring Boot - files ending in Controller.kt
  if (p.endsWith('controller.kt')) {
    return {
      framework: 'spring-kotlin',
      entryPointMultiplier: 3.0,
      reason: 'spring-kotlin-controller-file',
    };
  }

  // Ktor routes
  if (p.includes('/routes/') && p.endsWith('.kt')) {
    return { framework: 'ktor', entryPointMultiplier: 2.5, reason: 'ktor-routes' };
  }

  // Ktor plugins folder or Routing.kt files
  if (p.includes('/plugins/') && p.endsWith('.kt')) {
    return { framework: 'ktor', entryPointMultiplier: 2.0, reason: 'ktor-plugin' };
  }
  if (p.endsWith('routing.kt') || p.endsWith('routes.kt')) {
    return { framework: 'ktor', entryPointMultiplier: 2.5, reason: 'ktor-routing-file' };
  }

  // Android Activities, Fragments
  if ((p.includes('/activity/') || p.includes('/ui/')) && p.endsWith('.kt')) {
    return { framework: 'android-kotlin', entryPointMultiplier: 2.5, reason: 'android-ui' };
  }
  if (p.endsWith('activity.kt') || p.endsWith('fragment.kt')) {
    return { framework: 'android-kotlin', entryPointMultiplier: 2.5, reason: 'android-component' };
  }

  // Kotlin main entry point
  if (p.endsWith('/main.kt')) {
    return { framework: 'kotlin', entryPointMultiplier: 3.0, reason: 'kotlin-main' };
  }

  // Kotlin Application entry point (common naming)
  if (p.endsWith('/application.kt')) {
    return { framework: 'kotlin', entryPointMultiplier: 2.5, reason: 'kotlin-application' };
  }

  return null;
}
