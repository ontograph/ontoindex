import { describe, expect, it } from 'vitest';
import { resolveRcVersion } from '../../scripts/resolve-rc-version.mjs';

const headSha = 'abc123';

describe('resolveRcVersion', () => {
  it('continues from remote tags when npm has no release candidates', () => {
    expect(
      resolveRcVersion({
        latestVersion: '2.1.4',
        publishedVersions: [],
        gitTags: ['v2.1.4', 'v2.1.5-rc.1'],
        headSha,
      }),
    ).toMatchObject({ rcVersion: '2.1.5-rc.2', resume: false });
  });

  it('uses the highest counter across npm and git', () => {
    expect(
      resolveRcVersion({
        latestVersion: '2.1.4',
        publishedVersions: ['2.1.5-rc.2'],
        gitTags: ['v2.1.5-rc.4'],
        headSha,
      }),
    ).toMatchObject({ rcVersion: '2.1.5-rc.5' });
  });

  it('treats another commit pending marker as an occupied version', () => {
    expect(
      resolveRcVersion({
        latestVersion: '2.1.4',
        gitTags: ['rc-pending/older/v2.1.5-rc.4'],
        headSha,
      }),
    ).toMatchObject({ rcVersion: '2.1.5-rc.5', resume: false });
  });

  it('ignores malformed and unrelated tags', () => {
    expect(
      resolveRcVersion({
        latestVersion: '2.1.4',
        publishedVersions: ['garbage'],
        gitTags: ['v2.1.5-rc.nope', 'release/2.1.5-rc.9', 'v1.0.0'],
        headSha,
      }),
    ).toMatchObject({ rcVersion: '2.1.5-rc.1' });
  });

  it('resumes the version recorded by a pending marker', () => {
    expect(
      resolveRcVersion({
        latestVersion: '2.1.4',
        publishedVersions: ['2.1.5-rc.2'],
        gitTags: [`rc-pending/${headSha}/v2.1.5-rc.2`, 'v2.1.5-rc.2'],
        headSha,
      }),
    ).toEqual({
      base: '2.1.5',
      rcN: 2,
      rcVersion: '2.1.5-rc.2',
      vtag: 'v2.1.5-rc.2',
      pendingTag: `rc-pending/${headSha}/v2.1.5-rc.2`,
      completeTag: `rc-complete/${headSha}/v2.1.5-rc.2`,
      resume: true,
    });
  });

  it('fails closed when one commit has multiple pending releases', () => {
    expect(() =>
      resolveRcVersion({
        latestVersion: '2.1.4',
        gitTags: [`rc-pending/${headSha}/v2.1.5-rc.2`, `rc-pending/${headSha}/v2.1.5-rc.3`],
        headSha,
      }),
    ).toThrow('multiple pending rc markers');
  });

  it('does not resume a pending marker that already has a completion marker', () => {
    expect(
      resolveRcVersion({
        latestVersion: '2.1.4',
        gitTags: [
          `rc-pending/${headSha}/v2.1.5-rc.2`,
          `rc-complete/${headSha}/v2.1.5-rc.2`,
          'v2.1.5-rc.2',
        ],
        headSha,
      }),
    ).toMatchObject({ rcVersion: '2.1.5-rc.3', resume: false });
  });

  it.each([
    ['patch', '2.1.5-rc.9'],
    ['minor', '2.2.0-rc.1'],
    ['major', '3.0.0-rc.1'],
  ])('honors an explicit %s cycle reset', (bump, rcVersion) => {
    expect(
      resolveRcVersion({
        latestVersion: '2.1.4',
        publishedVersions: ['2.1.5-rc.8'],
        bump,
        eventName: 'workflow_dispatch',
        headSha,
      }),
    ).toMatchObject({ rcVersion });
  });
});
