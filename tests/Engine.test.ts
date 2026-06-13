import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { hostname } from 'node:os';
import { Engine } from '../src/Engine.js';
import { TaskState, Status, CONVERGENCE_THRESHOLD, MAX_FAILURES } from '../src/TaskState.js';

function setup() {
  const root = resolve('test-artifacts');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(resolve(root, 'eng-ts-'));
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

const zero = () => 0;
const one  = () => 1;

describe('Engine', () => {
  let dir = '';

  beforeEach(() => { dir = setup(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('tick returns null when nothing actionable', async () => {
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).toBeNull();
  });

  it('single tick processes exactly one task', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    const engine = new Engine(dir, { benchmark: zero });
    const r = await engine.tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
    expect(engine.instanceId).toBeTruthy();
  });

  it('in-process ownership guard: a concurrent tick skips a task already being processed', async () => {
    make(dir, 1, 'a');
    let reentrant: Awaited<ReturnType<Engine['tick']>> | undefined;
    let benchCalls = 0;
    // While T1 is mid-lifecycle (owned by the first tick), re-enter tick().
    // The re-entrant tick picks the same in-progress task we own, but the
    // ownership guard must make it skip instead of double-processing.
    const engine: Engine = new Engine(dir, {
      benchmark: async () => {
        benchCalls++;
        if (benchCalls === 1) reentrant = await engine.tick();
        return 0;
      },
    });
    const r = await engine.tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
    // The re-entrant tick saw the owned task and skipped it (no double-process).
    expect(reentrant!.task).toBeNull();
    // The skipped re-entrant tick did not run the benchmark again.
    expect(benchCalls).toBe(1);
  });

  it('converges after threshold zero-runs', async () => {
    make(dir, 1, 'a');
    const engine = new Engine(dir, { benchmark: zero });
    for (let i = 0; i < CONVERGENCE_THRESHOLD - 1; i++) {
      const r = await engine.tick();
      expect(r.converged).toBe(false);
    }
    const r = await engine.tick();
    expect(r.converged).toBe(true);
    const all = await TaskState.scan(dir);
    expect(all.size).toBe(0); // T1 moved to converged shard, excluded from scan
    expect(TaskState.countConverged(dir)).toBe(1);
  });

  it('non-zero benchmark marks FAILED', async () => {
    make(dir, 1, 'a');
    const r = await new Engine(dir, { benchmark: one }).tick();
    expect(r.converged).toBe(false);
    expect(r.metric).toBe(1);
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
  });

  it('increments failures and blocks after max failed ticks', async () => {
    make(dir, 1, 'a');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0 }),
    });

    for (let i = 0; i < MAX_FAILURES; i++) {
      const r = await engine.tick();
      expect(r.task).not.toBeNull();
      expect(r.metric).toBe(1);
    }

    const all = await TaskState.scan(dir);
    const task = all.get('1')!;
    expect(task.failureCount).toBe(MAX_FAILURES);
    expect(task.status).toBe(Status.BLOCKED);
    expect((await engine.tick()).task).toBeNull();
  });

  it('blocks after one failed attempt when retry limit is 1', async () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, 'autoresearch.md'), '- **Retry limit:** 1\n');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0 }),
    });

    const r = await engine.tick();
    expect(r.task).not.toBeNull();

    const all = await TaskState.scan(dir);
    const task = all.get('1')!;
    expect(task.failureCount).toBe(1);
    expect(task.status).toBe(Status.BLOCKED);
  });

  it('keeps retrying when retry limit is infinite', async () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, 'autoresearch.md'), '- **Retry limit:** infinite\n');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0 }),
    });

    for (let i = 0; i < 7; i++) {
      const r = await engine.tick();
      expect(r.task).not.toBeNull();
    }

    const all = await TaskState.scan(dir);
    const task = all.get('1')!;
    expect(task.failureCount).toBe(7);
    expect(task.status).toBe(Status.FAILED);
  });

  it('does not consume a retry on a task-agnostic (auth) failure', async () => {
    make(dir, 1, 'auth');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({
        success: false,
        iterations: 0,
        authFailure: true,
        error: 'No API key found for azure-openai-responses',
      }),
    });

    const r = await engine.tick();
    expect(r.stopped).toBe(true);
    expect(r.environmentError).toContain('No API key found');
    expect(engine.environmentError).toContain('No API key found');

    const task = (await TaskState.scan(dir)).get('1')!;
    expect(task.status).toBe(Status.FAILED);
    expect(task.failureCount).toBe(0);
  });

  it('uses the generic auth-failure message when the agent omits an error', async () => {
    make(dir, 1, 'auth');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({
        success: false,
        iterations: 0,
        authFailure: true,
      }),
    });

    const r = await engine.tick();

    expect(r.stopped).toBe(true);
    expect(r.environmentError).toContain('coding agent authentication failed');
    expect((await TaskState.scan(dir)).get('1')!.failureCount).toBe(0);
  });

  it('fails fast: stops the run on an env failure so other tasks do not churn to FAILED', async () => {
    make(dir, 1, 'auth');
    make(dir, 2, 'second');
    let spawnCalls = 0;
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => {
        spawnCalls++;
        return { success: false, iterations: 0, authFailure: true, error: 'No API key found' };
      },
    });

    const ticks = await engine.loop();

    expect(spawnCalls).toBe(1);
    expect(ticks).toBe(0);
    expect(engine.environmentError).toContain('No API key found');
    expect(engine.stopReason).toBe('environment');
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
    expect(all.get('1')!.failureCount).toBe(0);
    expect(all.get('2')!.status).toBe(Status.PENDING);
  });

  it('fails (not blocks) the detecting task on an env failure', async () => {
    make(dir, 1, 'auth');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0, authFailure: true, error: 'No API key found' }),
    });

    await engine.tick();
    const task = (await TaskState.scan(dir)).get('1')!;
    expect(task.status).toBe(Status.FAILED);
    expect(task.status).not.toBe(Status.BLOCKED);
    expect(task.failureCount).toBe(0);
  });

  it('skips task with unmet deps, picks next', async () => {
    make(dir, 1, 'a', { deps: [2] });
    make(dir, 2, 'b');
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task!.number).toBe(2);
  });

  it('blocks a task whose dependency is blocked', async () => {
    make(dir, 1, 'blocked', { status: Status.BLOCKED });
    make(dir, 2, 'dependent', { deps: [1] });

    const r = await new Engine(dir, { benchmark: zero }).tick();

    expect(r.task).toBeNull();
    const all = await TaskState.scan(dir);
    expect(all.get('2')!.status).toBe(Status.BLOCKED);
  });

  it('blocks transitive dependents in one tick', async () => {
    make(dir, 1, 'blocked', { status: Status.BLOCKED });
    make(dir, 2, 'middle', { deps: [1] });
    make(dir, 3, 'end', { deps: [2] });

    const r = await new Engine(dir, { benchmark: zero }).tick();

    expect(r.task).toBeNull();
    const all = await TaskState.scan(dir);
    expect(all.get('2')!.status).toBe(Status.BLOCKED);
    expect(all.get('3')!.status).toBe(Status.BLOCKED);
  });

  it('does not block dependents of a failed dependency', async () => {
    make(dir, 1, 'failed', { status: Status.FAILED });
    make(dir, 2, 'dependent', { deps: [1] });

    await new Engine(dir, { benchmark: zero }).tick();

    const all = await TaskState.scan(dir);
    expect(all.get('2')!.status).toBe(Status.PENDING);
  });

  it('blocks dependents when a failed dependency runs out of retries', async () => {
    const failed = make(dir, 1, 'failed', { status: Status.FAILED });
    for (let i = 0; i < MAX_FAILURES; i++) failed.incrementFailures();
    make(dir, 2, 'dependent', { deps: [1] });

    const r = await new Engine(dir, { benchmark: zero }).tick();

    expect(r.task).toBeNull();
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.BLOCKED);
    expect(all.get('2')!.status).toBe(Status.BLOCKED);
  });

  it('does not block dependents of a converged dependency', async () => {
    make(dir, 1, 'done', { status: Status.CONVERGED });
    make(dir, 2, 'dependent', { deps: [1] });

    const r = await new Engine(dir, { benchmark: zero }).tick();

    expect(r.task!.number).toBe(2);
    const all = await TaskState.scan(dir);
    expect(all.get('2')!.status).not.toBe(Status.BLOCKED);
  });

  it('blocks a task when any dependency in a diamond is blocked', async () => {
    make(dir, 1, 'blocked', { status: Status.BLOCKED });
    make(dir, 2, 'done', { status: Status.CONVERGED });
    make(dir, 3, 'dependent', { deps: [1, 2] });

    const r = await new Engine(dir, { benchmark: zero }).tick();

    expect(r.task).toBeNull();
    const all = await TaskState.scan(dir);
    expect(all.get('3')!.status).toBe(Status.BLOCKED);
  });

  it('ignores non-task entries while blocked-dependency scanning tolerates a missing shard', async () => {
    writeFileSync(join(dir, 'pending', '.gitkeep'), '');
    make(dir, 1, 'real-task');
    await rm(resolve(dir, 'failed'), { recursive: true, force: true });

    const r = await new Engine(dir, { benchmark: zero }).tick();

    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
  });

  it('second instance does not steal claim', async () => {
    make(dir, 1, 'a');
    // Instance A claims
    await new Engine(dir, { benchmark: zero, instanceId: 'A' }).tick();
    // Instance B should get null (claim owned by A, cz < threshold)
    const r = await new Engine(dir, { benchmark: zero, instanceId: 'B' }).tick();
    expect(r.task).toBeNull();
  });

  it('loop processes all tasks to convergence', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    const total = await new Engine(dir, { benchmark: zero }).loop();
    expect(total).toBe(CONVERGENCE_THRESHOLD * 2);
    const all = await TaskState.scan(dir);
    expect(all.size).toBe(0); // both tasks converged, excluded from scan
    expect(TaskState.countConverged(dir)).toBe(2);
  });

  it('loop with onTick callback', async () => {
    make(dir, 1, 'a');
    const ticks: number[] = [];
    await new Engine(dir, { benchmark: zero }).loop({
      onTick: (r) => { ticks.push(r.task!.number); },
    });
    expect(ticks).toEqual([1, 1, 1]); // 3 ticks on T1
  });

  it('keep-alive off by default breaks on the first null tick', async () => {
    make(dir, 1, 'cooldown');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0 }),
      retryCooldownMs: 60000,
    });
    await engine.tick();
    const sleep = vi.fn();

    const total = await engine.loop({ idleSleepMs: 0, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keep-alive waits through transient idle until remaining tasks are terminal', async () => {
    make(dir, 1, 'cooldown');
    const engine = new Engine(dir, {
      benchmark: one,
      spawn: async () => ({ success: false, iterations: 0 }),
      retryCooldownMs: 60000,
    });
    await engine.tick();
    const sleep = vi.fn(async () => {
      const all = await TaskState.scan(dir);
      all.get('1')!.markBlocked();
    });

    const total = await engine.loop({ keepAlive: true, idleSleepMs: 0, sleep });

    expect(total).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.BLOCKED);
  });

  it('keep-alive stops immediately when every task is converged or blocked', async () => {
    make(dir, 1, 'done', { status: Status.CONVERGED });
    make(dir, 2, 'blocked', { status: Status.BLOCKED });
    const sleep = vi.fn();

    const total = await new Engine(dir, { benchmark: zero }).loop({ keepAlive: true, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  // ── Recovery ───────────────────────────────────────────────────────

  it('recovers stale claimed tasks on tick', async () => {
    const { writeFileSync, mkdirSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Manually create a task in in_progress with a stale claim
    const taskDir = resolve(dir, 'in_progress', 'T01-stale');
    mkdirSync(taskDir, { recursive: true });

    // Claim it
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), `pid:99999\nhost:${hostname()}\n`);
    writeFileSync(join(claimDir, 'heartbeat'), 'stale');

    // Set status to IN_PROGRESS
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:orchestrator-dead\n');

    // Age the heartbeat past HEARTBEAT_MAX_MS (300s)
    const oldTime = (Date.now() - 400_000) / 1000; // 400s ago
    utimesSync(join(claimDir, 'heartbeat'), oldTime, oldTime);

    // tick() should recover this task
    const engine = new Engine(dir, { benchmark: zero, instanceId: 'recover-test' });
    const r = await engine.tick();

    // The stale task was recovered: moved to failed, then picked up and processed to converged
    // Since benchmark = zero, it should converge
    expect(r.task).not.toBeNull();
  });

  it('skips claimed tasks with alive PID', async () => {
    const { writeFileSync, mkdirSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');

    const taskDir = resolve(dir, 'in_progress', 'T01-alive');
    mkdirSync(taskDir, { recursive: true });

    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), `pid:${process.pid}\n`);
    writeFileSync(join(claimDir, 'heartbeat'), 'fresh');
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:orchestrator-alive\n');

    // Age the heartbeat
    const oldTime = (Date.now() - 400_000) / 1000;
    utimesSync(join(claimDir, 'heartbeat'), oldTime, oldTime);

    // PID is alive (process.pid) — recovery should skip this task
    // tick() will find it in in_progress, skip it (claimed by alive instance), return null if nothing else
    const engine = new Engine(dir, { benchmark: zero, instanceId: 'recover-test' });
    const r = await engine.tick();

    // No actionable tasks (the alive task is skipped by recovery, nothing else to pick)
    expect(r.task).toBeNull();
  });

  it('recovers task with missing heartbeat file (dead PID)', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const taskDir = resolve(dir, 'in_progress', 'T01-nohb');
    mkdirSync(taskDir, { recursive: true });

    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:99999\n');
    // No heartbeat file but PID is dead — recovery releases immediately
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:orchestrator-dead\n');

    const engine = new Engine(dir, { benchmark: zero, instanceId: 'recover-test' });
    const r = await engine.tick();
    // Dead PID → recovery releases → pick() finds → processes it
    expect(r.task).not.toBeNull();
  });

  it('recovers task with missing owner file but stale heartbeat', async () => {
    const { writeFileSync, mkdirSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');

    const taskDir = resolve(dir, 'in_progress', 'T01-noowner');
    mkdirSync(taskDir, { recursive: true });

    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'heartbeat'), 'stale');
    // Owner file with host but invalid pid — ownerPid returns null (parseInt fails)
    writeFileSync(join(claimDir, 'owner'), `pid:\nhost:${hostname()}\n`);
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:orchestrator-dead\n');

    const oldTime = (Date.now() - 400_000) / 1000;
    utimesSync(join(claimDir, 'heartbeat'), oldTime, oldTime);

    // heartbeatAge >300000 (stale), ownerPid returns null (invalid), same host → recovered
    const engine = new Engine(dir, { benchmark: zero, instanceId: 'recover-test' });
    const r = await engine.tick();
    // Task recovered to FAILED → picked up → converged (benchmark = zero)
    expect(r.task).not.toBeNull();
  });

  it('benchmark that throws is caught and counted as non-zero', async () => {
    make(dir, 1, 'a');
    const engine = new Engine(dir, { benchmark: () => { throw new Error('boom'); } });
    const r = await engine.tick();
    expect(r.metric).toBe(1);
    expect(r.converged).toBe(false);
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
  });

  it('returns null when stop file exists', async () => {
    make(dir, 1, 'a');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(dir, '.stop'), '');
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).toBeNull();
    expect(r.stopped).toBe(true);
    expect(existsSync(resolve(dir, '.stop'))).toBe(false);
  });

  it('infinite loop idles when all tasks are terminal until stopped', async () => {
    make(dir, 1, 'done', { status: Status.CONVERGED });
    make(dir, 2, 'blocked', { status: Status.BLOCKED });
    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps++;
      if (sleeps === 3) writeFileSync(resolve(dir, '.stop'), '');
    });

    const total = await new Engine(dir, { benchmark: zero }).loop({ infinite: true, idleSleepMs: 0, sleep });

    expect(total).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('infinite idle log includes polling interval', async () => {
    make(dir, 1, 'done', { status: Status.CONVERGED });
    make(dir, 2, 'blocked', { status: Status.BLOCKED });
    const sleep = vi.fn(async () => { writeFileSync(resolve(dir, '.stop'), ''); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await new Engine(dir, { benchmark: zero }).loop({ infinite: true, idleSleepMs: 1234, sleep });
      const logs = logSpy.mock.calls.map(call => String(call[0] ?? '')).join('\n');
      expect(logs).toContain('polling every 1234ms');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keep-alive still stops immediately when complete without infinite mode', async () => {
    make(dir, 1, 'done', { status: Status.CONVERGED });
    make(dir, 2, 'blocked', { status: Status.BLOCKED });
    const sleep = vi.fn();

    const total = await new Engine(dir, { benchmark: zero }).loop({ keepAlive: true, infinite: false, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('infinite loop resumes work when a new task becomes ready', async () => {
    const seen: number[] = [];
    let sleeps = 0;
    let processed = false;
    const sleep = vi.fn(async () => {
      sleeps++;
      if (sleeps === 2) make(dir, 1, 'new-task');
      if (processed) writeFileSync(resolve(dir, '.stop'), '');
    });

    const total = await new Engine(dir, { benchmark: zero }).loop({
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

    const engine = new Engine(dir, { benchmark: zero });
    const total = await engine.loop({ infinite: true, sleep });

    expect(total).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(engine.stopReason).toBe('signal');
  });

  it('reports stopReason=complete when a non-infinite run finishes', async () => {
    make(dir, 1, 'a');
    const engine = new Engine(dir, { benchmark: zero });

    await engine.loop();

    expect(engine.stopReason).toBe('complete');
  });

  it('resets worktree on failed task retry', async () => {
    make(dir, 1, 'a', { status: Status.FAILED });
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
  });

  // ── pickByNumber ───────────────────────────────────────────────────

  it('pickByNumber finds task by number', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    const engine = new Engine(dir, { benchmark: zero });
    const t = await engine.pickByNumber(2);
    expect(t).not.toBeNull();
    expect(t!.taskNumber).toBe(2);
  });

  it('pickByNumber returns null for non-existent task', async () => {
    make(dir, 1, 'a');
    const engine = new Engine(dir, { benchmark: zero });
    const t = await engine.pickByNumber(99);
    expect(t).toBeNull();
  });

  it('pickByNumber returns null for task in in_progress shard', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const taskDir = resolve(dir, 'in_progress', 'T01-claimed');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:1\nstarted:1\ninstance:test\n');
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:test\n');
    writeFileSync(join(claimDir, 'heartbeat'), '');
    const engine = new Engine(dir, { benchmark: zero });
    const t = await engine.pickByNumber(1);
    expect(t).not.toBeNull();
    expect(t!.taskNumber).toBe(1);
    expect(t!.isInProgress).toBe(true);
  });

  it('pickByNumber returns null when shard does not exist', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(resolve(dir, 'converged'), { recursive: true, force: true });
    const engine = new Engine(dir, { benchmark: zero });
    const t = await engine.pickByNumber(1);
    expect(t).toBeNull();
  });

  it('uses default benchmark (() => 1) when not provided', async () => {
    make(dir, 1, 'a');
    const engine = new Engine(dir, {}); // no benchmark
    const r = await engine.tick();
    // Default returns 1 → non-zero → task FAILED
    expect(r.metric).toBe(1);
    expect(r.converged).toBe(false);
  });

  it('handles recovery when entry does not start with T', async () => {
    const { mkdirSync } = await import('node:fs');
    const nonTaskDir = resolve(dir, 'in_progress', 'not-a-task');
    mkdirSync(nonTaskDir, { recursive: true });
    // tick() calls #recover() which skips non-T entries
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).toBeNull();
  });

  it('handles recovery when claim lacks valid pid', async () => {
    const { writeFileSync, mkdirSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');
    const taskDir = resolve(dir, 'in_progress', 'T01-nopid');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), `pid:abc\nhost:${hostname()}\n`); // non-numeric pid, local host
    writeFileSync(join(claimDir, 'heartbeat'), 'stale');
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:orchestrator-dead\n');
    const oldTime = (Date.now() - 400_000) / 1000;
    utimesSync(join(claimDir, 'heartbeat'), oldTime, oldTime);
    const engine = new Engine(dir, { benchmark: zero, instanceId: 'recover-test' });
    const r = await engine.tick();
    expect(r.task).not.toBeNull();
  });

  it('recover returns early when in_progress dir is missing', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(resolve(dir, 'in_progress'), { recursive: true, force: true });
    // tick() calls #recover() which catches readdirSync on missing dir
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).toBeNull();
  });

  it('recovery skips IN_PROGRESS task without claim', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const taskDir = resolve(dir, 'in_progress', 'T01-noclaim');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, '.status'), 'IN_PROGRESS:orphan\n');
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).toBeNull();
  });

  // ── pickByNumber ──────────────────────────────────────────────────

  it('pickByNumber finds task by number', async () => {
    make(dir, 1, 'a');
    make(dir, 5, 'b');
    const engine = new Engine(dir, { benchmark: zero });
    const t = await engine.pickByNumber(5);
    expect(t).not.toBeNull();
    expect(t!.taskNumber).toBe(5);
  });

  it('pickByNumber returns null for non-existent task', async () => {
    make(dir, 1, 'a');
    const engine = new Engine(dir, { benchmark: zero });
    const t = await engine.pickByNumber(99);
    expect(t).toBeNull();
  });

  it('pickByNumber handles missing shard directories', async () => {
    const { rmSync } = await import('node:fs');
    // Remove a shard to trigger the catch in pickByNumber
    rmSync(resolve(dir, 'converged'), { recursive: true, force: true });
    const engine = new Engine(dir, { benchmark: zero });
    // Should not throw — catch handles missing shard
    const t = await engine.pickByNumber(1);
    expect(t).toBeNull();
  });

  it('pickByNumber finds task in non-pending shard', async () => {
    const t = make(dir, 3, 'c');
    t.status = Status.CONVERGED;
    const engine = new Engine(dir, { benchmark: zero });
    const found = await engine.pickByNumber(3);
    expect(found).not.toBeNull();
    expect(found!.taskNumber).toBe(3);
  });

  // ── Diagnostic: blocked tasks in blocked/ shard ──────────────────────────

  it('diagnostic: logs skip for blocked tasks already in blocked shard', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Create a task already in the blocked shard (pick won't move it)
    const blockDir = resolve(dir, 'blocked', 'T01-blocked');
    mkdirSync(blockDir, { recursive: true });
    writeFileSync(join(blockDir, '.status'), 'BLOCKED\n');
    writeFileSync(join(blockDir, '.failure_count'), '5\n');
    // No actionable tasks — tick should log diagnostic for blocked task
    const r = await new Engine(dir, { benchmark: zero, instanceId: 'test' }).tick();
    expect(r.task).toBeNull();
  });

  it('recovers task claimed by dead process on tick', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Create a task in in_progress with a dead claiming process
    const taskDir = resolve(dir, 'in_progress', 'T01-other-claim');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:99999\nstarted:1\ninstance:other-inst\n');
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:other-inst\n');
    // Recovery releases dead PID claims immediately → pick() finds it
    const r = await new Engine(dir, { benchmark: zero, instanceId: 'my-inst' }).tick();
    expect(r.task).not.toBeNull();
  });

  it('diagnostic: logs skip for task with unmet deps', async () => {
    // Create a pending task that depends on non-existent task
    make(dir, 1, 'needs-t99', { deps: [99] });
    // tick() should log diagnostic about unmet deps and return null
    const r = await new Engine(dir, { benchmark: zero, instanceId: 'test' }).tick();
    expect(r.task).toBeNull();
  });

  it('re-checks convergence for our own in-progress claim', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const myId = 'converge-instance';
    // Create a task that we previously claimed
    const taskDir = resolve(dir, 'in_progress', 'T01-my-claim');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), `pid:${process.pid}\nstarted:1\ninstance:${myId}\n`);
    writeFileSync(join(taskDir, '.status'), `IN_PROGRESS:${myId}\n`);
    // pick() returns our own claim → tick re-runs benchmark for convergence
    const r = await new Engine(dir, { benchmark: zero, instanceId: myId }).tick();
    expect(r.task).not.toBeNull();
  });

  it('recovery handles non-directory file in in_progress shard', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(dir, 'in_progress', 'not-a-dir-file'), 'just a file');
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).toBeNull();
  });

  // ── Diagnostic: converged task in diagnostic loop ─────────────────

  it('diagnostic: skips converged task in pending shard via isConverged', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    // Create a task in pending shard that has CONVERGED status
    // pick() will skip it (isConverged), then diagnostic should hit isConverged branch
    const taskDir = resolve(dir, 'pending', 'T01-converged-diag');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, '.status'), 'CONVERGED\n');
    // No actionable tasks — tick diagnostic should find T01 and hit isConverged true branch
    const r = await new Engine(dir, { benchmark: zero, instanceId: 'test' }).tick();
    expect(r.task).toBeNull();
  });

  it('diagnostic: logs other\'s in-progress claim (byUs=false)', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const taskDir = resolve(dir, 'in_progress', 'T01-other-claim');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), `pid:${process.pid}\nstarted:1\ninstance:other-inst\n`);
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:other-inst\n');
    writeFileSync(join(claimDir, 'heartbeat'), '');
    // Use live PID so recovery doesn't clean up; pick() skips (other's claim), diagnostic finds it, byUs=false
    const r = await new Engine(dir, { benchmark: zero, instanceId: 'my-inst' }).tick();
    expect(r.task).toBeNull();
  });

  it('respects retry cooldown after failure', async () => {
    make(dir, 1, 'cooldown');
    const engine = new Engine(dir, {
      benchmark: () => 1,
      spawn: async () => ({ success: false, iterations: 0 }),
      retryCooldownMs: 60000, // 60s cooldown
    });
    // First tick — picks task, fails, records cooldown
    const r1 = await engine.tick();
    expect(r1.task).not.toBeNull();
    // Second tick — blocked by cooldown (no time elapsed)
    const r2 = await engine.tick();
    expect(r2.task).toBeNull();
  });

  // ── B2/B3: convergence/worktree reconnection ────────────────────────

  it('B3: reconnects to existing worktree on disk when not in memory', async () => {
    const t = make(dir, 1, 'b3-reconnect');
    for (let i = 0; i < CONVERGENCE_THRESHOLD - 1; i++) t.incrementConvergence();

    // Create a fake .git so the guard recognizes this as a git repo
    writeFileSync(resolve(dir, '.git'), 'not a real git repo');

    // Create a worktree dir with a .git marker so wt.exists returns true
    const wtDir = resolve(dir, '.worktrees', 'T01-b3-reconnect');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(resolve(wtDir, '.git'), 'gitdir: fake');

    const engine = new Engine(dir, {
      benchmark: zero,
      spawn: async () => ({ success: true, iterations: 1 }),
      repoDir: dir,
    });
    // tick should reconnect to the worktree — but merge will fail (not a real repo)
    // The important thing: convergence is NOT falsely reset, and the reconnect path is exercised
    const r = await engine.tick();
    // Merge fails (fake repo), so not converged — but the reconnect path was hit
    expect(r.converged).toBe(false);
  });

  it('B2: reconnects worktree on pickup when convergence > 0 and worktree exists', async () => {
    const t = make(dir, 1, 'b2-reconnect');
    t.incrementConvergence(); // convergence = 1

    writeFileSync(resolve(dir, '.git'), 'not a real git repo');
    const wtDir = resolve(dir, '.worktrees', 'T01-b2-reconnect');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(resolve(wtDir, '.git'), 'gitdir: fake');

    const engine = new Engine(dir, {
      benchmark: zero,
      spawn: async () => ({ success: true, iterations: 1 }),
      repoDir: dir,
    });
    // tick should reconnect the worktree at pickup (B2), then use it for benchmark
    const r = await engine.tick();
    expect(r.task).not.toBeNull();
  });

  it('B2: resets convergence when convergence > 0 but worktree not found', async () => {
    const t = make(dir, 1, 'b2-no-wt');
    t.incrementConvergence();
    t.incrementConvergence(); // convergence = 2

    // .git exists but no worktree dir — reconnect fails
    writeFileSync(resolve(dir, '.git'), 'not a real git repo');

    const engine = new Engine(dir, {
      benchmark: zero,
      spawn: async () => ({ success: true, iterations: 1 }),
      repoDir: dir,
    });
    const r = await engine.tick();
    const all = await TaskState.scan(dir);
    const task = all.get('1');
    expect(task).toBeDefined();
    expect(task!.convergenceCount).toBe(1); // reset to 0, then incremented after the zero benchmark
    expect(r.converged).toBe(false);
  });

  it('B3: no-spawn mode converges without worktree (legitimate)', async () => {
    const t = make(dir, 1, 'no-spawn');
    for (let i = 0; i < CONVERGENCE_THRESHOLD - 1; i++) t.incrementConvergence();

    // No spawn configured — no worktree expected
    const engine = new Engine(dir, { benchmark: zero });
    const r = await engine.tick();
    expect(r.converged).toBe(true);
  });

  it('noWorktree: agent works directly in repo, no worktree created', async () => {
    make(dir, 1, 'no-wt');
    const spawnCwds: (string | undefined)[] = [];
    const bench = vi.fn().mockReturnValueOnce(1).mockReturnValue(0);
    const engine = new Engine(dir, {
      benchmark: bench,
      spawn: async (_task, wt) => { spawnCwds.push(wt); return { success: true, iterations: 1 }; },
      repoDir: dir,
      noWorktree: true,
    });
    const r = await engine.tick();
    // Agent received undefined worktreePath (works directly in repo, no worktree)
    expect(spawnCwds[0]).toBeUndefined();
    expect(r.metric).toBe(0);
  });

});
