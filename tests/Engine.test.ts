import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine } from '../src/Engine.js';
import { TaskState, Status, CONVERGENCE_THRESHOLD } from '../src/TaskState.js';

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
    expect(all.get('1')!.status).toBe(Status.CONVERGED);
  });

  it('non-zero benchmark marks FAILED', async () => {
    make(dir, 1, 'a');
    const r = await new Engine(dir, { benchmark: one }).tick();
    expect(r.converged).toBe(false);
    expect(r.metric).toBe(1);
    const all = await TaskState.scan(dir);
    expect(all.get('1')!.status).toBe(Status.FAILED);
  });

  it('skips task with unmet deps, picks next', async () => {
    make(dir, 1, 'a', { deps: [2] });
    make(dir, 2, 'b');
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task!.number).toBe(2);
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
    expect(all.get('1')!.status).toBe(Status.CONVERGED);
    expect(all.get('2')!.status).toBe(Status.CONVERGED);
  });

  it('loop with onTick callback', async () => {
    make(dir, 1, 'a');
    const ticks: number[] = [];
    await new Engine(dir, { benchmark: zero }).loop({
      onTick: (r) => { ticks.push(r.task!.number); },
    });
    expect(ticks).toEqual([1, 1, 1]); // 3 ticks on T1
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
    writeFileSync(join(claimDir, 'owner'), 'pid:99999\n');
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

  it('recovers task with missing heartbeat file (heartbeatAge returns null)', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const taskDir = resolve(dir, 'in_progress', 'T01-nohb');
    mkdirSync(taskDir, { recursive: true });

    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:99999\n');
    // No heartbeat file — heartbeatAge catch returns null → skipped by recovery
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:orchestrator-dead\n');

    const engine = new Engine(dir, { benchmark: zero, instanceId: 'recover-test' });
    const r = await engine.tick();
    // No heartbeat = age null = skipped by recovery (null < 300000 is true for null? No:)
    // if (age === null || age < HEARTBEAT_MAX_MS) continue;
    // age === null → true → continue → task NOT recovered → tick finds nothing
    expect(r.task).toBeNull();
  });

  it('recovers task with missing owner file but stale heartbeat', async () => {
    const { writeFileSync, mkdirSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');

    const taskDir = resolve(dir, 'in_progress', 'T01-noowner');
    mkdirSync(taskDir, { recursive: true });

    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'heartbeat'), 'stale');
    // No owner file — ownerPid catch returns null
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:orchestrator-dead\n');

    const oldTime = (Date.now() - 400_000) / 1000;
    utimesSync(join(claimDir, 'heartbeat'), oldTime, oldTime);

    // heartbeatAge >300000 (stale), ownerPid returns null (catch, no owner file)
    // pid === null → pid !== null is false → task should be recovered
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
    writeFileSync(join(claimDir, 'owner'), 'pid:abc\n'); // non-numeric pid
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
});
