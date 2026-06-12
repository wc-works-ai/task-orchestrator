import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatOverview, formatRunSummary, printOverview, printRunSummary } from '../src/RunReport.js';
import { Status, TaskState } from '../src/TaskState.js';

function setup(): string {
  const dir = mkdtempSync(resolve(tmpdir(), '.test-run-report-'));
  for (const shard of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(dir, shard), { recursive: true });
  }
  return dir;
}

function make(dir: string, n: number, name: string, status: Status | string, failures = 0): TaskState {
  const taskDir = resolve(dir, 'pending', `T${String(n).padStart(2, '0')}-${name}`);
  mkdirSync(taskDir, { recursive: true });
  const task = new TaskState(taskDir);
  task.status = status;
  if (failures > 0) writeFileSync(join(task.directory, '.failure_count'), `${failures}\n`);
  return task;
}

describe('RunReport', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('formats an end-of-run summary with counts, icons, and attempts', async () => {
    dir = setup();
    make(dir, 3, 'done', Status.CONVERGED, 2);
    make(dir, 7, 'blocked', Status.BLOCKED, 5);
    make(dir, 9, 'failed', Status.FAILED, 1);
    make(dir, 2, 'pending', Status.PENDING);
    make(dir, 10, 'running', 'IN_PROGRESS:test');

    await expect(formatRunSummary(dir, 24)).resolves.toEqual([
      'Summary: converged=1 failed=1 blocked=1 pending=1 in_progress=1 (24 ticks)',
      '  ⬜ T2 pending',
      '  🚫 T7 blocked  attempts=5',
      '  ❌ T9 failed  attempts=1',
      '  🔄 T10 in_progress  attempts=0',
    ]);
  });

  it('formats a per-tick overview with the running task and counts', async () => {
    dir = setup();
    make(dir, 5, 'running', 'IN_PROGRESS:test');
    make(dir, 6, 'done', Status.CONVERGED);
    make(dir, 7, 'blocked', Status.BLOCKED);
    make(dir, 8, 'failed', Status.FAILED);
    make(dir, 9, 'pending', Status.PENDING);

    await expect(formatOverview(dir, 24)).resolves.toBe(
      'Overview: running=T5 converged=1 failed=1 blocked=1 pending=1 (tick 24)',
    );
  });

  it('falls back to unknown icon and status for unexpected task states', async () => {
    dir = setup();
    make(dir, 1, 'mystery', 'BROKEN');

    await expect(formatRunSummary(dir, 3)).resolves.toEqual([
      'Summary: converged=0 failed=0 blocked=0 pending=0 in_progress=0 (3 ticks)',
      '  ❓ T1 unknown  attempts=0',
    ]);
    await expect(formatOverview(dir, 3)).resolves.toBe(
      'Overview: running=none converged=0 failed=0 blocked=0 pending=0 (tick 3)',
    );
  });

  it('prints overview and summary lines', async () => {
    dir = setup();
    make(dir, 1, 'pending', Status.PENDING);
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

  it('counts archived converged tasks in the overview and summary', async () => {
    dir = setup();
    // One converged dir + one archived line
    const { mkdirSync: mds, writeFileSync: wfs } = await import('node:fs');
    mds(resolve(dir, 'converged', 'T02-archived-task'), { recursive: true });
    wfs(resolve(dir, 'converged', '.archive.jsonl'), '{"T":1,"name":"T01-old"}\n');

    await expect(formatOverview(dir, 5)).resolves.toContain('converged=2');
    await expect(formatRunSummary(dir, 5)).resolves.toEqual([
      'Summary: converged=2 failed=0 blocked=0 pending=0 in_progress=0 (5 ticks)',
    ]);
  });
});
