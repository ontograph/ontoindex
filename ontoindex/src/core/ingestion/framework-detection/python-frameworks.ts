import type { FrameworkHint } from './types.js';

/**
 * Python framework detection.
 * Covers: Django views/urls, FastAPI/Flask routers, Python API folders.
 */
export function detectPythonFramework(p: string): FrameworkHint | null {
  // Django views (high confidence)
  if (p.endsWith('views.py')) {
    return { framework: 'django', entryPointMultiplier: 3.0, reason: 'django-views' };
  }

  // Django URL configs
  if (p.endsWith('urls.py')) {
    return { framework: 'django', entryPointMultiplier: 2.0, reason: 'django-urls' };
  }

  // FastAPI / Flask routers
  if (
    (p.includes('/routers/') || p.includes('/endpoints/') || p.includes('/routes/')) &&
    p.endsWith('.py')
  ) {
    return { framework: 'fastapi', entryPointMultiplier: 2.5, reason: 'api-routers' };
  }

  // Python API folder
  if (p.includes('/api/') && p.endsWith('.py') && !p.endsWith('__init__.py')) {
    return { framework: 'python-api', entryPointMultiplier: 2.0, reason: 'api-folder' };
  }

  return null;
}
