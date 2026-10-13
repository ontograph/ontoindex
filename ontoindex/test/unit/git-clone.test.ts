import { describe, it, expect, vi } from 'vitest';
import {
  extractRepoName,
  getCloneDir,
  validateGitUrl,
  cloneOrPull,
  redactGitUrl,
  gitEnvironment,
  isManagedClone,
  canRemoveClone,
  sweepStaleCloneStaging,
} from '../../src/server/git-clone.js';
import type { LookupAddress } from 'node:dns';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('git-clone', () => {
  it.each(['checkout', 'missing-git', 'other-path', 'symlink', 'git-symlink'])(
    'refreshes only a real unmarked URL-hashed checkout: %s',
    async (kind) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-upgrade-'));
      const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
      const url = 'https://example.com/repo';
      const hashed = getCloneDir(extractRepoName(url), url);
      const target = kind === 'other-path' ? path.join(home, 'other') : hashed;
      const actual = kind === 'symlink' ? path.join(home, 'actual') : target;
      const runGit = vi.fn(async (args: string[]) => {
        await fs.mkdir(path.join(args.at(-1)!, '.git'), { recursive: true });
        await fs.writeFile(path.join(args.at(-1)!, 'new'), 'new');
      });
      try {
        await fs.mkdir(actual, { recursive: true });
        await fs.writeFile(path.join(actual, 'old'), 'old');
        if (kind === 'git-symlink') {
          await fs.mkdir(path.join(home, 'git'));
          await fs.symlink(path.join(home, 'git'), path.join(actual, '.git'));
        } else if (kind !== 'missing-git') {
          await fs.mkdir(path.join(actual, '.git'));
        }
        if (kind === 'symlink') {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.symlink(actual, target);
        }
        expect(await canRemoveClone(target, path.dirname(target), getCloneDir('repo'))).toBe(false);
        const refresh = cloneOrPull(url, target, undefined, {
          runGit,
          lookup: async () => [{ address: '140.82.121.4', family: 4 }],
        });
        if (kind === 'checkout') {
          await refresh;
          expect(await fs.readdir(target)).toEqual(['.git', 'new']);
          expect(await isManagedClone(target)).toBe(true);
          expect(runGit).toHaveBeenCalledTimes(1);
        } else {
          await expect(refresh).rejects.toThrow('Refusing to replace');
          expect(await fs.readFile(path.join(actual, 'old'), 'utf8')).toBe('old');
          expect(runGit).not.toHaveBeenCalled();
          if (kind === 'symlink') expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
        }
      } finally {
        homeSpy.mockRestore();
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it('preserves unmanaged directories and only accepts owned or exact legacy clones', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-ownership-'));
    const dir = path.join(root, 'repo');
    try {
      await fs.mkdir(dir);
      expect(await canRemoveClone(dir, root, dir)).toBe(false);
      await fs.mkdir(path.join(dir, '.git'));
      expect(await canRemoveClone(dir, root, path.join(root, 'other'))).toBe(false);
      expect(await canRemoveClone(dir, root, dir)).toBe(true);
      const runGit = vi.fn();
      await expect(
        cloneOrPull('https://example.com/repo', dir, undefined, { runGit }),
      ).rejects.toThrow('Refusing to replace');
      expect(runGit).not.toHaveBeenCalled();
      await fs.writeFile(
        path.join(dir, '.git', 'ontoindex-managed-clone.json'),
        JSON.stringify({ tool: 'ontoindex', version: 1 }),
      );
      expect(await isManagedClone(dir)).toBe(true);
      expect(await canRemoveClone(dir, root, path.join(root, 'other'))).toBe(true);
      const link = path.join(root, 'link');
      await fs.symlink(dir, link);
      expect(await canRemoveClone(link, root, link)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('sweeps stale staging and recovers owned orphan backups without following symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-sweep-'));
    const id = '12345678-1234-1234-1234-123456789abc';
    try {
      for (const name of [
        `stale.tmp-1-${id}`,
        `young.tmp-1-${id}`,
        `repo.old-${id}`,
        'unrelated',
      ]) {
        await fs.mkdir(path.join(root, name));
      }
      const backup = path.join(root, `repo.old-${id}`);
      await fs.mkdir(path.join(backup, '.git'));
      await fs.writeFile(
        path.join(backup, '.git', 'ontoindex-managed-clone.json'),
        '{"tool":"ontoindex"}',
      );
      const old = new Date(Date.now() - 10000);
      await fs.utimes(path.join(root, `stale.tmp-1-${id}`), old, old);
      await fs.utimes(backup, old, old);
      await fs.symlink(path.join(root, 'unrelated'), path.join(root, `link.tmp-1-${id}`));
      await sweepStaleCloneStaging(root, { olderThanMs: 5000 });
      expect((await fs.readdir(root)).sort()).toEqual(
        [`link.tmp-1-${id}`, 'repo', 'unrelated', `young.tmp-1-${id}`].sort(),
      );
      expect(await isManagedClone(path.join(root, 'repo'))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('rejects URL credentials without exposing them', async () => {
    const progress = vi.fn();
    const runGit = vi.fn(async () => {});
    await expect(
      cloneOrPull('https://user:secret@git.example/repo', '/nonexistent/ontoindex-test', progress, {
        runGit,
      }),
    ).rejects.toThrow('credentials');
    expect(progress).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
    expect(() => validateGitUrl('https://user@git.example/repo')).toThrow('credentials');
  });

  it('redacts userinfo from URLs embedded in output', () => {
    expect(
      redactGitUrl('fatal: https://user:secret@example.com/repo and http://token@example.org/x'),
    ).toBe('fatal: https://example.com/repo and http://example.org/x');
    expect(redactGitUrl('https://example.com/repo')).toBe('https://example.com/repo');
  });

  it('isolates git configuration while retaining TLS and proxy settings', () => {
    const env = gitEnvironment({
      PATH: '/bin',
      HTTPS_PROXY: 'proxy',
      SSL_CERT_FILE: 'ca',
      GIT_CONFIG_PARAMETERS: 'rewrite',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.x.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://',
      GIT_SSH_COMMAND: 'ssh',
      GIT_ASKPASS: 'prompt',
    });
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      PATH: '/bin',
      HTTPS_PROXY: 'proxy',
      SSL_CERT_FILE: 'ca',
    });
    for (const key of [
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_SSH_COMMAND',
    ])
      expect(env).not.toHaveProperty(key);
    expect(env.GIT_ASKPASS).not.toBe('prompt');
  });

  it('replaces an existing checkout without reading its config', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'git-clone-origin-'));
    try {
      await fs.mkdir(path.join(parent, '.git'));
      await fs.writeFile(
        path.join(parent, '.git', 'ontoindex-managed-clone.json'),
        '{"tool":"ontoindex"}',
      );
      await fs.writeFile(path.join(parent, 'old'), 'old');
      const runGit = vi.fn(async (args: string[]) => {
        const staging = args.at(-1)!;
        await fs.mkdir(path.join(staging, '.git'), { recursive: true });
        await fs.writeFile(path.join(staging, 'new'), 'new');
      });
      const progress = vi.fn();
      await cloneOrPull('https://example.com/repo', parent, progress, {
        runGit,
        lookup: async () => [{ address: '140.82.121.4', family: 4 }],
      });
      expect(runGit).toHaveBeenCalledTimes(1);
      expect(runGit.mock.calls[0]![0]).toContain('https://example.com/repo');
      expect(runGit.mock.calls[0]![0]).not.toContain('pull');
      expect(runGit.mock.calls[0]![0]).not.toContain('config');
      expect(await fs.readdir(parent)).toEqual(['.git', 'new']);
      const marker = JSON.parse(
        await fs.readFile(path.join(parent, '.git', 'ontoindex-managed-clone.json'), 'utf8'),
      );
      expect(marker).toMatchObject({
        version: 1,
        tool: 'ontoindex',
        url: redactGitUrl('https://example.com/repo'),
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
  describe('extractRepoName', () => {
    it('keeps the checkout on failure and serializes concurrent refreshes', async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'git-refresh-'));
      const target = path.join(parent, 'repo');
      await fs.mkdir(target);
      await fs.mkdir(path.join(target, '.git'));
      await fs.writeFile(
        path.join(target, '.git', 'ontoindex-managed-clone.json'),
        '{"tool":"ontoindex"}',
      );
      await fs.writeFile(path.join(target, 'old'), 'old');
      const lookup = async () => [{ address: '140.82.121.4', family: 4 }];
      try {
        await expect(
          cloneOrPull('https://example.com/repo', target, undefined, {
            lookup,
            runGit: async (args) => {
              await fs.mkdir(args.at(-1)!);
              throw new Error('clone failed');
            },
          }),
        ).rejects.toThrow('clone failed');
        expect(await fs.readdir(parent)).toEqual(['repo']);
        expect(await fs.readFile(path.join(target, 'old'), 'utf8')).toBe('old');
        let finish!: () => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const runGit = vi.fn(async (args: string[]) => {
          if (runGit.mock.calls.length === 1) {
            started();
            await gate;
          }
          await fs.mkdir(path.join(args.at(-1)!, '.git'), { recursive: true });
        });
        const first = cloneOrPull('https://example.com/repo', target, undefined, {
          lookup,
          runGit,
        });
        await entered;
        const second = cloneOrPull('https://example.com/repo', target, undefined, {
          lookup,
          runGit,
        });
        await Promise.resolve();
        expect(runGit).toHaveBeenCalledTimes(1);
        finish();
        await Promise.all([first, second]);
        expect(runGit).toHaveBeenCalledTimes(2);
        expect(await fs.readdir(parent)).toEqual(['repo']);
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    });
    it('extracts name from HTTPS URL', () => {
      expect(extractRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
    });

    it('extracts name from HTTPS URL without .git suffix', () => {
      expect(extractRepoName('https://github.com/user/my-repo')).toBe('my-repo');
    });

    it('extracts name from SSH URL', () => {
      expect(extractRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
    });

    it('handles trailing slashes', () => {
      expect(extractRepoName('https://github.com/user/my-repo/')).toBe('my-repo');
    });

    it('handles nested paths', () => {
      expect(extractRepoName('https://gitlab.com/group/subgroup/repo.git')).toBe('repo');
    });
  });

  describe('getCloneDir', () => {
    it('isolates identities while canonicalizing host and git suffix', () => {
      expect(getCloneDir('x', 'https://github.com/a/x.git')).not.toBe(
        getCloneDir('x', 'https://github.com/b/x.git'),
      );
      expect(getCloneDir('x', 'https://GITHUB.com/a/x.git')).toBe(
        getCloneDir('x', 'https://github.com/a/x/'),
      );
    });
    it('returns path under ~/.ontoindex/repos/', () => {
      const dir = getCloneDir('my-repo');
      expect(dir).toContain('.ontoindex');
      expect(dir).toMatch(/repos/);
      expect(dir).toContain('my-repo');
    });
  });

  describe('validateGitUrl', () => {
    it('allows valid HTTPS GitHub URLs', () => {
      expect(() => validateGitUrl('https://github.com/user/repo.git')).not.toThrow();
      expect(() => validateGitUrl('https://github.com/user/repo')).not.toThrow();
    });

    it('allows valid HTTP URLs', () => {
      expect(() => validateGitUrl('http://gitlab.com/user/repo.git')).not.toThrow();
    });

    it('blocks SSH protocol', () => {
      expect(() => validateGitUrl('ssh://git@github.com/user/repo.git')).toThrow(
        'Only https:// and http://',
      );
    });

    it('blocks file:// protocol', () => {
      expect(() => validateGitUrl('file:///etc/passwd')).toThrow('Only https:// and http://');
    });

    it('blocks IPv4 loopback', () => {
      expect(() => validateGitUrl('http://127.0.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://127.255.0.1/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv6 loopback ::1', () => {
      // Node URL parser strips brackets: hostname is "::1" not "[::1]"
      expect(() => validateGitUrl('http://[::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv4 private ranges (10.x, 172.16-31.x, 192.168.x)', () => {
      expect(() => validateGitUrl('http://10.0.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://172.16.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://172.31.255.255/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://192.168.1.1/repo.git')).toThrow('private/internal');
    });

    it('blocks link-local addresses', () => {
      expect(() => validateGitUrl('http://169.254.1.1/repo.git')).toThrow('private/internal');
    });

    it('blocks cloud metadata hostname', () => {
      expect(() => validateGitUrl('http://metadata.google.internal/repo')).toThrow(
        'private/internal',
      );
      expect(() => validateGitUrl('http://metadata.azure.com/repo')).toThrow('private/internal');
    });

    it('blocks IPv6 ULA (fc/fd)', () => {
      expect(() => validateGitUrl('http://[fc00::1]/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://[fd12::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv6 link-local (fe80)', () => {
      expect(() => validateGitUrl('http://[fe80::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv4-mapped IPv6', () => {
      expect(() => validateGitUrl('http://[::ffff:127.0.0.1]/repo.git')).toThrow(
        'private/internal',
      );
    });

    it('does not block valid public IPs', () => {
      expect(() => validateGitUrl('https://140.82.121.4/repo.git')).not.toThrow();
    });

    it('blocks CGN range (100.64.0.0/10)', () => {
      expect(() => validateGitUrl('http://100.64.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://100.127.255.255/repo.git')).toThrow('private/internal');
    });

    it('blocks benchmarking range (198.18.0.0/15)', () => {
      expect(() => validateGitUrl('http://198.18.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://198.19.255.255/repo.git')).toThrow('private/internal');
    });

    it('blocks numeric decimal IP encoding', () => {
      expect(() => validateGitUrl('http://2130706433/repo.git')).toThrow('private/internal');
    });

    it('blocks hex IP encoding', () => {
      expect(() => validateGitUrl('http://0x7f000001/repo.git')).toThrow('private/internal');
    });

    it('blocks 0.0.0.0', () => {
      expect(() => validateGitUrl('http://0.0.0.0/repo.git')).toThrow('private/internal');
    });
  });

  describe('hostname resolution and pinned cloning', () => {
    const publicAnswer: LookupAddress = { address: '140.82.121.4', family: 4 };
    const makeTarget = async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'git-clone-ssrf-'));
      return { parent, target: path.join(parent, 'repo') };
    };

    it.each(['127.0.0.1', '::1', '10.2.3.4', '169.254.169.254', 'fc00::1', '::ffff:10.0.0.1'])(
      'refuses hostname resolving to %s',
      async (address) => {
        const runGit = vi.fn(async (_args: string[]) => {});
        const { target } = await makeTarget();
        await expect(
          cloneOrPull('https://git.example/repo.git', target, undefined, {
            lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
            runGit,
          }),
        ).rejects.toThrow('private/internal');
        expect(runGit).not.toHaveBeenCalled();
      },
    );

    it('refuses a mixed public and private DNS answer set', async () => {
      const runGit = vi.fn(async (_args: string[]) => {});
      const { target } = await makeTarget();
      await expect(
        cloneOrPull('https://git.example/repo.git', target, undefined, {
          lookup: async () => [publicAnswer, { address: '192.168.1.5', family: 4 }],
          runGit,
        }),
      ).rejects.toThrow('private/internal');
      expect(runGit).not.toHaveBeenCalled();
    });

    it('pins all-public DNS answers and restricts git protocols', async () => {
      const runGit = vi.fn(async (args: string[]) => {
        await fs.mkdir(path.join(args.at(-1)!, '.git'), { recursive: true });
      });
      const { parent, target } = await makeTarget();
      const lookup = vi.fn(async () => [
        publicAnswer,
        { address: '2606:50c0:8000::154', family: 6 },
      ]);
      await cloneOrPull('https://git.example:8443/repo.git', target, undefined, { lookup, runGit });
      const args = runGit.mock.calls[0]?.[0] as string[];
      expect(args).toContain('https://git.example:8443/repo.git');
      expect(args).toContain(
        '-chttp.curloptResolve=git.example:8443:140.82.121.4,[2606:50c0:8000::154]',
      );
      expect(args).toContain('-cprotocol.allow=never');
      expect(args).toContain('-cprotocol.https.allow=always');
      expect(args).toContain('-cprotocol.http.allow=always');
      expect(args).toContain('-chttp.followRedirects=false');
      expect(lookup).toHaveBeenCalledWith('git.example', { all: true, verbatim: true });
      await fs.rm(parent, { recursive: true, force: true });
    });

    it('refuses hostname clones when DNS resolution fails', async () => {
      const runGit = vi.fn(async (_args: string[]) => {});
      const { target } = await makeTarget();
      await expect(
        cloneOrPull('https://git.example/repo.git', target, undefined, {
          lookup: async () => {
            throw new Error('DNS unavailable');
          },
          runGit,
        }),
      ).rejects.toThrow('Could not resolve git host');
      expect(runGit).not.toHaveBeenCalled();
    });
  });
});
