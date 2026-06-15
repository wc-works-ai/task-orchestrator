import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { formatOverview, formatRunSummary, printOverview, printRunSummary } from '../../src/engine/runReport.js';
import { openStateDb, seed, setupTestDir, type SeedOpts } from '../shared/helpers.js';

function seedAll(dir: string, specs: Array<[number, string, SeedOpts]>): void {
  const { db } = openStateDb(dir);
  try {
    for (const [n, name, opts] of specs) seed(db, dir, n, name, opts);
  } finally {
    db.close();
  }
}

describe('RunReport', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('formats an end-of-run summary with counts, icons, and attempts', async () => {
    dir = setupTestDir('.test-run-report-');
    seedAll(dir, [
      [3, 'done', { status: 'CONVERGED', failures: 2 }],
      [7, 'blocked', { status: 'BLOCKED', failures: 5 }],
      [9, 'failed', { status: 'FAILED', failures: 1 }],
      [2, 'pending', { status: 'PENDING' }],
      [10, 'running', { status: 'IN_PROGRESS', claimedBy: 'test' }],
    ]);

    await expect(formatRunSummary(dir, 24)).resolves.toEqual([
      'Summary: converged=1 failed=1 blocked=1 pending=1 in_progress=1 (24 ticks)',
      '  ⬜ T2 pending',
      '  🚫 T7 blocked  attempts=5',
      '  ❌ T9 failed  attempts=1',
      '  🔄 T10 in_progress  attempts=0',
    ]);
  });

  it('formats a per-tick overview with the running task and counts', async () => {
    dir = setupTestDir('.test-run-report-');
    seedAll(dir, [
      [5, 'running', { status: 'IN_PROGRESS', claimedBy: 'test' }],
      [6, 'done', { status: 'CONVERGED' }],
      [7, 'blocked', { status: 'BLOCKED' }],
      [8, 'failed', { status: 'FAILED' }],
      [9, 'pending', { status: 'PENDING' }],
    ]);

    await expect(formatOverview(dir, 24)).resolves.toBe(
      'Overview: running=T5 converged=1 failed=1 blocked=1 pending=1 (tick 24)',
    );
  });

  it('prints overview and summary lines', async () => {
    dir = setupTestDir('.test-run-report-');
    seedAll(dir, [[1, 'pending', { status: 'PENDING' }]]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await printOverview(dir, 7);
      await printRunSummary(dir, 7);

      expect(logSpy.mock.calls.map(([line]) => line)).toEqual([
        'Overview: running=none converged=0 failed=0 blocked=0 pending=1 (tick 7)',
        'Summary: converged=0 failed=0 blocked=0 pending=1 in_progress=0 (7 ticks)',
        '  ⬜ T1 pending',
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('counts converged tasks in the overview and summary', async () => {
    dir = setupTestDir('.test-run-report-');
    seedAll(dir, [
      [1, 'old', { status: 'CONVERGED' }],
      [2, 'archived-task', { status: 'CONVERGED' }],
    ]);

    await expect(formatOverview(dir, 5)).resolves.toContain('converged=2');
    await expect(formatRunSummary(dir, 5)).resolves.toEqual([
      'Summary: converged=2 failed=0 blocked=0 pending=0 in_progress=0 (5 ticks)',
    ]);
  });
});
