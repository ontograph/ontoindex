const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function isTrustedHost(
  hostHeader: string | undefined,
  opts: { port?: number; extraHosts?: string[] },
): boolean {
  if (!hostHeader || /[\s/@?#\\]/.test(hostHeader)) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
    return (
      hostname === parsed.hostname &&
      [...LOOPBACK_HOSTS, ...(opts.extraHosts ?? [])].includes(hostname) &&
      (opts.port === undefined || Number(parsed.port || 80) === opts.port)
    );
  } catch {
    return false;
  }
}

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || /[\s\\]/.test(origin)) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password) return false;
    return (
      (parsed.protocol === 'http:' &&
        isTrustedHost(origin.slice('http://'.length).split('/')[0], {})) ||
      (parsed.protocol === 'https:' && parsed.origin === 'https://ontoindex.vercel.app')
    );
  } catch {
    return false;
  }
}
