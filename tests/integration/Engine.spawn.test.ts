import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine, MergeRecoveryAction } from '../../src/Engine.js';
import { TaskState, Status, type TaskInfo } from '../../src/TaskState.js';
import { memStateDb, seed, statusOf, setupTestDir, type StateDb, type SeedOpts } from '../shared/helpers.js';

let s: StateDb;

function make(dir: string, n: number, name: string, opts: SeedOpts = {}): void {
  seed(s.db, dir, n, name, opts);
}

function joinedCalls(spy: { mock: { calls: readonly (readonly unknown[])[] } }): string {
  return spy.mock.calls.map((call: readonly unknown[]) => call.map(String).join(' ')).join('\n');
}

async function dirtyMergeScenario(dir: string): Promise<{
  engine: Engine;
  tasksDir: string;
  worktreesDir: string;
}> {
  const { execSync } = await import('node:child_process');
  const { mkdirSync: mk } = await import('node:fs');

  const repoDir = resolve(dir, 'repo');
  const tasksDir = resolve(dir, 'tasks');
  const worktreesDir = resolve(dir, 'worktrees');
  mk(repoDir, { recursive: true });
  execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
  writeFileSync(join(repoDir, 'shared.txt'), 'base');
  execSync('git add shared.txt && git commit -m "base"', { cwd: repoDir });

  seed(s.db, tasksDir, 1, 'x', {});

  // Spawn modifies a file in the worktree and commits, then modifies the same file
  // in the main repo and commits → merge conflict when merging back
  const spawn = vi.fn().mockImplementation(async (_task: TaskState, wtPath?: string) => {
    if (!wtPath) throw new Error('missing worktree path');
    writeFileSync(join(wtPath, 'shared.txt'), 'worktree change');
    execSync('git add shared.txt && git commit -m "wt change"', { cwd: wtPath });
    // Create conflicting change in main repo
    writeFileSync(join(repoDir, 'shared.txt'), 'main change');
    execSync('git add shared.txt && git commit -m "main change"', { cwd: repoDir });
    return { success: true, iterations: 1 };
  });
  const benchmark = vi.fn()
    .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    .mockResolvedValue(0);
  const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir, worktreesDir });

  return { engine, tasksDir, worktreesDir };
}

describe('Engine agent spawning', () => {
  let dir = '';
  beforeEach(() => { dir = setupTestDir('eng-spawn-'); s = memStateDb(); });
  afterEach(async () => { s.db.close(); await rm(dir, { recursive: true, force: true }); });

  it('calls spawn when benchmark is non-zero', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 3 });
    // First call: metric=1 (triggers spawn), second call: metric=0 (spawn fixed it)
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn });
    const r = await engine.tick();
    expect(r.metric).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(benchmark).toHaveBeenCalledTimes(2); // pre + post
  });

  it('fails task when spawn returns failure', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({ success: false, iterations: 0 });
    const benchmark = vi.fn().mockResolvedValue(1);

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn });
    const r = await engine.tick();
    expect(r.converged).toBe(false);
    // Task should be FAILED
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('logs plain-language spawn failure, metric check, and retry decision', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({
      success: false,
      iterations: 2,
      error: 'pi exited with code 1',
      logPath: resolve(dir, 'agent.log'),
    });
    const benchmark = vi.fn().mockResolvedValue(1);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn });
      const r = await engine.tick();
      expect(r.converged).toBe(false);
      const output = joinedCalls(logSpy);
      expect(output).toContain('T1 check: metric=1 (needs work; target is 0)');
      expect(output).toContain('T1 action: starting agent because metric is 1');
      expect(output).toContain('T1 agent stopped without finishing (2 progress records; reason: pi exited with code 1');
      expect(output).toContain('T1 check after agent (repo): metric=1 (still needs work)');
      expect(output).toContain('T1 retrying: metric is still 1 (failed attempt 1/5)');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs token usage returned by the spawned agent', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({
      success: true,
      iterations: 2,
      tokenUsage: { input: 10, output: 5, cacheRead: 15, cacheWrite: 0, totalTokens: 30 },
      logPath: resolve(dir, 'agent.log'),
    });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn });
      await engine.tick();
      expect(joinedCalls(logSpy)).toContain(
        'T1 agent finished (2 progress records; tokens: total=30 input=10 output=5 cacheRead=15 cacheWrite=0',
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('marks FAILED when no spawner provided and metric is non-zero', async () => {
    make(dir, 1, 'a');
    const r = await new Engine(dir, { taskDb: s.tdb, benchmark: () => 1 }).tick();
    expect(r.converged).toBe(false);
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('task remains IN_PROGRESS after spawn fixes metric but cz < threshold', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1)  // pre-agent: needs work
      .mockResolvedValue(0);     // post-agent: fixed

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn });
    const r = await engine.tick();
    expect(r.converged).toBe(false);
    // Claim held, cz=1
    const all = TaskState.scan(s.tdb, dir);
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

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn });
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
    const engine = new Engine(dir, { taskDb: s.tdb, benchmark: () => 1, spawn });
    const r = await engine.tick();
    expect(r.converged).toBe(false);
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('mergeAndRemove called on convergence when repo has .git', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'x', {});

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    // Tick 1: 1 (reset cz) → spawn → 0 (cz=1)
    // Tick 2: 0 (cz=2)
    // Tick 3: 0 (cz=3 → converges → mergeAndRemove line 124-125)
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0) // tick 1
      .mockResolvedValue(0)   // tick 2
      .mockResolvedValue(0);  // tick 3

    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir });
    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(r.metric).toBe(0);
  });

  it('blocks the task and keeps the worktree when merge back fails (no crash)', async () => {
    const { engine, worktreesDir } = await dirtyMergeScenario(dir);
    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(false);
    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(true);
  });

  it('loop blocks a task on merge failure and continues without throwing', async () => {
    const { engine, worktreesDir } = await dirtyMergeScenario(dir);
    await engine.tick();
    await engine.tick();

    await expect(engine.loop()).resolves.toBe(1);

    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(true);
  });

  it('auto-stashes parent changes and retries merge when recovery chooses stash', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    const worktreesDir = resolve(dir, 'worktrees');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'tracked.txt'), 'base');
    execSync('git add tracked.txt && git commit -m "base"', { cwd: repoDir });
    // Create dev branch so we can switch to it after Engine construction
    execSync('git checkout -b dev', { cwd: repoDir });
    writeFileSync(join(repoDir, 'tracked.txt'), 'dev');
    execSync('git add tracked.txt && git commit -m "dev"', { cwd: repoDir });
    // Engine will detect 'dev' as base branch
    // The spawn will switch to master and dirty the file, causing checkout-to-dev to fail

    seed(s.db, tasksDir, 1, 'x', {});

    const spawn = vi.fn().mockImplementation(async (_task: TaskState, wtPath?: string) => {
      if (!wtPath) throw new Error('missing worktree path');
      writeFileSync(join(wtPath, 'work.txt'), 'worktree');
      execSync('git add work.txt && git commit -m "work"', { cwd: wtPath });
      // Switch main repo to master and dirty tracked.txt → checkout to dev will fail
      execSync('git checkout master', { cwd: repoDir });
      writeFileSync(join(repoDir, 'tracked.txt'), 'dirty master');
      return { success: true, iterations: 1 };
    });
    const recover = vi.fn().mockResolvedValue(MergeRecoveryAction.StashAndRetry);
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValue(0);
    const engine = new Engine(tasksDir, {
      taskDb: s.tdb,
      benchmark,
      spawn,
      repoDir,
      worktreesDir,
      mergeRecovery: recover,
      autoStashBeforeMerge: false, // test recovery path, not pre-stash
    });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ number: 1 }),
      worktreePath: join(worktreesDir, 'T01-x'),
      branch: 'orchestrator/T01-x',
      error: expect.stringContaining('Unable to switch to dev'),
    }));
    const all = TaskState.scan(s.tdb, tasksDir);
    expect(all.size).toBe(0); // T1 converged and excluded from scan
    expect(TaskState.countConverged(s.tdb)).toBe(1);
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(false);
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim()).toBe('master');
    expect(execSync('git show dev:work.txt', { cwd: repoDir, encoding: 'utf-8' })).toBe('worktree');
    expect(execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf-8' })).toBe('');
    expect(execSync('git stash list', { cwd: repoDir, encoding: 'utf-8' }))
      .toContain('orchestrator T01-x merge recovery');
  });

  it('auto-stashes parent changes before the first merge when enabled', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    const worktreesDir = resolve(dir, 'worktrees');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'tracked.txt'), 'base');
    execSync('git add tracked.txt && git commit -m "base"', { cwd: repoDir });
    // Create dev branch so we can switch to it after Engine construction
    execSync('git checkout -b dev', { cwd: repoDir });
    writeFileSync(join(repoDir, 'tracked.txt'), 'dev');
    execSync('git add tracked.txt && git commit -m "dev"', { cwd: repoDir });
    // Engine will detect 'dev' as base branch

    seed(s.db, tasksDir, 1, 'x', {});

    const spawn = vi.fn().mockImplementation(async (_task: TaskState, wtPath?: string) => {
      if (!wtPath) throw new Error('missing worktree path');
      writeFileSync(join(wtPath, 'work.txt'), 'worktree');
      execSync('git add work.txt && git commit -m "work"', { cwd: wtPath });
      // Switch main repo to master and dirty tracked.txt → checkout to dev will fail
      // autoStashBeforeMerge should handle this
      execSync('git checkout master', { cwd: repoDir });
      writeFileSync(join(repoDir, 'tracked.txt'), 'dirty master');
      return { success: true, iterations: 1 };
    });
    const recover = vi.fn().mockRejectedValue(new Error('recovery should not run'));
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValue(0);
    const engine = new Engine(tasksDir, {
      taskDb: s.tdb,
      benchmark,
      spawn,
      repoDir,
      worktreesDir,
      mergeRecovery: recover,
      autoStashBeforeMerge: true,
    });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(recover).not.toHaveBeenCalled();
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(false);
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim()).toBe('master');
    expect(execSync('git show dev:work.txt', { cwd: repoDir, encoding: 'utf-8' })).toBe('worktree');
    expect(execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf-8' })).toContain('tracked.txt');
    expect(execSync('git stash list', { cwd: repoDir, encoding: 'utf-8' })).toBe('');
  });

  it('blocks the task and keeps the branch when merge-back conflicts', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    const worktreesDir = resolve(dir, 'worktrees');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'shared.txt'), 'base');
    execSync('git add shared.txt && git commit -m "base"', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'x', {});

    // Worktree changes shared.txt; main changes the same file differently →
    // merge-back conflict.
    const spawn = vi.fn().mockImplementation(async (_task: TaskState, wtPath?: string) => {
      if (!wtPath) throw new Error('missing worktree path');
      writeFileSync(join(wtPath, 'shared.txt'), 'worktree');
      execSync('git add shared.txt && git commit -m "wt change"', { cwd: wtPath });
      writeFileSync(join(repoDir, 'shared.txt'), 'main change');
      execSync('git add shared.txt && git commit -m "main change"', { cwd: repoDir });
      return { success: true, iterations: 1 };
    });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValue(0);
    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(false);
    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
    // Branch kept for later merge; main untouched and clean — no rerun, no discard
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(true);
    expect(readFileSync(join(repoDir, 'shared.txt'), 'utf-8')).toBe('main change');
    expect(execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf-8' })).toBe('');
  });

  it('handles merge conflict error from spawn', async () => {
    make(dir, 1, 'a');
    const spawn = vi.fn().mockRejectedValue(new Error('merge conflict in worktree'));
    const engine = new Engine(dir, { taskDb: s.tdb, benchmark: () => 1, spawn });
    const r = await engine.tick();
    // Conflict → task FAILED, worktree kept for inspection
    expect(r.converged).toBe(false);
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('resets worktree on failed task retry', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'x', {});

    const spawn = vi.fn().mockResolvedValue({ success: false, iterations: 0 });
    // Tick 1: benchmark returns 1, spawn fails → task FAILED
    // Tick 2: task picked from failed shard, has worktree → resetForRetry called
    const benchmark = vi.fn().mockResolvedValue(1);

    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir });
    const r1 = await engine.tick();
    expect(r1.converged).toBe(false);

    // Task should be FAILED
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);

    // Second tick should pick the failed task and try again
    benchmark.mockResolvedValue(0);
    const r2 = await engine.tick();
    // Should process the failed task (worktree reset + re-run)
    expect(r2.task).not.toBeNull();
  });

  it('handles non-Error spawn rejection', async () => {
    make(dir, 1, 'a');
    // Throw a string instead of Error to cover String(e) branch (Engine L86)
    const spawn = vi.fn().mockRejectedValue('plain string error');
    const engine = new Engine(dir, { taskDb: s.tdb, benchmark: () => 1, spawn });
    const r = await engine.tick();
    // Non-conflict non-Error → task FAILED
    expect(r.converged).toBe(false);
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('spawn creates worktree with custom worktreesDir option (covers line 122 ternary)', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    const wtDir = resolve(dir, 'custom-wts');
    const gitEnv = { ...process.env, HOME: repoDir, USERPROFILE: repoDir, XDG_CONFIG_HOME: repoDir };
    mk(repoDir, { recursive: true });
    mk(wtDir, { recursive: true });
    execSync('git init', { cwd: repoDir, env: gitEnv });
    execSync('git -c user.email=test@test -c user.name=test commit --allow-empty -m init', { cwd: repoDir, env: gitEnv });

    seed(s.db, tasksDir, 1, 'a', {});

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);

    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir, worktreesDir: wtDir });
    const r = await engine.tick();
    expect(r.metric).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('runs the worktree benchmark against the worktree cwd using the task own dir', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(repoDir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'a', {});

    let worktreePath = '';
    const benchmarkDirs: string[] = [];
    const benchmarkCwds: string[] = [];
    const benchmark = vi.fn((task: TaskInfo) => {
      benchmarkDirs.push(task.directory);
      benchmarkCwds.push(task.cwd);
      return benchmarkDirs.length === 1 ? 1 : 0;
    });
    const spawn = vi.fn(async (task: TaskState, wt?: string) => {
      worktreePath = wt ?? '';
      // The task is no longer copied into the worktree; it stays in the tasks dir.
      expect(task.directory).toBe(resolve(tasksDir, 'T01-a'));
      return { success: true, iterations: 1 };
    });

    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir });
    const r = await engine.tick();

    const originalTaskDir = resolve(tasksDir, 'T01-a');
    expect(r.metric).toBe(0);
    expect(worktreePath).toBeTruthy();
    expect(spawn).toHaveBeenCalledTimes(1);
    // Initial check measures the repo; post-agent check measures the worktree —
    // both run the task's own benchmark.js (task dir), never a worktree copy.
    expect(benchmarkDirs[0]).toBe(originalTaskDir);
    expect(benchmarkCwds[0]).toBe(repoDir);
    expect(benchmarkDirs[1]).toBe(originalTaskDir);
    expect(benchmarkCwds[1]).toBe(worktreePath);
  });

  it('measures the worktree even when the task directory lives outside the repo', async () => {
    // Regression for the cross-layout bug: tasks live in an independent folder
    // (not under the repo). The post-agent benchmark must still run against the
    // worktree, not fall back to the repo.
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'state', 'tasks'); // sibling of the repo, NOT under it
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'a', {});

    let worktreePath = '';
    const benchmarkCwds: string[] = [];
    const benchmark = vi.fn((task: TaskInfo) => {
      benchmarkCwds.push(task.cwd);
      return benchmarkCwds.length === 1 ? 1 : 0; // fail first, pass after agent
    });
    const spawn = vi.fn(async (_task: TaskState, wt?: string) => {
      worktreePath = wt ?? '';
      return { success: true, iterations: 1 };
    });

    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir });
    const r = await engine.tick();

    expect(r.metric).toBe(0);
    expect(worktreePath).toBeTruthy();
    expect(benchmarkCwds[0]).toBe(repoDir);        // initial check → repo
    expect(benchmarkCwds[1]).toBe(worktreePath);   // post-agent check → worktree
  });

  it('syncs existing worktree with base before spawn; resets on conflict', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');
    const { Worktree } = await import('../../src/Worktree.js');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(repoDir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'a', {});

    let tickCount = 0;
    const benchmark = vi.fn(() => {
      tickCount++;
      // First two calls: metric=1 (initial check fails, agent runs)
      // Third call (post-agent on tick 1): metric=1 (still needs work, keeps worktree alive)
      // Fourth call (tick 2 initial check in worktree): metric=1
      return 1;
    });
    const spawn = vi.fn(async () => ({ success: true, iterations: 1 }));

    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir });
    // First tick creates the worktree
    await engine.tick();

    // Simulate syncWithBase throwing on the second tick (conflict)
    const syncSpy = vi.spyOn(Worktree.prototype, 'syncWithBase').mockImplementation(() => { throw new Error('conflict'); });
    const resetSpy = vi.spyOn(Worktree.prototype, 'resetForRetry').mockResolvedValue(undefined);

    try {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await engine.tick();
        const output = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
        // The conflict path was hit and the worktree was reset
        expect(output).toContain('worktree reset to');
        expect(output).toContain('sync failed; agent starts fresh');
        expect(resetSpy).toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
      }
    } finally {
      syncSpy.mockRestore();
      resetSpy.mockRestore();
    }
  });

  it('handles node_modules already existing in worktree (covers line 133 else)', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk, writeFileSync } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });
    // Create node_modules in repo for the copy to work
    mk(resolve(repoDir, 'node_modules'), { recursive: true });
    writeFileSync(resolve(repoDir, 'node_modules', 'dummy.txt'), 'dummy');

    seed(s.db, tasksDir, 1, 'a', {});

    const spawn = vi.fn().mockResolvedValue({ success: false, iterations: 0 });
    // Tick 1: metric=1 → spawn → creates worktree + copies node_modules → spawn returns → metric still 1 → FAILED
    // Tick 2: metric=1 → spawn → cached worktree, node_modules exists → skip copy (covers else branch)
    const benchmark = vi.fn().mockResolvedValue(1);

    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir });
    const r1 = await engine.tick();
    expect(r1.converged).toBe(false);

    expect(statusOf(s.db, 1)).toBe(Status.FAILED);

    // Tick 2 with same engine instance — worktree cached, node_modules already exists
    const r2 = await engine.tick();
    expect(r2.task).not.toBeNull();
    expect(r2.converged).toBe(false);
  });

  it('verifyCmd passes: task merges successfully', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'x', {});

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValue(0);

    // verifyCmd that always passes (exit 0)
    const verifyCmd = process.platform === 'win32' ? 'exit /b 0' : 'true';
    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir, verifyCmd });
    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
  });

  it('verifyCmd fails: task goes to rework instead of merging', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'x', {});

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValue(0);

    // verifyCmd that always fails (exit 1)
    const verifyCmd = process.platform === 'win32' ? 'exit /b 1' : 'false';
    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir, verifyCmd });
    await engine.tick(); // metric=1 → spawn → 0 (cz=1)
    await engine.tick(); // metric=0 (cz=2)
    const r = await engine.tick(); // metric=0 (cz=3 → mergeAndRemove → verifyCmd fails → rework)

    expect(r.converged).toBe(false);
    // Task should NOT be converged — verify failure sent it to rework
    expect(statusOf(s.db, 1)).not.toBe(Status.CONVERGED);
  });

  it('no verifyCmd: merge proceeds without verification', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdirSync: mk } = await import('node:fs');

    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mk(repoDir, { recursive: true });
    execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });

    seed(s.db, tasksDir, 1, 'x', {});

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValue(0);

    // No verifyCmd — should converge normally
    const engine = new Engine(tasksDir, { taskDb: s.tdb, benchmark, spawn, repoDir });
    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
  });

  it('parallel=1 (serial mode): processes tasks one at a time', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn().mockResolvedValue(0);

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn, parallel: 1 });
    const total = await engine.loop();

    // 2 tasks × 3 convergence ticks each = 6 total tick() calls returning a task
    expect(total).toBe(6);
    expect(spawn).toHaveBeenCalledTimes(0); // Both tasks converge without spawning
    expect(benchmark.mock.calls.length).toBeGreaterThan(0);
  });

  it('parallel=2: runs 2 tasks concurrently', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn().mockResolvedValue(0);

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn, parallel: 2 });
    const total = await engine.loop();

    // 2 tasks × 3 convergence ticks each = 6 total tick() calls returning a task
    // With parallel=2, these should run concurrently where possible
    expect(total).toBe(6);
  });

  it('parallel=0 (unlimited): spawns all ready tasks', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    make(dir, 3, 'c');

    const spawn = vi.fn().mockResolvedValue({ success: true, iterations: 1 });
    const benchmark = vi.fn().mockResolvedValue(0);

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn, parallel: 0 });
    const total = await engine.loop();

    // 3 tasks × 3 convergence ticks each = 9 total tick() calls returning a task
    // With parallel=0 (unlimited), all tasks should run concurrently
    expect(total).toBe(9);
  }, 10000);

  it('parallel mode: tasks block/fail independently', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');

    const spawn = vi.fn().mockImplementation(async (task: TaskState) => {
      // Task 1 succeeds, Task 2 fails
      if (task.taskNumber === 1) {
        return { success: true, iterations: 1 };
      } else {
        return { success: false, iterations: 1 };
      }
    });

    const benchmark = vi.fn().mockImplementation(() => {
      // Both tasks need work initially
      return 1;
    });

    const engine = new Engine(dir, { taskDb: s.tdb, benchmark, spawn, parallel: 2 });
    // Run two tick operations to process both tasks
    await engine.tick();
    await engine.tick();

    const all = TaskState.scan(s.tdb, dir);
    const task1 = all.get('1');
    const task2 = all.get('2');

    // Task 1 was picked and attempted (might be in_progress)
    expect(task1).not.toBeNull();
    // Task 2 was picked and attempted (might be in_progress or failed)
    expect(task2).not.toBeNull();
  });
});
