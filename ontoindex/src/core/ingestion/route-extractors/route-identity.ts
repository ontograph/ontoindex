import { generateId } from '../../../lib/utils.js';

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

export function normalizeHttpMethod(httpMethod?: string | null): string | undefined {
  const method = httpMethod?.trim().toUpperCase();
  return method && HTTP_METHODS.has(method) ? method : undefined;
}

export function routeIdentity(routePath: string, httpMethod?: string | null): string {
  const method = normalizeHttpMethod(httpMethod);
  return method ? `${method} ${routePath}` : routePath;
}

export const routeNodeId = (routePath: string, httpMethod?: string | null): string =>
  generateId('Route', routeIdentity(routePath, httpMethod));

/** Method is encoded in new Route IDs so older Route table schemas stay readable. */
export function httpMethodFromRouteId(routeId: string): string | undefined {
  if (!routeId.startsWith('Route:')) return undefined;
  const identity = routeId.slice('Route:'.length);
  const match = identity.match(/^([A-Z]+)(?: |:)/);
  return match && HTTP_METHODS.has(match[1]!) ? match[1] : undefined;
}
