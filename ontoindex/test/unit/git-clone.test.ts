import { describe, it, expect, vi } from 'vitest';
import {
  extractRepoName,
  getCloneDir,
  validateGitUrl,
  cloneOrPull,
} from '../../src/server/git-clone.js';
import type { LookupAddress } from 'node:dns';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('git-clone', () => {
  describe('extractRepoName', () => {
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
      const runGit = vi.fn(async (_args: string[]) => {});
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
