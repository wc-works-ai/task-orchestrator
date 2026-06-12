import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
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

  it('loop uses the default sleep path after a non-Error tick failure', async () => {
    make(dir, 1, 'retries');
    const engine = new Engine(dir, { benchmark: () => 0, idleSleepMs: 0 });
    const originalScan = TaskState.scan.bind(TaskState);
    let scanCalls = 0;
    vi.spyOn(TaskState, 'scan').mockImplementation(async (tasksDir: string) => {
      scanCalls++;
      if (scanCalls === 1) throw 'plain string error';
      return originalScan(tasksDir);
    });

    try {
      await expect(engine.loop({ idleSleepMs: 0 })).resolves.toBeGreaterThan(0);
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
      expect(engine.stopReason).toBe('environment');
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

  it('handles a stale claimed task whose owner file is missing', async () => {
    const taskDir = resolve(dir, 'in_progress', 'T01-missing-owner');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'heartbeat'), 'stale');
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:remote\n');
    const tenMinAgo = (Date.now() - 600_000) / 1000;
    utimesSync(join(claimDir, 'heartbeat'), tenMinAgo, tenMinAgo);

    const engine = new Engine(dir, { benchmark: () => 0, instanceId: 'missing-owner' });
    const r = await engine.tick();

    expect(r.task).toBeNull();
    expect(existsSync(claimDir)).toBe(true);
  });

  // ── FIX 1: instanceId is globally unique ────────────────────────────

  it('two Engine instances produce different instanceIds', () => {
    const engine1 = new Engine(dir);
    const engine2 = new Engine(dir);
    expect(engine1.instanceId).not.toBe(engine2.instanceId);
  });

  it('default instanceId matches ^<pid>- pattern', () => {
    const engine = new Engine(dir);
    expect(engine.instanceId).toMatch(new RegExp(`^${process.pid}-`));
  });

  // ── FIX 3: #recover() respects fresh heartbeats cross-machine ───────

  it('fresh heartbeat protects claim even with dead PID and different host', async () => {
    const originalHeartbeatMs = process.env.ORCH_HEARTBEAT_MS;
    // Set heartbeat timeout to 5 minutes (300000ms)
    process.env.ORCH_HEARTBEAT_MS = '300000';

    try {
      // Create an in-progress task claimed by a "different host" with a dead PID
      const taskDir = resolve(dir, 'in_progress', 'T01-cross-machine');
      mkdirSync(taskDir, { recursive: true });

      const claimDir = join(taskDir, '.claim');
      mkdirSync(claimDir, { recursive: true });
      // Use a bogus PID that's definitely not running (999999)
      // and a different host name
      writeFileSync(join(claimDir, 'owner'),
        `pid:999999\nstarted:${Date.now()}\ninstance:remote-inst\nhost:other-host\n`);
      // Fresh heartbeat (just created, mtime is now)
      writeFileSync(join(claimDir, 'heartbeat'), '');
      writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:remote-inst\n');

      const engine = new Engine(dir, { benchmark: () => 0, instanceId: 'local-engine' });

      // tick() should NOT reclaim this task: heartbeat is fresh
      const r = await engine.tick();

      // Task should NOT have been picked (it's protected by fresh heartbeat)
      expect(r.task).toBeNull();
      // Claim should still exist
      expect(existsSync(claimDir)).toBe(true);
    } finally {
      if (originalHeartbeatMs === undefined) delete process.env.ORCH_HEARTBEAT_MS;
      else process.env.ORCH_HEARTBEAT_MS = originalHeartbeatMs;
    }
  });

  it('same-host claim with dead PID and stale heartbeat is reclaimed', async () => {
    const originalHeartbeatMs = process.env.ORCH_HEARTBEAT_MS;
    // Set very short heartbeat timeout for test (1 second)
    process.env.ORCH_HEARTBEAT_MS = '1000';

    try {
      const taskDir = resolve(dir, 'in_progress', 'T01-same-host');
      mkdirSync(taskDir, { recursive: true });

      const claimDir = join(taskDir, '.claim');
      mkdirSync(claimDir, { recursive: true });
      // Use a bogus dead PID on this host
      writeFileSync(join(claimDir, 'owner'),
        `pid:999999\nstarted:${Date.now() - 10000}\ninstance:dead-inst\nhost:${hostname()}\n`);
      writeFileSync(join(claimDir, 'heartbeat'), '');
      writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:dead-inst\n');

      // Make heartbeat stale (older than 1 second)
      const oldTime = (Date.now() - 5000) / 1000;
      utimesSync(join(claimDir, 'heartbeat'), oldTime, oldTime);

      const engine = new Engine(dir, { benchmark: () => 0, instanceId: 'local-engine' });

      // tick() should reclaim this task: same host, dead PID, stale heartbeat
      const r = await engine.tick();

      // Task should have been recovered and picked up
      expect(r.task).not.toBeNull();
      expect(r.task!.number).toBe(1);
    } finally {
      if (originalHeartbeatMs === undefined) delete process.env.ORCH_HEARTBEAT_MS;
      else process.env.ORCH_HEARTBEAT_MS = originalHeartbeatMs;
    }
  });

  it('different-host claim with stale heartbeat under claimMaxMs is NOT reclaimed', async () => {
    const originalHeartbeatMs = process.env.ORCH_HEARTBEAT_MS;
    const originalClaimMaxMs = process.env.ORCH_CLAIM_MAX_MS;
    // Set short heartbeat but long hard ceiling
    process.env.ORCH_HEARTBEAT_MS = '1000';
    process.env.ORCH_CLAIM_MAX_MS = '3600000'; // 1 hour

    try {
      const taskDir = resolve(dir, 'in_progress', 'T01-cross-host');
      mkdirSync(taskDir, { recursive: true });

      const claimDir = join(taskDir, '.claim');
      mkdirSync(claimDir, { recursive: true });
      // Claim from a different host with dead PID
      writeFileSync(join(claimDir, 'owner'),
        `pid:999999\nstarted:${Date.now() - 10000}\ninstance:remote-inst\nhost:other-host\n`);
      writeFileSync(join(claimDir, 'heartbeat'), '');
      writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:remote-inst\n');

      // Stale heartbeat (past HEARTBEAT_MAX_MS=1s) but under claimMaxMs (1h)
      const oldTime = (Date.now() - 5000) / 1000;
      utimesSync(join(claimDir, 'heartbeat'), oldTime, oldTime);

      const engine = new Engine(dir, { benchmark: () => 0, instanceId: 'local-engine' });

      // tick() should NOT reclaim: different host, stale but under hard ceiling
      const r = await engine.tick();

      expect(r.task).toBeNull();
      expect(existsSync(claimDir)).toBe(true);
    } finally {
      if (originalHeartbeatMs === undefined) delete process.env.ORCH_HEARTBEAT_MS;
      else process.env.ORCH_HEARTBEAT_MS = originalHeartbeatMs;
      if (originalClaimMaxMs === undefined) delete process.env.ORCH_CLAIM_MAX_MS;
      else process.env.ORCH_CLAIM_MAX_MS = originalClaimMaxMs;
    }
  });

  it('different-host claim past claimMaxMs IS reclaimed', async () => {
    const originalHeartbeatMs = process.env.ORCH_HEARTBEAT_MS;
    const originalClaimMaxMs = process.env.ORCH_CLAIM_MAX_MS;
    // Short heartbeat and short hard ceiling for testing
    process.env.ORCH_HEARTBEAT_MS = '1000';
    process.env.ORCH_CLAIM_MAX_MS = '2000';

    try {
      const taskDir = resolve(dir, 'in_progress', 'T01-cross-host-timeout');
      mkdirSync(taskDir, { recursive: true });

      const claimDir = join(taskDir, '.claim');
      mkdirSync(claimDir, { recursive: true });
      // Claim from a different host with dead PID, started long ago
      writeFileSync(join(claimDir, 'owner'),
        `pid:999999\nstarted:${Date.now() - 10000}\ninstance:remote-inst\nhost:other-host\n`);
      writeFileSync(join(claimDir, 'heartbeat'), '');
      writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:remote-inst\n');

      // Heartbeat older than claimMaxMs (2s)
      const veryOldTime = (Date.now() - 10000) / 1000;
      utimesSync(join(claimDir, 'heartbeat'), veryOldTime, veryOldTime);

      const engine = new Engine(dir, { benchmark: () => 0, instanceId: 'local-engine' });

      // tick() should reclaim: past hard ceiling
      const r = await engine.tick();

      expect(r.task).not.toBeNull();
      expect(r.task!.number).toBe(1);
    } finally {
      if (originalHeartbeatMs === undefined) delete process.env.ORCH_HEARTBEAT_MS;
      else process.env.ORCH_HEARTBEAT_MS = originalHeartbeatMs;
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

describe('Infinite loop mode', () => {
  let dir = '';

  beforeEach(() => { dir = setup(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('infinite mode waits for new tasks instead of exiting', async () => {
    make(dir, 1, 'task1');
    const sleepCalls: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      sleepCalls.push(ms);
      // Stop after 2 sleep calls to avoid infinite loop
      if (sleepCalls.length >= 2) throw new Error('stop');
    });

    const engine = new Engine(dir, {
      benchmark: () => 0,
      sleep,
      infinite: true,
      idleSleepMs: 50,
    });

    try {
      await engine.loop({ infinite: true, idleSleepMs: 50, sleep });
    } catch (e: any) {
      if (!e.message.includes('stop')) throw e;
    }

    // Should have called sleep at least once (for idle wait)
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    // At least one sleep call should use idleSleepMs
    expect(sleepCalls.some(ms => ms === 50)).toBe(true);
  });
});

describe('Atomic task claiming', () => {
  let dir = '';

  beforeEach(() => { dir = setup(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('only one process can claim a task at a time', async () => {
    make(dir, 1, 'shared-task');
    
    // Two engines try to pick the same task
    const engine1 = new Engine(dir, { benchmark: () => 0, instanceId: 'engine-1' });
    const engine2 = new Engine(dir, { benchmark: () => 0, instanceId: 'engine-2' });

    // First engine picks the task
    const r1 = await engine1.tick();
    expect(r1.task).not.toBeNull();
    expect(r1.task!.number).toBe(1);

    // Second engine should not pick the same task (already claimed)
    const r2 = await engine2.tick();
    expect(r2.task).toBeNull();
  });

  it('claim lock file is cleaned up after task release', async () => {
    make(dir, 1, 'task1');
    const engine = new Engine(dir, { benchmark: () => 0 });

    // Pick the task
    const r1 = await engine.tick();
    expect(r1.task).not.toBeNull();
    expect(r1.task!.number).toBe(1);

    // Check that .claim.lock exists after picking
    const taskState = new TaskState(r1.task!.directory);
    const lockFile = join(taskState.directory, '.claim.lock');
    expect(existsSync(lockFile)).toBe(true);

    // Release the task manually
    taskState.release(Status.PENDING);

    // Check that lock file is gone
    expect(existsSync(lockFile)).toBe(false);
  });

  it('stale claim lock files are cleaned up on recovery', async () => {
    const taskDir = resolve(dir, 'in_progress', 'T01-stale-lock');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:dead-inst\n');

    // Create a stale .claim.lock file
    writeFileSync(join(taskDir, '.claim.lock'), 'pid:999999\nstarted:${Date.now()}\ninstance:dead-inst\nhost:dead-host\n');

    // Also create the .claim directory to simulate old-style claim
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:999999\nstarted:${Date.now()}\ninstance:dead-inst\nhost:dead-host\n');
    writeFileSync(join(claimDir, 'heartbeat'), '');

    // Simulate stale heartbeat
    const veryOldTime = (Date.now() - 10_000_000) / 1000;
    utimesSync(join(claimDir, 'heartbeat'), veryOldTime, veryOldTime);

    // Manually release to test cleanup
    const task = new TaskState(taskDir);
    task.release(Status.FAILED);

    // Check that both claim files are gone
    expect(existsSync(join(taskDir, '.claim.lock'))).toBe(false);
    expect(existsSync(join(taskDir, '.claim'))).toBe(false);
  });

  it('claim lock prevents race condition with parallel tasks', async () => {
    make(dir, 1, 'parallel-task');
    make(dir, 2, 'parallel-task-2');
    const engine = new Engine(dir, { benchmark: () => 1, parallel: 2 });

    // Run loop once with parallel=2
    // With 2 tasks and parallel=2, both should be picked up
    const r1 = await engine.tick();
    const r2 = await engine.tick();

    // At least one should find a task
    const tasks = [r1.task, r2.task].filter(t => t !== null);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    
    // If both were picked, they should be different tasks
    if (tasks.length === 2) {
      const [t1, t2] = tasks as any[];
      expect(t1.number).not.toBe(t2.number);
    }
  });

  it('atomic claim prevents two engines from claiming same task', async () => {
    make(dir, 1, 'shared-task');
    const engine1 = new Engine(dir, { benchmark: () => 0, instanceId: 'engine-1' });
    const engine2 = new Engine(dir, { benchmark: () => 0, instanceId: 'engine-2' });

    // Engine 1 picks the task
    const r1 = await engine1.tick();
    expect(r1.task).not.toBeNull();
    expect(r1.task!.number).toBe(1);

    // Verify .claim.lock file exists
    const lockFile = join(r1.task!.directory, '.claim.lock');
    expect(existsSync(lockFile)).toBe(true);

    // Engine 2 tries to pick but should get nothing (task already claimed)
    const r2 = await engine2.tick();
    expect(r2.task).toBeNull();
  });
});
