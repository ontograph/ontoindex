import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION,
  parseRetrievalReplayCase,
  validateRetrievalReplayCase,
} from '../../src/core/search/replay/replay-case.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures/retrieval-replay');
const fixtureFiles = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('retrieval replay fixture corpus', () => {
  it('has fixture JSON corpus', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const fixtureFile of fixtureFiles) {
    it(`validates ${fixtureFile}`, () => {
      const rawFixture = JSON.parse(
        readFileSync(path.join(fixturesDir, fixtureFile), 'utf8'),
      );
      const validation = validateRetrievalReplayCase(rawFixture);
      const validationMessage = validation.ok
        ? ''
        : validation.errors
            ?.map((error) => `${error.path}: ${error.message ?? error.msg}`)
            .join('; ');

      expect(validation.ok, validationMessage).toBe(true);

      const parsedFixture = parseRetrievalReplayCase(rawFixture);
      expect(parsedFixture.schemaVersion).toBe(RETRIEVAL_REPLAY_CASE_SCHEMA_VERSION);
      expect(parsedFixture.id).toBeTruthy();
    });
  }
});
