const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function parseAuthority(value: string): { hostname: string; port?: string } | undefined {
  if (!value || value.length > 255 || /[\s/@?#\\*]/.test(value)) return;
  const parts = value.match(/^(\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]*)(?::([0-9]+))?$/i);
  if (!parts) return;
  const hostname = parts[1].toLowerCase();
  const port = parts[2];
  if (port !== undefined && (Number(port) > 65535 || String(Number(port)) !== port)) return;
  if (
    !hostname.startsWith('[') &&
    hostname.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))
  )
    return;
  try {
    if (new URL(`http://${value}`).hostname !== hostname) return;
    return { hostname, port };
  } catch {
    return;
  }
}

export function parseAllowedHosts(raw?: string): string[] {
  const hosts: string[] = [];
  let invalid = false;
  const entries = raw?.trim() ? raw.split(',') : [];
  for (const [index, entry] of entries.entries()) {
    const authority = entry.trim().toLowerCase();
    if (index >= 32 || !parseAuthority(authority)) {
      invalid = true;
      continue;
    }
    hosts.push(authority);
  }
  if (invalid)
    console.error(
      'ONTOINDEX_ALLOWED_HOSTS: ignored invalid or excess authorities (maximum 32, 255 characters each; no wildcards).',
    );
  return hosts;
}

export function isTrustedHost(
  hostHeader: string | undefined,
  opts: { port?: number; extraHosts?: string[] },
): boolean {
  if (!hostHeader) return false;
  const parsed = parseAuthority(hostHeader.replace(/^localhost\.(?=:|$)/i, 'localhost'));
  if (!parsed) return false;
  if (
    opts.extraHosts?.some((entry) => {
      const allowed = parseAuthority(entry.toLowerCase());
      return (
        allowed?.hostname === parsed.hostname &&
        (allowed.port === undefined || allowed.port === parsed.port)
      );
    })
  )
    return true;
  return (
    LOOPBACK_HOSTS.includes(parsed.hostname) &&
    (opts.port === undefined || Number(parsed.port ?? 80) === opts.port)
  );
}

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (typeof origin === 'string' && /^http:\/\/localhost\.(?=:|\/|$)/i.test(origin)) return false;
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
