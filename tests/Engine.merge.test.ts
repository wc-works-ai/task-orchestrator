import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Engine } from '../src/Engine.js';
import { Worktree } from '../src/Worktree.js';
import { TaskState, type TaskInfo } from '../src/TaskState.js';

const LOCK = '.orchestrator-merge-lock';

/** Real git repo + a single converging task. The agent makes a non-overlapping
 *  change in the worktree and never advances the base, so syncWithBase is a
 *  clean no-op and the merge path is exercised without a real conflict. */
function scenario(dir: string) {
  const repoDir = resolve(dir, 'repo');
  const tasksDir = resolve(dir, 'tasks');
  const worktreesDir = resolve(dir, 'worktrees');
  mkdirSync(repoDir, { recursive: true });
  execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });
  for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(tasksDir, s), { recursive: true });
  }
  const d = resolve(tasksDir, 'pending', 'T01-x');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, '.status'), 'PENDING\n');

  const spawn = vi.fn().mockImplementation(async (_t: TaskState, wtPath?: string) => {
    if (!wtPath) throw new Error('missing worktree path');
    writeFileSync(join(wtPath, 'work.txt'), 'work');
    execSync('git add work.txt && git commit -m "work"', { cwd: wtPath });
    return { success: true, iterations: 1 };
  });
  return { repoDir, tasksDir, worktreesDir, spawn };
}

function scenarioWithTwoTasks(dir: string) {
  const repoDir = resolve(dir, 'repo');
  const tasksDir = resolve(dir, 'tasks');
  const worktreesDir = resolve(dir, 'worktrees');
  mkdirSync(repoDir, { recursive: true });
  execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });
  for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(tasksDir, s), { recursive: true });
  }
  for (const taskName of ['T01-a', 'T02-b']) {
    const d = resolve(tasksDir, 'pending', taskName);
    mkdirSync(d, { recursive: true });
    writeFileSync(resolve(d, '.status'), 'PENDING\n');
  }

  const spawn = vi.fn().mockImplementation(async (task: TaskState, wtPath?: string) => {
    if (!wtPath) throw new Error('missing worktree path');
    writeFileSync(join(wtPath, `work-${task.taskNumber}.txt`), `work-${task.taskNumber}`);
    execSync(`git add work-${task.taskNumber}.txt && git commit -m "work-${task.taskNumber}"`, { cwd: wtPath });
    return { success: true, iterations: 1 };
  });
  return { repoDir, tasksDir, worktreesDir, spawn };
}

function writeLock(repoDir: string, startedMs: number): void {
  const lockDir = join(repoDir, LOCK);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner'), `pid:999999\nhost:other\nstarted:${startedMs}\n`);
}

function readLockToken(repoDir: string): string {
  return readFileSync(join(repoDir, LOCK, 'owner'), 'utf-8').match(/token:(.+)/)?.[1] ?? '';
}

describe('Engine merge robustness', () => {
  let dir = '';
  beforeEach(() => {
    const root = resolve('test-artifacts');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(resolve(root, 'eng-merge-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('defers the merge when another orchestrator holds the merge lock', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();            // cz=1
    await engine.tick();            // cz=2
    writeLock(repoDir, Date.now()); // fresh lock held by another orchestrator
    const r = await engine.tick();  // cz=3 → merge deferred

    expect(r.converged).toBe(false);
    const t = (await TaskState.scan(tasksDir)).get('1')!;
    expect(t.isInProgress).toBe(true);  // not blocked, not converged — will retry
    expect(t.isBlocked).toBe(false);
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(true); // worktree kept
  });

  it('breaks a stale merge lock and completes the merge', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();
    await engine.tick();
    writeLock(repoDir, Date.now() - 700_000); // older than the 600s default ceiling
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(existsSync(join(repoDir, 'work.txt'))).toBe(true); // merged into base
    expect(existsSync(join(repoDir, LOCK))).toBe(false);      // lock released
  });

  it('treats a stale lock with a missing owner file as breakable', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();
    await engine.tick();
    mkdirSync(join(repoDir, LOCK), { recursive: true });
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(existsSync(join(repoDir, 'work.txt'))).toBe(true);
    expect(existsSync(join(repoDir, LOCK))).toBe(false);
  });

  it('backs off when another process wins after stale-lock break', async () => {
    vi.resetModules();
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    writeLock(repoDir, Date.now() - 700_000);

    try {
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        let lockReads = 0;
        return {
          ...actual,
          readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) => {
            const file = String(path);
            if (file.endsWith(`${LOCK}\\owner`) || file.endsWith(`${LOCK}/owner`)) {
              lockReads++;
              if (lockReads === 1) {
                return 'pid:999999\nhost:other\n';
              }
              if (lockReads === 2) {
                return `pid:999999\nhost:other\nstarted:${Date.now()}\n`;
              }
            }
            return actual.readFileSync(path, options as never);
          }),
        };
      });
      const { Engine: MockedEngine } = await import('../src/Engine.js');
      const engine = new MockedEngine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

      await engine.tick();
      await engine.tick();
      const r = await engine.tick();

      expect(r.converged).toBe(false);
      expect((await TaskState.scan(tasksDir)).get('1')!.isInProgress).toBe(true);
      expect(existsSync(join(repoDir, LOCK))).toBe(true);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('returns locked when stale-lock re-acquire loses the mkdir race', async () => {
    vi.resetModules();
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    writeLock(repoDir, Date.now() - 700_000);

    try {
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        let lockMkdirCalls = 0;
        return {
          ...actual,
          mkdirSync: vi.fn((path: Parameters<typeof actual.mkdirSync>[0], options?: Parameters<typeof actual.mkdirSync>[1]) => {
            const file = String(path);
            if (file.endsWith(LOCK)) {
              lockMkdirCalls++;
              if (lockMkdirCalls <= 2) throw new Error('EEXIST');
            }
            return actual.mkdirSync(path, options as never);
          }),
        };
      });
      const { Engine: MockedEngine } = await import('../src/Engine.js');
      const engine = new MockedEngine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

      await engine.tick();
      await engine.tick();
      const r = await engine.tick();

      expect(r.converged).toBe(false);
      expect((await TaskState.scan(tasksDir)).get('1')!.isInProgress).toBe(true);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('blocks the task when merge recovery itself throws', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const syncSpy = vi.spyOn(Worktree.prototype, 'syncWithBase').mockRejectedValue(new Error('sync failed'));
    const engine = new Engine(tasksDir, {
      benchmark,
      spawn,
      repoDir,
      worktreesDir,
      mergeRecovery: () => { throw new Error('recovery exploded'); },
    });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(false);
    expect((await TaskState.scan(tasksDir)).get('1')!.isBlocked).toBe(true);
    syncSpy.mockRestore();
  });

  it('blocks the task when auto-stash retry throws', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const syncSpy = vi.spyOn(Worktree.prototype, 'syncWithBase').mockRejectedValue(new Error('sync failed'));
    const stashSpy = vi.spyOn(Worktree.prototype, 'stashParentChanges').mockRejectedValue(new Error('stash exploded'));
    const engine = new Engine(tasksDir, {
      benchmark,
      spawn,
      repoDir,
      worktreesDir,
      mergeRecovery: () => 'stash-and-retry',
    });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(false);
    expect((await TaskState.scan(tasksDir)).get('1')!.isBlocked).toBe(true);
    syncSpy.mockRestore();
    stashSpy.mockRestore();
  });

  it('logs the no-op auto-stash retry path and merges on retry', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const syncSpy = vi.spyOn(Worktree.prototype, 'syncWithBase')
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockResolvedValueOnce(undefined);
    const engine = new Engine(tasksDir, {
      benchmark,
      spawn,
      repoDir,
      worktreesDir,
      mergeRecovery: () => 'stash-and-retry',
    });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(existsSync(join(repoDir, 'work.txt'))).toBe(true);
    syncSpy.mockRestore();
  });

  it('covers the clean pre-merge auto-stash branch', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const stashSpy = vi.spyOn(Worktree.prototype, 'stashParentChanges').mockResolvedValue(false);
    const engine = new Engine(tasksDir, {
      benchmark,
      spawn,
      repoDir,
      worktreesDir,
      autoStashBeforeMerge: true,
    });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    stashSpy.mockRestore();
  });

  it('blocks the task on a plain-string merge failure without recovery', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const syncSpy = vi.spyOn(Worktree.prototype, 'syncWithBase').mockRejectedValue('plain string merge failure');
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(false);
    expect((await TaskState.scan(tasksDir)).get('1')!.isBlocked).toBe(true);
    syncSpy.mockRestore();
  });

  it('keeps a newer fenced merge lock when a stale holder releases late', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenarioWithTwoTasks(dir);
    const runs = new Map<number, number>();
    const benchmark = vi.fn(async (task: TaskInfo) => {
      const taskNumber = parseInt(task.directory.match(/T(\d+)-/)?.[1] ?? '0', 10);
      const count = (runs.get(taskNumber) ?? 0) + 1;
      runs.set(taskNumber, count);
      return count === 1 ? 1 : 0;
    });
    const engine1 = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir, instanceId: 'engine-1', autoStashBeforeMerge: false });
    const engine2 = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir, instanceId: 'engine-2', autoStashBeforeMerge: false });

    await engine1.tick();
    await engine2.tick();
    await engine1.tick();
    await engine2.tick();

    let syncCalls = 0;
    let signalFirstSync = () => {};
    const firstSyncEntered = new Promise<void>((resolveFirst) => {
      signalFirstSync = resolveFirst;
    });
    let releaseFirstSync = () => {};
    const firstSyncGate = new Promise<void>((resolveFirst) => {
      releaseFirstSync = resolveFirst;
    });
    let signalSecondSync = () => {};
    const secondSyncEntered = new Promise<void>((resolveSecond) => {
      signalSecondSync = resolveSecond;
    });
    let releaseSecondSync = () => {};
    const secondSyncGate = new Promise<void>((resolveSecond) => {
      releaseSecondSync = resolveSecond;
    });

    vi.spyOn(Worktree.prototype, 'syncWithBase').mockImplementation(async () => {
      syncCalls++;
      if (syncCalls === 1) {
        signalFirstSync();
        await firstSyncGate;
        throw new Error('late stale holder');
      }
      if (syncCalls === 2) {
        signalSecondSync();
        await secondSyncGate;
      }
    });

    const firstMerge = engine1.tick();
    await firstSyncEntered;
    const firstToken = readLockToken(repoDir);
    writeFileSync(
      join(repoDir, LOCK, 'owner'),
      `pid:999999\nhost:other\nstarted:${Date.now() - 700_000}\ntoken:${firstToken}\n`,
    );

    const secondMerge = engine2.tick();
    await secondSyncEntered;
    const secondToken = readLockToken(repoDir);

    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    releaseFirstSync();
    await expect(firstMerge).resolves.toMatchObject({ converged: false, metric: 0 });
    expect(existsSync(join(repoDir, LOCK))).toBe(true);
    expect(readLockToken(repoDir)).toBe(secondToken);

    releaseSecondSync();
    await expect(secondMerge).resolves.toMatchObject({ converged: true, metric: 0 });
    expect(existsSync(join(repoDir, LOCK))).toBe(false);
  }, 15_000);

  it('sends the task back to the agent when base drift breaks acceptance after sync', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    // pre, post (tick1), tick2, tick3, then the post-sync re-verify reports
    // non-zero → rework; anything after stays 0.
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0).mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1).mockResolvedValue(0);
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(false);
    const t = (await TaskState.scan(tasksDir)).get('1')!;
    expect(t.isInProgress).toBe(true);  // not blocked — the agent gets another pass
    expect(t.convergenceCount).toBe(0); // reset so acceptance must be re-proven
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(true); // worktree kept
  });

  it('heartbeats during the pre-spawn benchmark before the agent starts', async () => {
    vi.useFakeTimers();
    const tasksDir = resolve(dir, 'tasks');
    for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
      mkdirSync(resolve(tasksDir, s), { recursive: true });
    }
    const d = resolve(tasksDir, 'pending', 'T01-heartbeat');
    mkdirSync(d, { recursive: true });
    writeFileSync(resolve(d, '.status'), 'PENDING\n');

    const heartbeat = vi.spyOn(TaskState.prototype, 'heartbeat');
    const spawn = vi.fn().mockResolvedValue({ success: false, iterations: 0 });
    let benchmarkCalls = 0;
    const benchmark = vi.fn(async () => {
      benchmarkCalls++;
      if (benchmarkCalls === 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 35_000));
      }
      return 1;
    });
    const engine = new Engine(tasksDir, { benchmark, spawn });

    const ticking = engine.tick();
    await vi.waitFor(() => expect(benchmark).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(heartbeat).toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await ticking;
  }, 15_000);
});
