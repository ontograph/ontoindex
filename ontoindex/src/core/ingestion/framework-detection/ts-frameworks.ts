import type { FrameworkHint } from './types.js';

/**
 * JavaScript / TypeScript framework detection.
 * Covers: Next.js (Pages & App Router), Expo Router, Prisma, Supabase,
 * Express, MVC controllers, handlers, React components.
 */
export function detectTsFramework(
  p: string,
  originalPathWithLeadingSlash: string,
): FrameworkHint | null {
  // Next.js - Pages Router (high confidence)
  if (p.includes('/pages/') && !p.includes('/_') && !p.includes('/api/')) {
    if (p.endsWith('.tsx') || p.endsWith('.ts') || p.endsWith('.jsx') || p.endsWith('.js')) {
      return { framework: 'nextjs-pages', entryPointMultiplier: 3.0, reason: 'nextjs-page' };
    }
  }

  // Next.js - App Router (page.tsx files)
  if (
    p.includes('/app/') &&
    (p.endsWith('page.tsx') ||
      p.endsWith('page.ts') ||
      p.endsWith('page.jsx') ||
      p.endsWith('page.js'))
  ) {
    return { framework: 'nextjs-app', entryPointMultiplier: 3.0, reason: 'nextjs-app-page' };
  }

  // Next.js - API Routes
  if (
    p.includes('/pages/api/') ||
    (p.includes('/app/') && p.includes('/api/') && p.endsWith('route.ts'))
  ) {
    return { framework: 'nextjs-api', entryPointMultiplier: 3.0, reason: 'nextjs-api-route' };
  }

  // Next.js - Layout files (moderate - they're entry-ish but not the main entry)
  if (
    p.includes('/app/') &&
    !p.includes('_layout') &&
    (p.endsWith('layout.tsx') || p.endsWith('layout.ts'))
  ) {
    return { framework: 'nextjs-app', entryPointMultiplier: 2.0, reason: 'nextjs-layout' };
  }

  // Expo Router - screen/layout/api files in app/ directory
  if (
    p.includes('/app/') &&
    (p.endsWith('.tsx') || p.endsWith('.ts') || p.endsWith('.jsx') || p.endsWith('.js'))
  ) {
    const fn = p.split('/').pop() || '';
    if (fn.startsWith('_layout')) {
      return { framework: 'expo-router', entryPointMultiplier: 2.0, reason: 'expo-layout' };
    }
    if (fn.startsWith('+') && !fn.startsWith('+api')) {
      return { framework: 'expo-router', entryPointMultiplier: 1.5, reason: 'expo-special-route' };
    }
    if (fn.endsWith('+api.ts') || fn.endsWith('+api.tsx')) {
      return { framework: 'expo-router', entryPointMultiplier: 3.0, reason: 'expo-api-route' };
    }
    return { framework: 'expo-router', entryPointMultiplier: 2.5, reason: 'expo-screen' };
  }

  // Prisma schema (ORM data model definition)
  if (p.includes('/prisma/') && p.endsWith('schema.prisma')) {
    return { framework: 'prisma', entryPointMultiplier: 1.5, reason: 'prisma-schema' };
  }

  // Supabase client files
  if (
    (p.includes('/lib/supabase') || p.includes('/utils/supabase') || p.includes('/supabase/')) &&
    (p.endsWith('.ts') || p.endsWith('.js'))
  ) {
    return { framework: 'supabase', entryPointMultiplier: 1.5, reason: 'supabase-client' };
  }

  // Express / Node.js routes
  if (p.includes('/routes/') && (p.endsWith('.ts') || p.endsWith('.js'))) {
    return { framework: 'express', entryPointMultiplier: 2.5, reason: 'routes-folder' };
  }

  // Generic controllers (MVC pattern)
  if (p.includes('/controllers/') && (p.endsWith('.ts') || p.endsWith('.js'))) {
    return { framework: 'mvc', entryPointMultiplier: 2.5, reason: 'controllers-folder' };
  }

  // Generic handlers
  if (p.includes('/handlers/') && (p.endsWith('.ts') || p.endsWith('.js'))) {
    return { framework: 'handlers', entryPointMultiplier: 2.5, reason: 'handlers-folder' };
  }

  // React components (lower priority - not all are entry points)
  if (
    (p.includes('/components/') || p.includes('/views/')) &&
    (p.endsWith('.tsx') || p.endsWith('.jsx'))
  ) {
    // Only boost if PascalCase filename (likely a component, not util)
    const fileName = originalPathWithLeadingSlash.split('/').pop() || '';
    if (/^[A-Z]/.test(fileName)) {
      return { framework: 'react', entryPointMultiplier: 1.5, reason: 'react-component' };
    }
  }

  return null;
}
