import type { FrameworkHint } from './types.js';

/**
 * Java framework detection.
 * Covers: Spring Boot controllers, service layer.
 */
export function detectJavaFramework(p: string): FrameworkHint | null {
  // Spring Boot controllers
  if ((p.includes('/controller/') || p.includes('/controllers/')) && p.endsWith('.java')) {
    return { framework: 'spring', entryPointMultiplier: 3.0, reason: 'spring-controller' };
  }

  // Spring Boot - files ending in Controller.java
  if (p.endsWith('controller.java')) {
    return { framework: 'spring', entryPointMultiplier: 3.0, reason: 'spring-controller-file' };
  }

  // Java service layer (often entry points for business logic)
  if ((p.includes('/service/') || p.includes('/services/')) && p.endsWith('.java')) {
    return { framework: 'java-service', entryPointMultiplier: 1.8, reason: 'java-service' };
  }

  return null;
}
