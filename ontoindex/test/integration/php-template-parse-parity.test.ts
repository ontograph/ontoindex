import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo, type PipelineOptions } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const fixtures: Record<string, string> = {
  'plain-html.php': '<!-- component -->\n<div class="report"><table></table></div>',
  'plain-js.php':
    "if (typeof window.ndsAssessmentTestState !== 'function') { window.ndsAssessmentTestState = function () {}; }",
  'tagless-valid.php': 'function tagless_fragment(): int { return 42; }',
  'tagless-invalid.php': 'function broken_fragment( { return $value; }',
  'tagless-missing-semicolon.php': '$x = foo()',
  'tagless-js-string-signal.php': '$x = "typeof window"',
  'tagless-js-comment-signal.php': '$x = 1; // window.foo\n$x = foo()',
  'tagless-php-typeof-signal.php': '$x = typeof window',
  'tagless-php-member-signal.php': '$x = window.foo',
  'plain-js-optional-chain.php': 'window?.ndsAssessmentTestState?.()',
  'tagged.php': '<?php function tagged_fragment(): int { return 43; } ?>',
  'mixed.php': '<!-- template --><div><?= htmlspecialchars($title) ?></div>',
};

describe('PHP template parsing parity', () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('keeps HTML/JS templates clean and reports invalid tagless PHP in both parser paths', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-php-template-'));
    for (const [name, content] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(directory, name), content);
    }

    async function run(skipWorkers: boolean): Promise<{
      result: PipelineResult;
      parseErrors: string[];
    }> {
      const parseErrors: string[] = [];
      const options: PipelineOptions = {
        skipGraphPhases: true,
        skipWorkers,
        ...(skipWorkers ? {} : { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } }),
        onTelemetry(event) {
          if (event.event === 'parse-error-files') {
            parseErrors.push(...(event.parseErrorFiles ?? []));
          }
        },
      };
      const result = await runPipelineFromRepo(directory!, () => {}, options);
      expect(result.usedWorkerPool).toBe(!skipWorkers);
      return { result, parseErrors };
    }

    const sequential = await run(true);
    const worker = await run(false);
    expect(sequential.parseErrors).toHaveLength(6);
    expect(sequential.parseErrors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/tagless-invalid\.php$/),
        expect.stringMatching(/tagless-missing-semicolon\.php$/),
        expect.stringMatching(/tagless-js-string-signal\.php$/),
        expect.stringMatching(/tagless-js-comment-signal\.php$/),
        expect.stringMatching(/tagless-php-typeof-signal\.php$/),
        expect.stringMatching(/tagless-php-member-signal\.php$/),
      ]),
    );
    expect(worker.parseErrors).toHaveLength(6);
    expect(worker.parseErrors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/tagless-invalid\.php$/),
        expect.stringMatching(/tagless-missing-semicolon\.php$/),
        expect.stringMatching(/tagless-js-string-signal\.php$/),
        expect.stringMatching(/tagless-js-comment-signal\.php$/),
        expect.stringMatching(/tagless-php-typeof-signal\.php$/),
        expect.stringMatching(/tagless-php-member-signal\.php$/),
      ]),
    );

    for (const result of [sequential.result, worker.result]) {
      const functionNames = [...result.graph.iterNodes()]
        .filter((node) => node.label === 'Function')
        .map((node) => node.properties.name);
      expect(functionNames).toContain('tagless_fragment');
      expect(functionNames).toContain('tagged_fragment');
    }
  }, 120_000);
});
