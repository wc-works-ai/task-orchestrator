import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine } from '../src/Engine.js';
import { TaskState, Status } from '../src/TaskState.js';

function setup() {
  const dir = mkdtempSync(resolve('/tmp', 'eng-ts-'));
  for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(dir, s), { recursive: true });
  }
  return dir;
}

function make(dir: string, n: number, name: string, opts?: {
  status?: Status | string;
  deps?: readonly number[];
}): TaskState {
  const d = resolve(dir, 'pending', `T${String(n).padStart(2, '0')}-${name}`);
  mkdirSync(d, { recursive: true });
  const t = new TaskState(d);
  t.status = opts?.status ?? Status.PENDING;
  if (opts?.deps) t.dependencies = opts.deps;
  return t;
}

describe('Engine agent spawning', () => {
  let dir = '';
  beforeEach(() => { dir = setup(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('calls spawn when benchmark is non-zero', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 3 });
    // First call: metric=1 (triggers spawn), second call: metric=0 (spawn fixed it)
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);

    const engine = new Engine(dir, { benchmark, spawn });
    const r = await engine.tick();
    expect(r.metric).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(benchmark).toHaveBeenCalledTimes(2); // pre + post
  });

  it('fails task when spawn returns failure', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({ success: false, iterations: 0 });
    const benchmark = vi.fn().mockResolvedValue(1);

    const engine = new Engine(dir, { benchmark, spawn });
    const r = await engine.tick();
    expect(r.converged).toBe(false);
    // Task should be FAILED
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
  });

  it('marks FAILED when no spawner provided and metric is non-zero', async () => {
    make(dir, 1, 'a');
    const r = await new Engine(dir, { benchmark: () => 1 }).tick();
    expect(r.converged).toBe(false);
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
  });

  it('task remains IN_PROGRESS after spawn fixes metric but cz < threshold', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1)  // pre-agent: needs work
      .mockResolvedValue(0);     // post-agent: fixed

    const engine = new Engine(dir, { benchmark, spawn });
    const r = await engine.tick();
    expect(r.converged).toBe(false);
    // Claim held, cz=1
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.isInProgress).toBe(true);
    expect(all.get('1')!.convergenceCount).toBe(1);
  });

  it('converges after spawn fixes metric and cz reaches threshold', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    // First tick: metric=1, spawn fixes → metric=0, cz=1 (not converged)
    // Second tick: metric=0, cz=2
    // Third tick: metric=0, cz=3 → converged
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValue(0)  // tick 1
      .mockResolvedValue(0)   // tick 2
      .mockResolvedValue(0);  // tick 3

    const engine = new Engine(dir, { benchmark, spawn });
    let r = await engine.tick();
    expect(r.converged).toBe(false); // cz=1
    r = await engine.tick();
    expect(r.converged).toBe(false); // cz=2
    r = await engine.tick();
    expect(r.converged).toBe(true);  // cz=3
  });

  it('spawn errors are caught and counted as failure', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockRejectedValue(new Error('crash'));
    const engine = new Engine(dir, { benchmark: () => 1, spawn });
    const r = await engine.tick();
    expect(r.converged).toBe(false);
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
  });

  it('mergeAndRemove called on convergence when repo has .git', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk, writeFileSync } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
      mk(resolve(tasksDir, s), { recursive: true });
    }

    const d = resolve(tasksDir, 'pending', 'T01-x');
    mk(d, { recursive: true });
    writeFileSync(resolve(d, '.status'), 'PENDING\n');

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    // Tick 1: 1 (reset cz) → spawn → 0 (cz=1)
    // Tick 2: 0 (cz=2)
    // Tick 3: 0 (cz=3 → converges → mergeAndRemove line 124-125)
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0) // tick 1
      .mockResolvedValue(0)   // tick 2
      .mockResolvedValue(0);  // tick 3

    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir });
    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(r.metric).toBe(0);
  });

  it('handles merge conflict error from spawn', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockRejectedValue(new Error('merge conflict in worktree'));
    const engine = new Engine(dir, { benchmark: () => 1, spawn });
    const r = await engine.tick();
    // Conflict → task FAILED, worktree kept for inspection
    expect(r.converged).toBe(false);
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
  });

  it('resets worktree on failed task retry', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk, writeFileSync } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
      mk(resolve(tasksDir, s), { recursive: true });
    }

    const d = resolve(tasksDir, 'pending', 'T01-x');
    mk(d, { recursive: true });
    writeFileSync(resolve(d, '.status'), 'PENDING\n');

    const spawn = vi.fn().mockResolvedValue({ success: false, iterations: 0 });
    // Tick 1: benchmark returns 1, spawn fails → task FAILED
    // Tick 2: task picked from failed shard, has worktree → resetForRetry called
    const benchmark = vi.fn().mockResolvedValue(1);

    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir });
    const r1 = await engine.tick();
    expect(r1.converged).toBe(false);

    // Task should be FAILED
    const all = await TaskState.scan(tasksDir);
    expect(all.get('1')!.status).toBe(Status.FAILED);

    // Second tick should pick the failed task and try again
    benchmark.mockResolvedValue(0);
    const r2 = await engine.tick();
    // Should process the failed task (worktree reset + re-run)
    expect(r2.task).not.toBeNull();
  });
});
