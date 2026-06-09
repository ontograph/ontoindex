import type { FrameworkHint } from './types.js';

/**
 * Swift / iOS framework detection.
 * Covers: iOS app delegates, SwiftUI, UIKit ViewControllers, Coordinators,
 * service layer, router/navigation.
 */
export function detectSwiftFramework(p: string): FrameworkHint | null {
  // iOS App entry points (highest priority)
  if (
    p.endsWith('/appdelegate.swift') ||
    p.endsWith('/scenedelegate.swift') ||
    p.endsWith('/app.swift')
  ) {
    return { framework: 'ios', entryPointMultiplier: 3.0, reason: 'ios-app-entry' };
  }

  // SwiftUI App entry (@main)
  if (p.endsWith('app.swift') && p.includes('/sources/')) {
    return { framework: 'swiftui', entryPointMultiplier: 3.0, reason: 'swiftui-app' };
  }

  // UIKit ViewControllers (high priority - screen entry points)
  if (
    (p.includes('/viewcontrollers/') || p.includes('/controllers/') || p.includes('/screens/')) &&
    p.endsWith('.swift')
  ) {
    return { framework: 'uikit', entryPointMultiplier: 2.5, reason: 'uikit-viewcontroller' };
  }

  // ViewController by filename convention
  if (p.endsWith('viewcontroller.swift') || p.endsWith('vc.swift')) {
    return { framework: 'uikit', entryPointMultiplier: 2.5, reason: 'uikit-viewcontroller-file' };
  }

  // Coordinator pattern (navigation entry points)
  if (p.includes('/coordinators/') && p.endsWith('.swift')) {
    return { framework: 'ios-coordinator', entryPointMultiplier: 2.5, reason: 'ios-coordinator' };
  }

  // Coordinator by filename
  if (p.endsWith('coordinator.swift')) {
    return {
      framework: 'ios-coordinator',
      entryPointMultiplier: 2.5,
      reason: 'ios-coordinator-file',
    };
  }

  // SwiftUI Views (moderate - reusable components)
  if ((p.includes('/views/') || p.includes('/scenes/')) && p.endsWith('.swift')) {
    return { framework: 'swiftui', entryPointMultiplier: 1.8, reason: 'swiftui-view' };
  }

  // Service layer
  if (p.includes('/services/') && p.endsWith('.swift')) {
    return { framework: 'ios-service', entryPointMultiplier: 1.8, reason: 'ios-service' };
  }

  // Router / navigation
  if (p.includes('/router/') && p.endsWith('.swift')) {
    return { framework: 'ios-router', entryPointMultiplier: 2.0, reason: 'ios-router' };
  }

  return null;
}
