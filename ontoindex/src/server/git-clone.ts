/**
 * Git Clone Utility
 *
 * Shallow-clones repositories into ~/.ontoindex/repos/{name}/.
 * If already cloned, does git pull instead.
 */

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import { createHash, randomUUID } from 'crypto';

type LookupAddress = { address: string; family: number };

/** Remove URL userinfo before rendering untrusted Git output. */
export function redactGitUrl(text: string): string {
  return text.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, '$1');
}

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_CONFIG_(?:COUNT|KEY_.*|VALUE_.*|PARAMETERS)$/.test(key) ||
      /^GIT_SSH/.test(key) ||
      key === 'GIT_PROXY_COMMAND' ||
      key === 'GIT_ASKPASS'
    )
      delete env[key];
  }
  // Preserve operator proxy, PATH, locale and CA settings for transport compatibility.
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  // A no-op askpass keeps credential helpers from opening a GUI prompt.
  env.GIT_ASKPASS = process.platform === 'win32' ? 'echo' : '/bin/true';
  return env;
}

/** Extract the repository name from a git URL (HTTPS or SSH). */
export function extractRepoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '');
  const lastSegment = cleaned.split(/[/:]/).pop() || 'unknown';
  return lastSegment.replace(/\.git$/, '');
}

/** Get the clone target directory for a repo name. */
export function getCloneDir(repoName: string, url?: string): string {
  if (!url) return path.join(os.homedir(), '.ontoindex', 'repos', repoName);
  const parsed = new URL(url);
  const identity = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const safeName = repoName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '_') || 'repo';
  return path.join(os.homedir(), '.ontoindex', 'repos', `${safeName}-${suffix}`);
}

/** Positive ownership evidence, without following directory symlinks. */
export async function isManagedClone(dir: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(dir)).isDirectory()) return false;
    if (!(await fs.lstat(path.join(dir, '.git'))).isDirectory()) return false;
    const markerPath = path.join(dir, '.git', 'ontoindex-managed-clone.json');
    if (!(await fs.lstat(markerPath)).isFile()) return false;
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    return marker?.tool === 'ontoindex';
  } catch {
    return false;
  }
}

export async function canRemoveClone(
  dir: string,
  cloneRoot: string,
  legacyDir: string,
): Promise<boolean> {
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(cloneRoot)) return false;
  try {
    if (!(await fs.lstat(resolved)).isDirectory()) return false;
    if (await isManagedClone(resolved)) return true;
    return (
      resolved === path.resolve(legacyDir) &&
      (await fs.lstat(path.join(resolved, '.git'))).isDirectory()
    );
  } catch {
    return false;
  }
}

export async function sweepStaleCloneStaging(
  cloneRoot: string,
  { olderThanMs = 24 * 60 * 60 * 1000 } = {},
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(cloneRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const match = /^(.+)\.(tmp-\d+-[0-9a-f-]{36}|old-[0-9a-f-]{36})$/.exec(entry);
    if (!match) continue;
    const dir = path.join(cloneRoot, entry);
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || Date.now() - stat.mtimeMs < olderThanMs) continue;
    const target = path.join(cloneRoot, match[1]!);
    if (match[2]!.startsWith('old-')) {
      let missing = false;
      try {
        await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else throw error;
      }
      const legacy = path.resolve(target) === path.resolve(getCloneDir(match[1]!));
      if (
        missing &&
        ((await isManagedClone(dir)) || (legacy && (await canRemoveClone(dir, cloneRoot, dir))))
      ) {
        await fs.rename(dir, target);
        continue;
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Cloud metadata hostnames that must never be reachable via user-supplied URLs
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.internal',
]);

/**
 * Validate a git URL to prevent SSRF attacks.
 * Only allows https:// and http:// schemes. Blocks private/internal addresses,
 * IPv6 private ranges, cloud metadata hostnames, and numeric IP encodings.
 */
export function validateGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Only https:// and http:// git URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Git URLs containing credentials are not allowed');
  }

  const host = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames (cloud metadata services)
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Strip IPv6 brackets if present (URL parser behavior varies across Node versions)
  let normalizedHost = host;
  if (host.startsWith('[') && host.endsWith(']')) {
    normalizedHost = host.slice(1, -1);
  }

  // Check if this is an IPv6 address
  // Use manual colon detection as fallback since isIP may return 0 for some
  // normalized IPv6 forms (e.g. ::ffff:7f00:1)
  const isIPv6 = isIP(normalizedHost) === 6 || normalizedHost.includes(':');
  if (isIPv6) {
    assertNotPrivateIPv6(normalizedHost);
    return;
  }

  // Check if this is an IPv4 address (including numeric encodings)
  if (isIP(normalizedHost) === 4) {
    assertNotPrivateIPv4(normalizedHost);
    return;
  }

  // For non-IP hostnames, check for numeric IP tricks
  // Decimal encoding: 2130706433 = 127.0.0.1
  // Hex encoding: 0x7f000001 = 127.0.0.1
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Standard IPv4 regex checks for dotted notation
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host === '0.0.0.0' ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^198\.1[89]\./.test(host)
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv6(ip: string): void {
  // Expand common compressed forms for comparison
  const lower = ip.toLowerCase();

  // IPv6 loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Unspecified address
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 Unique Local Address (fc00::/7 = fc and fd prefixes)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 link-local (fe80::/10)
  if (
    lower.startsWith('fe80') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  if (lower.startsWith('ff')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:hex:hex)
  // Node may normalize ::ffff:127.0.0.1 to ::ffff:7f00:1
  if (lower.startsWith('::ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Also catch the expanded form: 0:0:0:0:0:ffff:
  if (lower.includes(':ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv4(ip: string): void {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 255 && b === 255) ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

interface CloneProgress {
  phase: 'cloning' | 'pulling';
  message: string;
}

interface GitRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;
  runGit?: typeof runGit;
}

const GIT_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_GIT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();
const MAX_GIT_STDERR_CHARS = 16 * 1024;

function appendCapped(existing: string, chunk: Buffer): string {
  const next = existing + chunk.toString();
  return next.length > MAX_GIT_STDERR_CHARS ? next.slice(-MAX_GIT_STDERR_CHARS) : next;
}

/**
 * Clone or pull a git repository.
 * If targetDir doesn't exist: git clone --depth 1
 * If targetDir exists with .git: git pull --ff-only
 */
const cloneLocks = new Map<string, Promise<void>>();

export async function cloneOrPull(
  url: string,
  targetDir: string,
  onProgress?: (progress: CloneProgress) => void,
  options: GitRunOptions = {},
): Promise<string> {
  const key = path.resolve(targetDir);
  const previous = cloneLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  cloneLocks.set(key, current);
  await previous;
  try {
    if (options.signal?.aborted) throw new Error('git operation aborted');
    return await cloneFresh(url, targetDir, onProgress, options);
  } finally {
    release();
    if (cloneLocks.get(key) === current) cloneLocks.delete(key);
  }
}

async function cloneFresh(
  url: string,
  targetDir: string,
  onProgress?: (progress: CloneProgress) => void,
  options: GitRunOptions = {},
): Promise<string> {
  const staging = `${targetDir}.tmp-${process.pid}-${randomUUID()}`;
  const backup = `${targetDir}.old-${randomUUID()}`;
  let movedOld = false;
  try {
    try {
      const targetStat = await fs.lstat(targetDir);
      // Pre-marker releases used this exact URL-derived clone location.
      let unmarkedHashedClone = false;
      if (
        targetStat.isDirectory() &&
        path.resolve(targetDir) === path.resolve(getCloneDir(extractRepoName(url), url))
      ) {
        try {
          unmarkedHashedClone = (await fs.lstat(path.join(targetDir, '.git'))).isDirectory();
        } catch {
          // Missing or unreadable Git metadata is not evidence of a clone.
        }
      }
      if (
        !unmarkedHashedClone &&
        !(await canRemoveClone(
          targetDir,
          path.dirname(targetDir),
          getCloneDir(extractRepoName(url)),
        ))
      ) {
        throw new Error(
          `Refusing to replace an existing directory that ontoindex did not create: ${targetDir}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    validateGitUrl(url);
    const parsed = new URL(url);
    let address: string | undefined;
    let addresses: string[] = [];
    const host = parsed.hostname.toLowerCase();
    if (isIP(host.replace(/^\[|\]$/g, '')) === 0) {
      let answers: LookupAddress[];
      try {
        answers = await (options.lookup ?? ((h, o) => dnsLookup(h, o)))(host, {
          all: true,
          verbatim: true,
        });
      } catch {
        throw new Error('Could not resolve git host');
      }
      if (answers.length === 0) throw new Error('Could not resolve git host');
      for (const answer of answers) {
        if (answer.family === 4) assertNotPrivateIPv4(answer.address);
        else if (answer.family === 6) assertNotPrivateIPv6(answer.address);
        else throw new Error('Could not validate git host address');
      }
      address = answers[0]!.address;
      addresses = answers.map((answer) => answer.address);
    }
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    onProgress?.({ phase: 'cloning', message: `Cloning ${redactGitUrl(url)}...` });
    const args = gitArgs([
      'clone',
      '--depth',
      '1',
      '--no-recurse-submodules',
      '--template=',
      url,
      staging,
    ]);
    if (address) {
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const resolveList = addresses
        .map((answer) => (answer.includes(':') ? `[${answer}]` : answer))
        .join(',');
      args.unshift(`-chttp.curloptResolve=${host}:${port}:${resolveList}`);
    }
    await (options.runGit ?? runGit)(args, undefined, options);
    if (options.signal?.aborted) throw new Error('git operation aborted');
    await fs.writeFile(
      path.join(staging, '.git', 'ontoindex-managed-clone.json'),
      JSON.stringify({
        version: 1,
        url: redactGitUrl(url),
        createdAt: new Date().toISOString(),
        tool: 'ontoindex',
      }),
    );
    try {
      await fs.rename(targetDir, backup);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(staging, targetDir);
    } catch (error) {
      if (movedOld) await fs.rename(backup, targetDir);
      throw error;
    }
    if (movedOld) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }

  return targetDir;
}

function gitArgs(args: string[]): string[] {
  return [
    '-cprotocol.allow=never',
    '-cprotocol.https.allow=always',
    '-cprotocol.http.allow=always',
    '-chttp.followRedirects=false',
    '-ccore.hooksPath=/dev/null',
    '-ccore.fsmonitor=false',
    ...args,
  ];
}

export function runGit(
  args: string[],
  cwd?: string,
  options: GitRunOptions = {},
): Promise<string | void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('git operation aborted'));
      return;
    }

    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnvironment(),
    });

    let stderr = '';
    let stdout = '';
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(stdout.trim());
    };

    const terminate = (reason: 'timeout' | 'abort') => {
      if (proc.killed) return;
      timedOut = reason === 'timeout';
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) proc.kill('SIGKILL');
      }, 5_000);
      killTimer.unref?.();
    };

    const onAbort = () => terminate('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    timer.unref?.();

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });

    proc.on('close', (code, signal) => {
      if (code === 0 && !timedOut && !options.signal?.aborted) finish();
      else if (timedOut) {
        finish(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
      } else if (options.signal?.aborted) {
        finish(new Error(`git ${args[0]} aborted`));
      } else {
        // Log full stderr internally but don't expose it to API callers (SSRF mitigation)
        if (stderr.trim()) console.error(redactGitUrl(`git ${args[0]} stderr: ${stderr.trim()}`));
        finish(
          new Error(
            `git ${args[0]} failed (${code === null ? `signal ${signal}` : `exit code ${code}`})`,
          ),
        );
      }
    });

    proc.on('error', (err) => {
      finish(new Error(redactGitUrl(`Failed to spawn git: ${err.message}`)));
    });
  });
}
