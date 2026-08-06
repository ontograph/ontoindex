import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/release-candidate.yml'),
  'utf8',
);
const stableWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/publish.yml'),
  'utf8',
);
const dockerWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/docker.yml'), 'utf8');

describe('release-candidate workflow', () => {
  it('uses tested allocation over npm versions and remote tags', () => {
    expect(workflow).toContain('git fetch --force --tags origin');
    expect(workflow).toContain('node scripts/resolve-rc-version.mjs');
    expect(workflow).not.toContain('/tmp/next_rc.mjs');
  });

  it('keeps incomplete releases resumable and marks completion only after verification', () => {
    const prepare = workflow.indexOf('- name: Prepare or resume release commit');
    const install = workflow.indexOf('- name: Install ontoindex dependencies');
    const reserve = workflow.indexOf('git push origin "refs/tags/$PENDING_TAG"');
    const publish = workflow.indexOf('npm publish --provenance --access public --tag rc');
    const release = workflow.indexOf('- name: Create GitHub prerelease');
    const verify = workflow.indexOf('- name: Verify public release state');
    const docker = workflow.indexOf('docker:\n    name: Build & Push RC Docker images');
    const finalize = workflow.indexOf(
      'finalize:\n    name: Mark verified release candidate complete',
    );
    const complete = workflow.indexOf('- name: Mark release complete', finalize);

    expect(reserve).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(install);
    expect(reserve).toBeLessThan(publish);
    expect(publish).toBeLessThan(release);
    expect(release).toBeLessThan(verify);
    expect(verify).toBeLessThan(docker);
    expect(docker).toBeLessThan(finalize);
    expect(finalize).toBeLessThan(complete);
    expect(workflow).toContain('needs: [guard, publish, docker]');
    expect(workflow).toContain(
      'git push --atomic origin "refs/tags/$COMPLETE_TAG" ":refs/tags/$PENDING_TAG"',
    );
  });

  it('does not treat npm transport failures as unpublished versions', () => {
    expect(workflow).toContain('npm registry unreachable for publication reconciliation');
    expect(workflow).toContain("grep -qiE 'E404|not found'");
  });

  it('prevents the stable tag workflow from republishing prereleases', () => {
    expect(
      stableWorkflow.match(/if: \$\{\{ !contains\(github\.ref_name, '-'\) \}\}/g),
    ).toHaveLength(2);
    expect(dockerWorkflow).toContain(
      "if: ${{ inputs.tag != '' || !contains(github.ref_name, '-') }}",
    );
  });
});
