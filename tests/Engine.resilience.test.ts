import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/Engine.js';
import { TaskState } from '../src/TaskState.js';
import { DbCorruptError } from '../src/errors.js';
import { memStateDb, seed, type StateDb } from './helpers.js';

// State now lives in SQLite, so a crashed worker is recovered by
// tdb.recoverStale() (covered in Engine.test.ts) rather than the old
// host/PID + heartbeat-mtime two-tier scheme — those file-based recovery
// tests are intentionally gone. What remains unique here is loop()'s
// error-handling ceiling and base-branch detection.

describe('Engine loop resilience', () => {
  let dir = '';
  let s: StateDb;

  beforeEach(() => {
    const root = resolve('test-artifacts');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(resolve(root, 'eng-res-'));
    s = memStateDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  // A scan that throws makes tick() throw (tick calls #blockExhausted →
  // TaskState.scan before picking), so loop()'s catch/backoff path runs.

  it('loop continues after a single throwing tick', async () => {
    seed(s.db, dir, 1, 'flaky');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const e = new Engine(dir, { taskDb: s.tdb, benchmark: () => 0, sleep });

    let scanCalls = 0;
    const originalScan = TaskState.scan.bind(TaskState);
    vi.spyOn(TaskState, 'scan').mockImplementation((tdb, tasksRoot) => {
      scanCalls++;
      if (scanCalls === 1) throw new Error('transient scan failure');
      return originalScan(tdb, tasksRoot);
    });

    // loop() must not reject: it catches the transient error, backs off, and
    // keeps going until the task converges.
    await e.loop({ sleep, idleSleepMs: 1 });

    expect(e.environmentError).toBeUndefined();
    expect(sleep).toHaveBeenCalled();
    expect(scanCalls).toBeGreaterThan(1);
  });

  it('loop treats a non-Error tick failure as a transient hiccup', async () => {
    seed(s.db, dir, 1, 'retries');
    const e = new Engine(dir, { taskDb: s.tdb, benchmark: () => 0, idleSleepMs: 0 });

    let scanCalls = 0;
    const originalScan = TaskState.scan.bind(TaskState);
    vi.spyOn(TaskState, 'scan').mockImplementation((tdb, tasksRoot) => {
      scanCalls++;
      if (scanCalls === 1) throw 'plain string error';
      return originalScan(tdb, tasksRoot);
    });

    await expect(e.loop({ idleSleepMs: 0 })).resolves.toBeGreaterThan(0);
    expect(scanCalls).toBeGreaterThan(1);
  });

  it('loop stops with environmentError after MAX_CONSECUTIVE_TICK_ERRORS', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const e = new Engine(dir, { taskDb: s.tdb, benchmark: () => 0, sleep });

    let scanCalls = 0;
    vi.spyOn(TaskState, 'scan').mockImplementation(() => {
      scanCalls++;
      throw new Error('persistent scan failure');
    });

    const total = await e.loop({ sleep, idleSleepMs: 1 });

    expect(total).toBe(0);
    expect(e.stopReason).toBe('environment');
    expect(e.environmentError).toContain('repeated tick failures');
    expect(e.environmentError).toContain('10x');
    expect(e.environmentError).toContain('persistent scan failure');
    expect(scanCalls).toBe(10);
  });

  it('loop stops immediately on a FATAL DB error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const e = new Engine(dir, { taskDb: s.tdb, benchmark: () => 0, sleep });

    let scanCalls = 0;
    vi.spyOn(TaskState, 'scan').mockImplementation(() => {
      scanCalls++;
      throw new DbCorruptError('state.db is malformed');
    });

    const total = await e.loop({ sleep, idleSleepMs: 1 });

    expect(total).toBe(0);
    expect(e.stopReason).toBe('environment');
    expect(e.environmentError).toContain('malformed');
    // A FATAL error stops the run on the first occurrence, not after the ceiling.
    expect(scanCalls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('Engine instance identity', () => {
  let dir = '';
  let s: StateDb;

  beforeEach(() => {
    const root = resolve('test-artifacts');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(resolve(root, 'eng-id-'));
    s = memStateDb();
  });

  afterEach(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('two Engine instances produce different instanceIds', () => {
    const e1 = new Engine(dir, { taskDb: s.tdb });
    const e2 = new Engine(dir, { taskDb: s.tdb });
    expect(e1.instanceId).not.toBe(e2.instanceId);
  });

  it('default instanceId matches ^<pid>- pattern', () => {
    const e = new Engine(dir, { taskDb: s.tdb });
    expect(e.instanceId).toMatch(new RegExp(`^${process.pid}-`));
  });
});

describe('Atomic task claiming', () => {
  let dir = '';
  let s: StateDb;

  beforeEach(() => {
    const root = resolve('test-artifacts');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(resolve(root, 'eng-claim-'));
    s = memStateDb();
  });

  afterEach(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('two engines sharing one DB claim distinct tasks', async () => {
    seed(s.db, dir, 1, 'a');
    seed(s.db, dir, 2, 'b');
    const e1 = new Engine(dir, { taskDb: s.tdb, benchmark: () => 0, instanceId: 'engine-1' });
    const e2 = new Engine(dir, { taskDb: s.tdb, benchmark: () => 0, instanceId: 'engine-2' });

    // e1 claims the lowest-numbered task; pick() never returns an in-progress
    // row, so e2 is forced onto the next available task — never the same one.
    const r1 = await e1.tick();
    const r2 = await e2.tick();

    expect(r1.task).not.toBeNull();
    expect(r2.task).not.toBeNull();
    expect(r1.task!.number).not.toBe(r2.task!.number);
  });
});

describe('Engine base branch detection', () => {
  let dir = '';
  let s: StateDb;

  beforeEach(() => {
    dir = '';
    s = memStateDb();
  });

  afterEach(async () => {
    s.db.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('detects base branch from repo HEAD', async () => {
    const { execSync } = await import('node:child_process');

    dir = mkdtempSync(resolve('test-artifacts', 'eng-branch-'));
    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });

    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'file.txt'), 'initial');
    execSync('git add file.txt && git commit -m "initial"', { cwd: repoDir });
    execSync('git checkout -b work', { cwd: repoDir });

    const engine = new Engine(tasksDir, { repoDir, taskDb: s.tdb });

    expect(engine.baseBranch).toBe('work');
  });

  it('falls back to master when repo is detached HEAD', async () => {
    const { execSync } = await import('node:child_process');

    dir = mkdtempSync(resolve('test-artifacts', 'eng-detached-'));
    const repoDir = resolve(dir, 'repo');
    const tasksDir = resolve(dir, 'tasks');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });

    execSync('git init && git config user.email test@test && git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'file.txt'), 'initial');
    execSync('git add file.txt && git commit -m "initial"', { cwd: repoDir });
    execSync('git checkout --detach', { cwd: repoDir });

    const engine = new Engine(tasksDir, { repoDir, taskDb: s.tdb });

    expect(engine.baseBranch).toBe('master');
  });

  it('falls back to master when not in a git repo', async () => {
    // System temp (outside this repo) so git can't find a parent .git.
    const nogitDir = mkdtempSync(join(tmpdir(), 'eng-nogit-'));
    const tasksDir = resolve(nogitDir, 'tasks');

    try {
      mkdirSync(tasksDir, { recursive: true });
      const engine = new Engine(tasksDir, { repoDir: nogitDir, taskDb: s.tdb });
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

    seed(s.db, tasksDir, 1, 'test');

    const spawn = vi.fn().mockImplementation(async (_task: TaskState, wtPath?: string) => {
      if (!wtPath) throw new Error('missing worktree path');
      writeFileSync(join(wtPath, 'work.txt'), 'from worktree');
      execSync('git add work.txt && git commit -m "worktree commit"', { cwd: wtPath });
      return { success: true, iterations: 1 };
    });
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0) // tick 1
      .mockResolvedValue(0); // ticks 2, 3

    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir, taskDb: s.tdb });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(engine.baseBranch).toBe('work');

    const workLog = execSync('git log --oneline work', { cwd: repoDir, encoding: 'utf-8' });
    expect(workLog).toContain('worktree commit');

    const masterLog = execSync('git log --oneline master', { cwd: repoDir, encoding: 'utf-8' });
    expect(masterLog).not.toContain('worktree commit');
  });
});
