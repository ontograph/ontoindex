import { describe, expect, it } from 'vitest';

import { runConcurrencyAudit } from '../../src/core/systems-audit/concurrency-audit.js';

describe('systems concurrency audit', () => {
  it('detects lock declarations, scopes, and pressure calls under locks', () => {
    const report = runConcurrencyAudit({
      filePath: 'src/worker.cc',
      symbol: 'runWorker',
      source: `
pthread_mutex_t globalLock;
std::mutex queueLock;
void runWorker() {
  pthread_mutex_lock(&globalLock);
  read(fd, buf, n);
  malloc(128);
  pthread_mutex_unlock(&globalLock);
}
`,
    });

    expect(report.version).toBe(1);
    expect(report.tool).toBe('gn_concurrency_audit');
    expect(report.sidecarRecordKind).toBe('systems.concurrency');
    expect(report.provenance).toMatchObject({
      analyzerId: 'gn_concurrency_audit',
      sidecarRecordKind: 'systems.concurrency',
      source: 'bounded-static-heuristic',
    });
    expect(report.lockDeclarations.map((declaration) => declaration.lockName)).toEqual([
      'globalLock',
      'queueLock',
    ]);
    expect(report.lockScopes[0]).toMatchObject({
      lockName: 'globalLock',
      acquisitionLine: 5,
      releaseLine: 8,
    });
    expect(report.lockScopes[0].hazards.map((hazard) => hazard.reasonCode)).toEqual([
      'io-under-lock',
      'allocation-under-lock',
    ]);
    expect(report.findings.every((finding) => finding.falsePositiveNote)).toBe(true);
    expect(report.systemsEvidence.every((item) => item.reasonCode)).toBe(true);
  });

  it('summarizes nested locks and possible lock-order inversions', () => {
    const report = runConcurrencyAudit({
      filePath: 'src/order.cc',
      source: `
std::mutex a;
std::mutex b;
void first() {
  a.lock();
  b.lock();
  b.unlock();
  a.unlock();
}
void second() {
  b.lock();
  a.lock();
  a.unlock();
  b.unlock();
}
`,
    });

    expect(report.lockOrderEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outerLockName: 'a', innerLockName: 'b' }),
        expect.objectContaining({ outerLockName: 'b', innerLockName: 'a' }),
      ]),
    );
    expect(report.lockInversionRisk).toMatchObject({
      status: 'possible',
      pairs: [expect.objectContaining({ firstLockName: 'a', secondLockName: 'b' })],
    });
    expect(report.findings.map((finding) => finding.reasonCode)).toContain('lock-order-inversion');
  });

  it('does not treat weak_ptr lock as a definite mutex acquisition', () => {
    const report = runConcurrencyAudit({
      filePath: 'src/session.cc',
      source: `
std::weak_ptr<Session> weakSession;
std::mutex directMutex;
std::mutex guardMutex;
std::mutex uniqueMutex;
void inspect() {
  if (auto session = weakSession.lock()) {
    read(fd, buf, n);
  }
  directMutex.lock();
  write(fd, buf, n);
  directMutex.unlock();
  {
    std::lock_guard<std::mutex> guard(guardMutex);
    malloc(16);
  }
  {
    std::unique_lock<std::mutex> unique(uniqueMutex);
    sleep(1);
  }
}
`,
    });

    expect(report.lockScopes.map((scope) => scope.lockName)).toEqual([
      'directMutex',
      'guardMutex',
      'uniqueMutex',
    ]);
    expect(report.lockScopes.map((scope) => scope.acquisitionMechanism)).toEqual([
      'lock-method',
      'raii-guard',
      'raii-guard',
    ]);
    expect(report.lockScopes.some((scope) => scope.lockName === 'weakSession')).toBe(false);
    expect(report.findings.map((finding) => finding.message)).not.toContain(
      'read occurs while lock weakSession is held',
    );
    expect(report.warnings).toEqual([
      expect.stringContaining("unsupported lock() receiver 'weakSession'"),
    ]);
  });

  it('bounds findings and evidence', () => {
    const report = runConcurrencyAudit({
      filePath: 'src/bounded.cc',
      maxFindings: 1,
      maxEvidence: 2,
      source: `
pthread_mutex_t m;
void f() {
  pthread_mutex_lock(&m);
  sleep(1);
  read(fd, buf, n);
  malloc(16);
  pthread_mutex_unlock(&m);
}
`,
    });

    expect(report.status).toBe('partial');
    expect(report.findings).toHaveLength(1);
    expect(report.systemsEvidence.length).toBeLessThanOrEqual(2);
    expect(report.limits).toMatchObject({
      maxFindings: 1,
      maxEvidence: 2,
      truncated: true,
    });
  });
});
