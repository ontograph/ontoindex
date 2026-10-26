import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
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
const ciWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const testsWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/ci-tests.yml'),
  'utf8',
);

describe('release-candidate workflow', () => {
  it('selects Linux-only CI for release candidates while preserving the ordinary matrix', () => {
    type Workflow = {
      on: { workflow_call: { inputs: { linux_only: { type: string; default: boolean } } } };
      jobs: Record<
        string,
        {
          uses?: string;
          with?: Record<string, unknown>;
          strategy?: { matrix: { os: string; node: number[] } };
          'runs-on'?: string;
        }
      >;
    };
    const ci = load(ciWorkflow) as Workflow;
    const tests = load(testsWorkflow) as Workflow;
    const rc = load(workflow) as Workflow;

    for (const reusable of [ci, tests]) {
      expect(reusable.on.workflow_call.inputs.linux_only).toMatchObject({
        type: 'boolean',
        default: false,
      });
    }
    expect(rc.jobs.ci).toMatchObject({
      uses: './.github/workflows/ci.yml',
      with: { linux_only: true },
    });
    expect(ci.jobs.tests).toMatchObject({
      uses: './.github/workflows/ci-tests.yml',
      with: { linux_only: '${{ inputs.linux_only }}' },
    });
    expect(tests.jobs['runtime-matrix'].strategy?.matrix).toEqual({
      os: '${{ fromJSON(inputs.linux_only && \'["ubuntu-latest"]\' || \'["ubuntu-latest","windows-latest","macos-latest"]\') }}',
      node: [22],
    });
    expect(tests.jobs['runtime-matrix']['runs-on']).toBe('${{ matrix.os }}');
  });

  it('uses tested allocation over npm versions and remote tags', () => {
    expect(workflow).toContain('git fetch --force --tags origin');
    expect(workflow).toContain('node scripts/resolve-rc-version.mjs');
    expect(workflow).not.toContain('/tmp/next_rc.mjs');
  });

  it('keeps incomplete releases resumable and marks completion only after verification', () => {
    const prepare = workflow.indexOf('- name: Prepare or resume release commit');
    const install = workflow.indexOf('- name: Install ontoindex dependencies');
    const reserve = workflow.indexOf('git push origin "refs/tags/$PENDING_TAG"');
    const publish = workflow.indexOf(
      'npm publish "../ontoindex-$RC_VERSION.tgz" --provenance --access public --tag rc',
    );
    const release = workflow.indexOf('- name: Create GitHub prerelease');
    const verify = workflow.indexOf('- name: Verify public release state');
    const finalize = workflow.indexOf(
      'finalize:\n    name: Mark verified release candidate complete',
    );
    const complete = workflow.indexOf('- name: Mark release complete', finalize);

    expect(reserve).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(-1);
    expect(finalize).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(install);
    expect(reserve).toBeLessThan(publish);
    expect(publish).toBeLessThan(release);
    expect(release).toBeLessThan(verify);
    expect(verify).toBeLessThan(finalize);
    expect(finalize).toBeLessThan(complete);
    expect(workflow).toContain('needs: [guard, publish]');
    expect(workflow).not.toMatch(/^\s*docker:/m);
    expect(workflow).not.toMatch(/\bdocker\s+/);
    expect(workflow).toContain(
      'git push --atomic origin "refs/tags/$COMPLETE_TAG" ":refs/tags/$PENDING_TAG"',
    );
  });

  it('does not treat npm transport failures as unpublished versions', () => {
    expect(workflow).toContain('npm registry unreachable for publication reconciliation');
    expect(workflow).toContain("grep -qiE 'E404|not found'");
  });

  it('smoke-tests one packed artifact before publishing and verifies RC resume integrity', () => {
    for (const source of [workflow, stableWorkflow]) {
      expect(source.match(/run: npm pack --pack-destination \..*/g)).toHaveLength(1);
      const smoke = source.indexOf('- name: Smoke-test installed release artifact');
      const publish = source.indexOf('npm publish "../ontoindex-', smoke);
      expect(smoke).toBeGreaterThan(-1);
      expect(publish).toBeGreaterThan(smoke);
      expect(source).toContain('"$SMOKE_DIR/node_modules/.bin/ontoindex" watch --help');
    }
    expect(workflow).toContain('npm view "ontoindex@$RC_VERSION" dist.integrity');
    expect(workflow).toContain('[ "$PUBLISHED_INTEGRITY" = "$EXPECTED_INTEGRITY" ]');
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
