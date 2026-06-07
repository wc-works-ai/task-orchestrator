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
    const r = await new Engine(dir, { benchmark: zero }).tick();
    expect(r.task).not.toBeNull();
    expect(r.task!.number).toBe(1);
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
});
