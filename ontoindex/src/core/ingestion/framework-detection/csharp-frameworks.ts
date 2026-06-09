import type { FrameworkHint } from './types.js';

/**
 * C# / .NET framework detection.
 * Covers: ASP.NET controllers/services/middleware, SignalR, Program.cs/Startup.cs,
 * background/hosted services, Blazor pages.
 */
export function detectCsharpFramework(p: string): FrameworkHint | null {
  // ASP.NET Controllers
  if (p.includes('/controllers/') && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-controller' };
  }

  // ASP.NET - files ending in Controller.cs
  if (p.endsWith('controller.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-controller-file' };
  }

  // ASP.NET Services
  if ((p.includes('/services/') || p.includes('/service/')) && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 1.8, reason: 'aspnet-service' };
  }

  // ASP.NET Middleware
  if (p.includes('/middleware/') && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 2.5, reason: 'aspnet-middleware' };
  }

  // SignalR Hubs
  if (p.includes('/hubs/') && p.endsWith('.cs')) {
    return { framework: 'signalr', entryPointMultiplier: 2.5, reason: 'signalr-hub' };
  }
  if (p.endsWith('hub.cs')) {
    return { framework: 'signalr', entryPointMultiplier: 2.5, reason: 'signalr-hub-file' };
  }

  // Minimal API / Program.cs / Startup.cs
  if (p.endsWith('/program.cs') || p.endsWith('/startup.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-entry' };
  }

  // Background services / Hosted services
  if ((p.includes('/backgroundservices/') || p.includes('/hostedservices/')) && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 2.0, reason: 'aspnet-background-service' };
  }

  // Blazor pages
  if (p.includes('/pages/') && p.endsWith('.razor')) {
    return { framework: 'blazor', entryPointMultiplier: 2.5, reason: 'blazor-page' };
  }

  return null;
}
