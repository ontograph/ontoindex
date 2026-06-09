import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractCppPosixResourceFacts } from '../../src/core/systems-audit/index.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures/systems-audit');

function extract(source: string, filePath = 'fixture.cc') {
  return extractCppPosixResourceFacts({
    source,
    filePath,
    fileHash: `hash:${filePath}`,
    sourceIndexId: 'index-1',
    sourceCommitHash: 'commit-1',
    graphSchemaVersion: 1,
    processIdentity: 'process:test',
  });
}

describe('C/C++ POSIX resource extractor', () => {
  it('detects pipe without atomic CLOEXEC and recognizes pipe2(O_CLOEXEC)', () => {
    const source = readFileSync(path.join(fixturesDir, 'pipe-cloexec.cpp'), 'utf8');
    const record = extract(source, 'pipe-cloexec.cpp');

    expect(record.findings.map((finding) => finding.id)).toContain(
      'pipe-cloexec:pipe-cloexec.cpp:3:fds',
    );
    expect(record.findings.map((finding) => finding.id)).not.toContain(
      'pipe-cloexec:pipe-cloexec.cpp:10:fds',
    );
    expect(record.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'systems-audit-resource-handle',
          localName: 'fds[0]',
          closeOnExec: 'yes',
        }),
      ]),
    );
  });

  it('extracts open, close, fork child unsafe region, exec, and waitpid events', () => {
    const source = readFileSync(path.join(fixturesDir, 'fork-failure.cpp'), 'utf8');
    const record = extract(source, 'fork-failure.cpp');

    expect(record.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventKind: 'allocate', mechanism: 'open' }),
        expect.objectContaining({ eventKind: 'fork', mechanism: 'fork', status: 'partial' }),
        expect.objectContaining({ eventKind: 'exec', mechanism: 'exec', status: 'partial' }),
        expect.objectContaining({ eventKind: 'wait', mechanism: 'waitpid' }),
        expect.objectContaining({ eventKind: 'release', mechanism: 'close' }),
      ]),
    );
  });

  it('extracts socket, dup variants, fcntl FD_CLOEXEC, and pidfd unresolved identity', () => {
    const record = extract(`
      int sock = socket(AF_INET, SOCK_STREAM, 0);
      int copy = dup(sock);
      dup2(copy, 7);
      dup3(sock, 8, O_CLOEXEC);
      fcntl(sock, F_SETFD, FD_CLOEXEC);
      int pfd = pidfd_getfd(pidfd, 4, 0);
      close(sock);
    `);

    expect(record.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceKind: 'socket', mechanism: 'socket' }),
        expect.objectContaining({ eventKind: 'duplicate', mechanism: 'dup' }),
        expect.objectContaining({ eventKind: 'duplicate', mechanism: 'dup2' }),
        expect.objectContaining({ eventKind: 'duplicate', mechanism: 'dup3' }),
        expect.objectContaining({ eventKind: 'set-cloexec', mechanism: 'fcntl' }),
        expect.objectContaining({
          eventKind: 'pidfd',
          mechanism: 'pidfd_getfd',
          status: 'unresolved',
        }),
      ]),
    );
  });

  it('emits unresolved facts for wrapper-hidden ownership instead of guessing', () => {
    const record = extract('int fd = open_from_pool(path);');

    expect(record.status).toBe('partial');
    expect(record.skipReasons).toContain('wrapper-hidden ownership at fixture.cc:1');
    expect(record.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: 'unresolved',
          mechanism: 'wrapper-hidden-ownership',
          unresolved: ['wrapper-hidden ownership unresolved'],
        }),
      ]),
    );
  });

  it('emits unsupported facts for out-of-scope transfer and spawn mechanisms', () => {
    const record = extract('sendmsg(sock, &msg, 0); posix_spawn(&pid, path, 0, 0, argv, envp);');

    expect(record.skipReasons).toEqual(
      expect.arrayContaining([
        'unsupported sendmsg at fixture.cc:1',
        'unsupported posix_spawn at fixture.cc:1',
      ]),
    );
    expect(record.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventKind: 'unsupported', mechanism: 'sendmsg' }),
        expect.objectContaining({ eventKind: 'unsupported', mechanism: 'posix_spawn' }),
      ]),
    );
  });

  it('keeps numeric fd values as local handles', () => {
    const record = extract('dup2(fd, 3); close(3);');

    expect(record.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'systems-audit-resource-handle',
          localName: '3',
          fdNumber: 3,
          handleId: 'process:test:handle:3',
        }),
      ]),
    );
  });
});
