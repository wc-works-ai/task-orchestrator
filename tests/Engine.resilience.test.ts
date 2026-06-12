import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/Engine.js';
import { TaskState, Status } from '../src/TaskState.js';

function setup(): string {
  const root = resolve('test-artifacts');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(resolve(root, 'eng-resilience-'));
  for (const shard of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(dir, shard), { recursive: true });
  }
  return dir;
}

function make(dir: string, n: number, name: string, opts?: {
  status?: Status | string;
}): TaskState {
  const d = resolve(dir, 'pending', `T${String(n).padStart(2, '0')}-${name}`);
  mkdirSync(d, { recursive: true });
  const t = new TaskState(d);
  t.status = opts?.status ?? Status.PENDING;
  return t;
}

describe('Engine resilience', () => {
  let dir = '';

  beforeEach(() => { dir = setup(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // ── FIX 1: loop() continues after single tick error ─────────────────

  it('loop continues after a single throwing tick', async () => {
    make(dir, 1, 'flaky');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const benchmark = vi.fn(() => 0);
    const engine = new Engine(dir, { benchmark, sleep });

    // Make tick() throw ONCE on the first scan, then behave normally
    let scanCalls = 0;
    const originalScan = TaskState.scan.bind(TaskState);
    vi.spyOn(TaskState, 'scan').mockImplementation(async (tasksDir: string) => {
      scanCalls++;
      if (scanCalls === 1) throw new Error('transient scan failure');
      return originalScan(tasksDir);
    });

    try {
      // loop() should NOT reject — it catches the error and continues
      await engine.loop({ sleep, idleSleepMs: 1 });

      // After the first tick throws, loop should sleep (backoff) then retry
      // The task should eventually converge (metric=0 on subsequent calls)
      expect(engine.environmentError).toBeUndefined();
      expect(sleep).toHaveBeenCalled();
      // Scan was called: first throw, then normal calls
      expect(scanCalls).toBeGreaterThan(1);
    } finally {
      vi.mocked(TaskState.scan).mockRestore();
    }
  });

  it('loop stops with environmentError after MAX_CONSECUTIVE_TICK_ERRORS', async () => {
    const originalDir = dir;
    // Create a tasks dir but DON'T create shards - tick() will throw when scan() fails
    dir = resolve('test-artifacts', `eng-res-bad-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    // Don't create shard directories - scan() will throw
    
    const sleep = vi.fn().mockResolvedValue(undefined);
    const engine = new Engine(dir, { benchmark: () => 0, sleep });

    // Make tick() throw - override scan to throw
    let scanCalls = 0;
    vi.spyOn(TaskState, 'scan').mockImplementation(async () => {
      scanCalls++;
      throw new Error('persistent scan failure');
    });

    try {
      // loop() should NOT reject — it should break after 10 consecutive errors
      const total = await engine.loop({ sleep, idleSleepMs: 1 });

      expect(total).toBe(0);
      expect(engine.environmentError).toBeDefined();
      expect(engine.environmentError).toContain('repeated tick failures');
      expect(engine.environmentError).toContain('10x');
      expect(engine.environmentError).toContain('persistent scan failure');
      expect(scanCalls).toBe(10);
    } finally {
      vi.mocked(TaskState.scan).mockRestore();
      dir = originalDir;
      await rm(resolve('test-artifacts', `eng-res-bad-${Date.now()}`), { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── FIX 2: unexpected spawn/worktree error releases task ────────────

  it('unexpected (non-conflict) spawn error releases task to FAILED', async () => {
    make(dir, 1, 'spawn-error');
    const spawn = vi.fn().mockRejectedValue(new Error('unexpected spawn crash'));
    const engine = new Engine(dir, { benchmark: () => 1, spawn });

    const r = await engine.tick();

    expect(r.converged).toBe(false);
    const all = await TaskState.scan(dir);
    const task = all.get('1')!;
    // Task should be FAILED, not stuck IN_PROGRESS
    expect(task.status).toBe(Status.FAILED);
    expect(task.failureCount).toBe(1);
  });

  // ── FIX 4: stale claim hard timeout releases even alive PID ─────────

  it('releases claim after hard timeout even if PID is alive', async () => {
    const originalClaimMaxMs = process.env.ORCH_CLAIM_MAX_MS;
    // Set a short hard timeout for testing (1 second)
    process.env.ORCH_CLAIM_MAX_MS = '1000';

    try {
      // Create an in-progress task with stale claim owned by current PID (alive)
      const taskDir = resolve(dir, 'in_progress', 'T01-stuck');
      mkdirSync(taskDir, { recursive: true });

      const claimDir = join(taskDir, '.claim');
      mkdirSync(claimDir, { recursive: true });
      writeFileSync(join(claimDir, 'owner'), `pid:${process.pid}\n`);
      writeFileSync(join(claimDir, 'heartbeat'), 'stale');
      writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:stuck-owner\n');

      // Age the heartbeat past HEARTBEAT_MAX_MS (300000ms = 5 min) AND claimMaxMs (1s)
      // Use 400 seconds (well past 300s heartbeat max and 1s claim max)
      const veryOldTime = (Date.now() - 400_000) / 1000;
      utimesSync(join(claimDir, 'heartbeat'), veryOldTime, veryOldTime);

      const engine = new Engine(dir, { benchmark: () => 0, instanceId: 'hard-timeout-test' });

      // tick() should recover and release the task due to hard timeout
      const r = await engine.tick();

      // The stale task was recovered (hard timeout) → moved to FAILED → picked up
      expect(r.task).not.toBeNull();
      // Claim should be gone (task re-claimed by this engine)
      const all = await TaskState.scan(dir);
      const task = all.get('1');
      expect(task).toBeDefined();
      // Task should have been picked up (convergence 0 or in_progress)
    } finally {
      if (originalClaimMaxMs === undefined) delete process.env.ORCH_CLAIM_MAX_MS;
      else process.env.ORCH_CLAIM_MAX_MS = originalClaimMaxMs;
    }
  });

  it('does not release alive-PID claim under hard timeout ceiling', async () => {
    const originalClaimMaxMs = process.env.ORCH_CLAIM_MAX_MS;
    // Set a long hard timeout (30 min)
    process.env.ORCH_CLAIM_MAX_MS = '1800000';

    try {
      // Create an in-progress task with stale heartbeat but under the hard ceiling
      const taskDir = resolve(dir, 'in_progress', 'T01-long-op');
      mkdirSync(taskDir, { recursive: true });

      const claimDir = join(taskDir, '.claim');
      mkdirSync(claimDir, { recursive: true });
      writeFileSync(join(claimDir, 'owner'), `pid:${process.pid}\n`);
      writeFileSync(join(claimDir, 'heartbeat'), 'somewhat-stale');
      writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:long-running\n');

      // Age the heartbeat past HEARTBEAT_MAX_MS (5 min) but well under 30 min
      const tenMinAgo = (Date.now() - 600_000) / 1000;
      utimesSync(join(claimDir, 'heartbeat'), tenMinAgo, tenMinAgo);

      const engine = new Engine(dir, { benchmark: () => 0, instanceId: 'no-release-test' });

      // tick() should NOT release this task (alive PID, under hard ceiling)
      const r = await engine.tick();

      // No actionable tasks — the in-progress one is skipped (legitimate long op)
      expect(r.task).toBeNull();
      // Claim should still exist
      expect(existsSync(claimDir)).toBe(true);
    } finally {
      if (originalClaimMaxMs === undefined) delete process.env.ORCH_CLAIM_MAX_MS;
      else process.env.ORCH_CLAIM_MAX_MS = originalClaimMaxMs;
    }
  });
});

describe('Engine base branch detection', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('detects base branch from repo HEAD', async () => {
    const { execSync } = await import('node:child_process');

    // Create a temp dir with git repo on a custom branch
    dir = mkdtempSync(resolve('test-artifacts', 'eng-branch-'));
    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'file.txt'), 'initial');
    execSync('git add file.txt && git commit -m "initial"', { cwd: repoDir });
    execSync('git checkout -b work', { cwd: repoDir });

    for (const shard of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
      mkdirSync(resolve(tasksDir, shard), { recursive: true });
    }

    const engine = new Engine(tasksDir, { repoDir });

    // Engine should detect 'work' as the base branch
    expect(engine.baseBranch).toBe('work');
  });

  it('falls back to master when repo is detached HEAD', async () => {
    const { execSync } = await import('node:child_process');

    dir = mkdtempSync(resolve('test-artifacts', 'eng-detached-'));
    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'file.txt'), 'initial');
    execSync('git add file.txt && git commit -m "initial"', { cwd: repoDir });
    // Detach HEAD
    execSync('git checkout --detach', { cwd: repoDir });

    for (const shard of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
      mkdirSync(resolve(tasksDir, shard), { recursive: true });
    }

    const engine = new Engine(tasksDir, { repoDir });

    // Should fall back to 'master'
    expect(engine.baseBranch).toBe('master');
  });

  it('falls back to master when not in a git repo', async () => {
    // Use system temp directory (outside the repo) so git won't find parent .git
    const nogitDir = mkdtempSync(join(tmpdir(), 'eng-nogit-'));
    const tasksDir = resolve(nogitDir, 'tasks');

    try {
      for (const shard of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
        mkdirSync(resolve(tasksDir, shard), { recursive: true });
      }

      const engine = new Engine(tasksDir, { repoDir: nogitDir });

      // No .git, should fall back to 'master'
      expect(engine.baseBranch).toBe('master');
    } finally {
      await rm(nogitDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('merges to detected base branch (not hardcoded master)', async () => {
    const { execSync } = await import('node:child_process');

    dir = mkdtempSync(resolve('test-artifacts', 'eng-merge-branch-'));
    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    const worktreesDir = resolve(dir, 'worktrees');
    mkdirSync(repoDir, { recursive: true });

    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'base.txt'), 'base');
    execSync('git add base.txt && git commit -m "base"', { cwd: repoDir });
    execSync('git checkout -b work', { cwd: repoDir });

    for (const shard of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
      mkdirSync(resolve(tasksDir, shard), { recursive: true });
    }

    const taskDir = resolve(tasksDir, 'pending', 'T01-test');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, '.status'), 'PENDING\n');

    const spawn = vi.fn().mockImplementation(async (_task: TaskState, wtPath?: string) => {
      if (!wtPath) throw new Error('missing worktree path');
      writeFileSync(join(wtPath, 'work.txt'), 'from worktree');
      execSync('git add work.txt && git commit -m "worktree commit"', { cwd: wtPath });
      return { success: true, iterations: 1 };
    });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0) // tick 1
      .mockResolvedValue(0); // ticks 2, 3

    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    // Run to convergence
    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(engine.baseBranch).toBe('work');

    // Verify the merge landed on 'work' branch, not 'master'
    const workLog = execSync('git log --oneline work', { cwd: repoDir, encoding: 'utf-8' });
    expect(workLog).toContain('worktree commit');

    // Master should NOT have the worktree commit
    const masterLog = execSync('git log --oneline master', { cwd: repoDir, encoding: 'utf-8' });
    expect(masterLog).not.toContain('worktree commit');
  });
});
