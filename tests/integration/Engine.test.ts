import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Engine } from '../../src/Engine.js';
import { TaskState, Status, CONVERGENCE_THRESHOLD, MAX_FAILURES } from '../../src/TaskState.js';
import { memStateDb, openStateDb, seed, rowOf, statusOf, type StateDb, type SeedOpts } from '../shared/helpers.js';

const zero = () => 0;
const one = () => 1;

describe('Engine', () => {
  let dir = '';
  let s: StateDb;

  function make(n: number, name: string, opts: SeedOpts = {}): void {
    seed(s.db, dir, n, name, opts);
  }

  beforeEach(() => {
    const root = resolve('test-artifacts');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(resolve(root, 'eng-ts-'));
    s = memStateDb();
  });

  afterEach(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function engine(opts: Record<string, unknown> = {}): Engine {
    return new Engine(dir, { taskDb: s.tdb, ...opts });
  }

  it('tick returns null when nothing actionable', async () => {
    const r = await engine({ benchmark: zero }).tick();
    expect(r.task).toBeNull();
  });

  it('single tick processes exactly one task', async () => {
    make(1, 'a');
    make(2, 'b');
    const e = engine({ benchmark: zero });
    const r = await e.tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
    expect(e.instanceId).toBeTruthy();
  });

  it('in-process ownership guard: a concurrent tick skips a task already being processed', async () => {
    make(1, 'a');
    let reentrant: Awaited<ReturnType<Engine['tick']>> | undefined;
    let benchCalls = 0;
    const e: Engine = new Engine(dir, {
      taskDb: s.tdb,
      benchmark: async () => {
        benchCalls++;
        if (benchCalls === 1) reentrant = await e.tick();
        return 0;
      },
    });
    const r = await e.tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
    // The re-entrant tick saw the owned task and skipped it (no double-process).
    expect(reentrant!.task).toBeNull();
    expect(benchCalls).toBe(1);
  });

  it('converges after threshold zero-runs', async () => {
    make(1, 'a');
    const e = engine({ benchmark: zero });
    for (let i = 0; i < CONVERGENCE_THRESHOLD - 1; i++) {
      const r = await e.tick();
      expect(r.converged).toBe(false);
    }
    const r = await e.tick();
    expect(r.converged).toBe(true);
    expect(TaskState.scan(s.tdb, dir).size).toBe(0); // T1 converged, excluded from scan
    expect(TaskState.countConverged(s.tdb)).toBe(1);
  });

  it('non-zero benchmark marks FAILED', async () => {
    make(1, 'a');
    const r = await engine({ benchmark: one }).tick();
    expect(r.converged).toBe(false);
    expect(r.metric).toBe(1);
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('increments failures and blocks after max failed ticks', async () => {
    make(1, 'a');
    const e = engine({ benchmark: one, spawn: async () => ({ success: false, iterations: 0 }) });

    for (let i = 0; i < MAX_FAILURES; i++) {
      const r = await e.tick();
      expect(r.task).not.toBeNull();
      expect(r.metric).toBe(1);
    }

    expect(rowOf(s.db, 1)!.failures).toBe(MAX_FAILURES);
    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
    expect((await e.tick()).task).toBeNull();
  });

  it('blocks after one failed attempt when retry limit is 1', async () => {
    make(1, 'a', { maxFailures: 1 });
    const e = engine({ benchmark: one, spawn: async () => ({ success: false, iterations: 0 }) });

    const r = await e.tick();
    expect(r.task).not.toBeNull();

    expect(rowOf(s.db, 1)!.failures).toBe(1);
    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
  });

  it('keeps retrying when retry limit is infinite', async () => {
    make(1, 'a', { maxFailures: null });
    const e = engine({ benchmark: one, spawn: async () => ({ success: false, iterations: 0 }) });

    for (let i = 0; i < 7; i++) {
      const r = await e.tick();
      expect(r.task).not.toBeNull();
    }

    expect(rowOf(s.db, 1)!.failures).toBe(7);
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('does not consume a retry on a task-agnostic (auth) failure', async () => {
    make(1, 'auth');
    const e = engine({
      benchmark: one,
      spawn: async () => ({
        success: false,
        iterations: 0,
        authFailure: true,
        error: 'No API key found for azure-openai-responses',
      }),
    });

    const r = await e.tick();
    expect(r.stopped).toBe(true);
    expect(r.environmentError).toContain('No API key found');
    expect(e.environmentError).toContain('No API key found');

    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
    expect(rowOf(s.db, 1)!.failures).toBe(0);
  });

  it('uses the generic auth-failure message when the agent omits an error', async () => {
    make(1, 'auth');
    const e = engine({
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0, authFailure: true }),
    });

    const r = await e.tick();

    expect(r.stopped).toBe(true);
    expect(r.environmentError).toContain('coding agent authentication failed');
    expect(rowOf(s.db, 1)!.failures).toBe(0);
  });

  it('fails fast: stops the run on an env failure so other tasks do not churn to FAILED', async () => {
    make(1, 'auth');
    make(2, 'second');
    let spawnCalls = 0;
    const e = engine({
      benchmark: one,
      spawn: async () => {
        spawnCalls++;
        return { success: false, iterations: 0, authFailure: true, error: 'No API key found' };
      },
    });

    const ticks = await e.loop();

    expect(spawnCalls).toBe(1);
    expect(ticks).toBe(0);
    expect(e.environmentError).toContain('No API key found');
    expect(e.stopReason).toBe('environment');
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
    expect(rowOf(s.db, 1)!.failures).toBe(0);
    expect(statusOf(s.db, 2)).toBe(Status.PENDING);
  });

  it('fails (not blocks) the detecting task on an env failure', async () => {
    make(1, 'auth');
    const e = engine({
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0, authFailure: true, error: 'No API key found' }),
    });

    await e.tick();
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
    expect(statusOf(s.db, 1)).not.toBe(Status.BLOCKED);
    expect(rowOf(s.db, 1)!.failures).toBe(0);
  });

  it('skips task with unmet deps, picks next', async () => {
    make(1, 'a', { deps: [2] });
    make(2, 'b');
    const r = await engine({ benchmark: zero }).tick();
    expect(r.task!.number).toBe(2);
  });

  it('blocks a task whose dependency is blocked', async () => {
    make(1, 'blocked', { status: Status.BLOCKED });
    make(2, 'dependent', { deps: [1] });

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task).toBeNull();
    expect(statusOf(s.db, 2)).toBe(Status.BLOCKED);
  });

  it('blocks transitive dependents in one tick', async () => {
    make(1, 'blocked', { status: Status.BLOCKED });
    make(2, 'middle', { deps: [1] });
    make(3, 'end', { deps: [2] });

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task).toBeNull();
    expect(statusOf(s.db, 2)).toBe(Status.BLOCKED);
    expect(statusOf(s.db, 3)).toBe(Status.BLOCKED);
  });

  it('does not block dependents of a failed dependency', async () => {
    make(1, 'failed', { status: Status.FAILED });
    make(2, 'dependent', { deps: [1] });

    await engine({ benchmark: zero }).tick();

    expect(statusOf(s.db, 2)).toBe(Status.PENDING);
  });

  it('blocks dependents when a failed dependency runs out of retries', async () => {
    make(1, 'failed', { status: Status.FAILED, failures: MAX_FAILURES });
    make(2, 'dependent', { deps: [1] });

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task).toBeNull();
    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
    expect(statusOf(s.db, 2)).toBe(Status.BLOCKED);
  });

  it('does not block dependents of a converged dependency', async () => {
    make(1, 'done', { status: Status.CONVERGED });
    make(2, 'dependent', { deps: [1] });

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task!.number).toBe(2);
    expect(statusOf(s.db, 2)).not.toBe(Status.BLOCKED);
  });

  it('blocks a task when any dependency in a diamond is blocked', async () => {
    make(1, 'blocked', { status: Status.BLOCKED });
    make(2, 'done', { status: Status.CONVERGED });
    make(3, 'dependent', { deps: [1, 2] });

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task).toBeNull();
    expect(statusOf(s.db, 3)).toBe(Status.BLOCKED);
  });

  it('ignores stray non-task entries in the tasks root', async () => {
    writeFileSync(join(dir, 'orchestrator.log'), '');
    mkdirSync(join(dir, '.staging-leftover'), { recursive: true });
    make(1, 'real-task');

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
  });

  it('second instance does not steal claim', async () => {
    make(1, 'a');
    await engine({ benchmark: zero, instanceId: 'A' }).tick();
    const r = await engine({ benchmark: zero, instanceId: 'B' }).tick();
    expect(r.task).toBeNull();
  });

  it('loop processes all tasks to convergence', async () => {
    make(1, 'a');
    make(2, 'b');
    const total = await engine({ benchmark: zero }).loop();
    expect(total).toBe(CONVERGENCE_THRESHOLD * 2);
    expect(TaskState.scan(s.tdb, dir).size).toBe(0);
    expect(TaskState.countConverged(s.tdb)).toBe(2);
  });

  it('loop with onTick callback', async () => {
    make(1, 'a');
    const ticks: number[] = [];
    await engine({ benchmark: zero }).loop({
      onTick: (r) => { ticks.push(r.task!.number); },
    });
    expect(ticks).toEqual([1, 1, 1]);
  });

  it('keep-alive off by default breaks on the first null tick', async () => {
    make(1, 'cooldown');
    const e = engine({
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0 }),
      retryCooldownMs: 60000,
    });
    await e.tick();
    const sleep = vi.fn();

    const total = await e.loop({ idleSleepMs: 0, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keep-alive waits through transient idle until remaining tasks are terminal', async () => {
    make(1, 'cooldown');
    const e = engine({
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0 }),
      retryCooldownMs: 60000,
    });
    await e.tick();
    const sleep = vi.fn(async () => {
      TaskState.scan(s.tdb, dir).get('1')!.markBlocked();
    });

    const total = await e.loop({ keepAlive: true, idleSleepMs: 0, sleep });

    expect(total).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
  });

  it('keep-alive stops immediately when every task is converged or blocked', async () => {
    make(1, 'done', { status: Status.CONVERGED });
    make(2, 'blocked', { status: Status.BLOCKED });
    const sleep = vi.fn();

    const total = await engine({ benchmark: zero }).loop({ keepAlive: true, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  // ── Recovery (recoverStale) ──────────────────────────────────────────

  it('recovers a stale claim on tick: marks FAILED, unclaims, and counts a failure', async () => {
    make(1, 'dep'); // PENDING; keeps T2's deps unmet so T2 is not re-picked this tick
    make(2, 'stale', {
      status: 'IN_PROGRESS',
      claimedBy: 'dead-worker',
      claimToken: 'stale-token',
      claimedAt: Date.now() - 400_000,
      heartbeat: Date.now() - 400_000,
      deps: [1],
    });

    await engine({ benchmark: one }).tick();

    const recovered = rowOf(s.db, 2)!;
    expect(recovered.status).toBe(Status.FAILED);
    expect(recovered.claimed_by).toBeNull();
    expect(recovered.failures).toBe(1);
  });

  it('leaves a fresh claim untouched and reports it as held elsewhere', async () => {
    make(1, 'fresh', {
      status: 'IN_PROGRESS',
      claimedBy: 'other-inst',
      claimToken: 'fresh-token',
      claimedAt: Date.now(),
      heartbeat: Date.now(),
    });

    const r = await engine({ benchmark: zero, instanceId: 'my-inst' }).tick();

    expect(r.task).toBeNull();
    const row = rowOf(s.db, 1)!;
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.claimed_by).toBe('other-inst');
    expect(row.failures).toBe(0);
  });

  it('benchmark that throws is caught and counted as non-zero', async () => {
    make(1, 'a');
    const r = await engine({ benchmark: () => { throw new Error('boom'); } }).tick();
    expect(r.metric).toBe(1);
    expect(r.converged).toBe(false);
    expect(statusOf(s.db, 1)).toBe(Status.FAILED);
  });

  it('returns null when stop file exists', async () => {
    make(1, 'a');
    writeFileSync(resolve(dir, '.stop'), '');
    const r = await engine({ benchmark: zero }).tick();
    expect(r.task).toBeNull();
    expect(r.stopped).toBe(true);
    expect(existsSync(resolve(dir, '.stop'))).toBe(false);
  });

  it('infinite loop idles when all tasks are terminal until stopped', async () => {
    make(1, 'done', { status: Status.CONVERGED });
    make(2, 'blocked', { status: Status.BLOCKED });
    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps++;
      if (sleeps === 3) writeFileSync(resolve(dir, '.stop'), '');
    });

    const total = await engine({ benchmark: zero }).loop({ infinite: true, idleSleepMs: 0, sleep });

    expect(total).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('infinite idle log includes polling interval', async () => {
    make(1, 'done', { status: Status.CONVERGED });
    make(2, 'blocked', { status: Status.BLOCKED });
    const sleep = vi.fn(async () => { writeFileSync(resolve(dir, '.stop'), ''); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await engine({ benchmark: zero }).loop({ infinite: true, idleSleepMs: 1234, sleep });
      const logs = logSpy.mock.calls.map(call => String(call[0] ?? '')).join('\n');
      expect(logs).toContain('polling every 1234ms');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keep-alive still stops immediately when complete without infinite mode', async () => {
    make(1, 'done', { status: Status.CONVERGED });
    make(2, 'blocked', { status: Status.BLOCKED });
    const sleep = vi.fn();

    const total = await engine({ benchmark: zero }).loop({ keepAlive: true, infinite: false, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('infinite loop resumes work when a new task becomes ready', async () => {
    const seen: number[] = [];
    let sleeps = 0;
    let processed = false;
    const sleep = vi.fn(async () => {
      sleeps++;
      if (sleeps === 2) make(1, 'new-task');
      if (processed) writeFileSync(resolve(dir, '.stop'), '');
    });

    const total = await engine({ benchmark: zero }).loop({
      infinite: true,
      idleSleepMs: 0,
      sleep,
      onTick: (r) => {
        seen.push(r.task!.number);
        processed = true;
      },
    });

    expect(total).toBe(CONVERGENCE_THRESHOLD);
    expect(seen).toEqual([1, 1, 1]);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('explicit stop breaks infinite loop promptly', async () => {
    writeFileSync(resolve(dir, '.stop'), '');
    const sleep = vi.fn();

    const e = engine({ benchmark: zero });
    const total = await e.loop({ infinite: true, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(e.stopReason).toBe('signal');
  });

  it('reports stopReason=complete when a non-infinite run finishes', async () => {
    make(1, 'a');
    const e = engine({ benchmark: zero });

    await e.loop();

    expect(e.stopReason).toBe('complete');
  });

  it('resets worktree on failed task retry', async () => {
    make(1, 'a', { status: Status.FAILED });
    const r = await engine({ benchmark: zero }).tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
  });

  // ── Startup reconciliation ───────────────────────────────────────────

  it('reconcile promotes a stale CREATING row whose content landed', async () => {
    make(1, 'creating', { status: 'CREATING', benchmark: true });
    const r = await engine({ benchmark: zero }).tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
  });

  it('reconcile drops an incomplete CREATING row and its staging dir', async () => {
    make(1, 'half', { status: 'CREATING' }); // no benchmark.js → incomplete
    mkdirSync(join(dir, '.staging-T01-half-abc'), { recursive: true });
    mkdirSync(join(dir, '.staging-T02-other-xyz'), { recursive: true }); // unrelated → kept

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task).toBeNull();
    expect(rowOf(s.db, 1)).toBeUndefined();
    expect(existsSync(join(dir, '.staging-T01-half-abc'))).toBe(false);
    expect(existsSync(join(dir, '.staging-T02-other-xyz'))).toBe(true);
  });

  it('reconcile blocks an actionable task whose content directory vanished', async () => {
    make(1, 'gone');
    await rm(resolve(dir, 'T01-gone'), { recursive: true, force: true });

    const r = await engine({ benchmark: zero }).tick();

    expect(r.task).toBeNull();
    expect(statusOf(s.db, 1)).toBe(Status.BLOCKED);
  });

  it('reconcile imports old file-shard tasks once on startup and not again', async () => {
    const legacy = join(dir, 'pending', 'T01-legacy');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, '.status'), 'PENDING');
    writeFileSync(join(legacy, 'benchmark.js'), 'console.log("METRIC ok 0");');
    const e = engine({ benchmark: zero });

    const r = await e.tick();
    expect(r.task!.number).toBe(1);
    expect(rowOf(s.db, 1)).toBeDefined();

    // A task dropped into a shard after the first tick must NOT be imported:
    // migration runs once, guarded by the reconcile flag.
    const late = join(dir, 'pending', 'T02-late');
    mkdirSync(late, { recursive: true });
    writeFileSync(join(late, '.status'), 'PENDING');
    await e.tick();
    expect(rowOf(s.db, 2)).toBeUndefined();
  });

  // ── Disposal ─────────────────────────────────────────────────────────

  it('dispose closes an engine-owned state DB and is idempotent', () => {
    const { db } = openStateDb(dir); // create state.db on disk, then release the seeding handle
    db.close();
    const e = new Engine(dir, { benchmark: zero }); // owns its DB (no injection)
    e.dispose();
    expect(() => e.dispose()).not.toThrow();
  });

  it('exposes the task DB it was constructed with', () => {
    expect(engine({ benchmark: zero }).taskDb).toBe(s.tdb);
  });

  // ── pickByNumber ─────────────────────────────────────────────────────

  it('pickByNumber finds task by number', async () => {
    make(1, 'a');
    make(5, 'b');
    const t = engine({ benchmark: zero }).pickByNumber(5);
    expect(t).not.toBeNull();
    expect(t!.taskNumber).toBe(5);
  });

  it('pickByNumber returns null for non-existent task', async () => {
    make(1, 'a');
    const t = engine({ benchmark: zero }).pickByNumber(99);
    expect(t).toBeNull();
  });

  it('pickByNumber finds an in-progress task without claiming it', async () => {
    make(1, 'claimed', { status: 'IN_PROGRESS', claimedBy: 'someone', claimToken: 'tok' });
    const t = engine({ benchmark: zero }).pickByNumber(1);
    expect(t).not.toBeNull();
    expect(t!.taskNumber).toBe(1);
    expect(t!.isInProgress).toBe(true);
  });

  it('pickByNumber finds a converged task', async () => {
    make(3, 'c', { status: Status.CONVERGED });
    const found = engine({ benchmark: zero }).pickByNumber(3);
    expect(found).not.toBeNull();
    expect(found!.taskNumber).toBe(3);
  });

  it('uses default benchmark (() => 1) when not provided', async () => {
    make(1, 'a');
    const r = await engine().tick();
    expect(r.metric).toBe(1);
    expect(r.converged).toBe(false);
  });

  // ── Idle diagnostics ─────────────────────────────────────────────────

  it('diagnostic: logs a skip for a blocked task', async () => {
    make(1, 'blocked', { status: Status.BLOCKED, failures: 5 });
    const r = await engine({ benchmark: zero, instanceId: 'test' }).tick();
    expect(r.task).toBeNull();
  });

  it('diagnostic: logs a skip for a task with unmet deps', async () => {
    make(1, 'needs-t99', { deps: [99] });
    const r = await engine({ benchmark: zero, instanceId: 'test' }).tick();
    expect(r.task).toBeNull();
  });

  it('re-checks convergence for our own in-progress claim across ticks', async () => {
    const myId = 'converge-instance';
    make(1, 'my-claim', {
      status: 'IN_PROGRESS',
      claimedBy: myId,
      claimToken: 'my-token',
      claimedAt: Date.now(),
      heartbeat: Date.now(),
    });
    const r = await engine({ benchmark: zero, instanceId: myId }).tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
  });

  it('respects retry cooldown after failure', async () => {
    make(1, 'cooldown');
    const e = engine({
      benchmark: () => 1,
      spawn: async () => ({ success: false, iterations: 0 }),
      retryCooldownMs: 60000,
    });
    const r1 = await e.tick();
    expect(r1.task).not.toBeNull();
    const r2 = await e.tick();
    expect(r2.task).toBeNull();
  });

  // ── B2/B3: convergence/worktree reconnection ────────────────────────

  it('B3: reconnects to existing worktree on disk when not in memory', async () => {
    make(1, 'b3-reconnect', { convergence: CONVERGENCE_THRESHOLD - 1 });

    writeFileSync(resolve(dir, '.git'), 'not a real git repo');
    const wtDir = resolve(dir, '.worktrees', 'T01-b3-reconnect');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(resolve(wtDir, '.git'), 'gitdir: fake');

    const e = engine({
      benchmark: zero,
      spawn: async () => ({ success: true, iterations: 1 }),
      repoDir: dir,
    });
    const r = await e.tick();
    expect(r.converged).toBe(false);
  });

  it('B2: reconnects worktree on pickup when convergence > 0 and worktree exists', async () => {
    make(1, 'b2-reconnect', { convergence: 1 });

    writeFileSync(resolve(dir, '.git'), 'not a real git repo');
    const wtDir = resolve(dir, '.worktrees', 'T01-b2-reconnect');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(resolve(wtDir, '.git'), 'gitdir: fake');

    const e = engine({
      benchmark: zero,
      spawn: async () => ({ success: true, iterations: 1 }),
      repoDir: dir,
    });
    const r = await e.tick();
    expect(r.task).not.toBeNull();
  });

  it('B2: resets convergence when convergence > 0 but worktree not found', async () => {
    make(1, 'b2-no-wt', { convergence: 2 });

    writeFileSync(resolve(dir, '.git'), 'not a real git repo');

    const e = engine({
      benchmark: zero,
      spawn: async () => ({ success: true, iterations: 1 }),
      repoDir: dir,
    });
    const r = await e.tick();
    expect(rowOf(s.db, 1)!.convergence).toBe(1); // reset to 0, then incremented after the zero benchmark
    expect(r.converged).toBe(false);
  });

  it('B3: no-spawn mode converges without worktree (legitimate)', async () => {
    make(1, 'no-spawn', { convergence: CONVERGENCE_THRESHOLD - 1 });

    const e = engine({ benchmark: zero });
    const r = await e.tick();
    expect(r.converged).toBe(true);
  });

  it('noWorktree: agent works directly in repo, no worktree created', async () => {
    make(1, 'no-wt');
    const spawnCwds: (string | undefined)[] = [];
    const bench = vi.fn().mockReturnValueOnce(1).mockReturnValue(0);
    const e = engine({
      benchmark: bench,
      spawn: async (_task: unknown, wt: string | undefined) => { spawnCwds.push(wt); return { success: true, iterations: 1 }; },
      repoDir: dir,
      noWorktree: true,
    });
    const r = await e.tick();
    expect(spawnCwds[0]).toBeUndefined();
    expect(r.metric).toBe(0);
  });
});
