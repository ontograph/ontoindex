import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadChecks } from '../../src/checks/loader.js';
import fs from 'fs/promises';

vi.mock('fs/promises');

describe('YAML Checks Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses valid YAML with checks correctly', async () => {
    const validYaml = `
checks:
  - id: chk-1
    type: impact-threshold
    args:
      target: "foo"
      max_d1: 10
  - id: chk-2
    type: custom-check
    args:
      strict: true
`;
    vi.mocked(fs.readFile).mockResolvedValue(validYaml);

    const result = await loadChecks('dummy.yaml');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'chk-1',
      type: 'impact-threshold',
      args: { target: 'foo', max_d1: 10 },
    });
    expect(result[1]).toEqual({
      id: 'chk-2',
      type: 'custom-check',
      args: { strict: true },
    });
  });

  it('throws a readable error for malformed YAML', async () => {
    const malformedYaml = `
checks:
  - id: chk-1
   type: missing-indent
`;
    vi.mocked(fs.readFile).mockResolvedValue(malformedYaml);

    await expect(loadChecks('dummy.yaml')).rejects.toThrow(/Failed to parse checks YAML/);
  });

  it('throws if a check is missing id or type', async () => {
    const missingFieldsYaml = `
checks:
  - id: chk-1
  - type: only-type
`;
    vi.mocked(fs.readFile).mockResolvedValue(missingFieldsYaml);

    await expect(loadChecks('dummy.yaml')).rejects.toThrow(
      /is missing required 'id' or 'type' fields/,
    );
  });

  it('returns empty array if no checks array is present', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(`other_key: true`);
    const result = await loadChecks('dummy.yaml');
    expect(result).toEqual([]);
  });
});
