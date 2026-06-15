import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { Engine } from '../../src/Engine.js';
import { Status, CONVERGENCE_THRESHOLD } from '../../src/TaskState.js';
import { DbBusyError } from '../../src/errors.js';
import { taskDirName, type TaskRow, type TaskStatus, type TaskDb } from '../../src/TaskDb.js';

// Engine decision logic only — no real git, filesystem, or SQLite. node:child_process
// (base-branch detection) and node:fs (stop file, logging) are mocked; migrate.ts and
// the TaskDb are replaced with in-memory fakes so each tick is instant.
const cph = vi.hoisted(() => ({ branch: 'main' }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFileSync: () => cph.branch };
});

const fsh = vi.hoisted(() => ({
  existsImpl: ((_p: string) => true) as (p: string) => boolean,
  appendFileSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => [] as string[]),
}));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: unknown) => fsh.existsImpl(String(p)),
    appendFileSync: fsh.appendFileSync,
    rmSync: fsh.rmSync,
    readdirSync: fsh.readdirSync,
  };
});

const migrateMock = vi.hoisted(() => vi.fn(() => 0));
vi.mock('../../src/migrate.js', () => ({ migrateShards: migrateMock }));

const DIR = join('virtual', 'engine-root');
const INSTANCE = 'inst-unit';

const defaultExists = (p: string): boolean => !p.endsWith('.stop') && !p.endsWith('.git');

type MutableRow = { -readonly [K in keyof TaskRow]: TaskRow[K] };

/** In-memory TaskDb stand-in: just enough lifecycle for Engine's decision paths. */
class FakeTaskDb {
  rows: MutableRow[] = [];
  deps = new Map<number, number[]>();
  #nextId = 1;
  #token = 1000;

  seed(o: Partial<MutableRow> & { task_number: number; name?: string }): MutableRow {
    const number = o.task_number;
    const name = o.name ?? `t${number}`;
    const row: MutableRow = {
      id: o.id ?? this.#nextId++,
      task_number: number,
      name,
      dir: o.dir ?? taskDirName(number, name),
      status: o.status ?? 'PENDING',
      convergence: o.convergence ?? 0,
      failures: o.failures ?? 0,
      max_failures: o.max_failures ?? null,
      target_branch: o.target_branch ?? null,
      claimed_by: o.claimed_by ?? null,
      claim_token: o.claim_token ?? null,
      claimed_at: o.claimed_at ?? null,
      heartbeat: o.heartbeat ?? null,
      created_at: 0,
      updated_at: 0,
    };
    this.rows.push(row);
    return row;
  }

  setDeps(taskNumber: number, deps: number[]): void {
    this.deps.set(taskNumber, deps);
  }

  get(id: number): MutableRow | undefined {
    return this.rows.find(r => r.id === id);
  }
  getByNumber(n: number): MutableRow | undefined {
    return this.rows.find(r => r.task_number === n);
  }
  byStatus(statuses: readonly TaskStatus[]): MutableRow[] {
    return this.rows.filter(r => statuses.includes(r.status)).sort((a, b) => a.task_number - b.task_number);
  }
  dependencyNumbers(n: number): number[] {
    return (this.deps.get(n) ?? []).slice().sort((a, b) => a - b);
  }

  #depsMet(row: MutableRow): boolean {
    for (const d of this.deps.get(row.task_number) ?? []) {
      if (this.getByNumber(d)?.status !== 'CONVERGED') return false;
    }
    return true;
  }

  pick(instanceId: string): MutableRow | undefined {
    const next = this.rows
      .filter(r => (r.status === 'PENDING' || r.status === 'FAILED')
        && (r.max_failures === null || r.failures < r.max_failures)
        && this.#depsMet(r))
      .sort((a, b) => a.task_number - b.task_number)[0];
    if (!next) return undefined;
    next.status = 'IN_PROGRESS';
    next.claimed_by = instanceId;
    next.claim_token = `tok-${this.#token++}`;
    next.claimed_at = Date.now();
    next.heartbeat = Date.now();
    return next;
  }

  #gated(id: number, token: string, mutate: (r: MutableRow) => void): boolean {
    const r = this.get(id);
    if (!r || r.claim_token !== token) return false;
    mutate(r);
    return true;
  }
  incrementConvergence(id: number, token: string): boolean {
    return this.#gated(id, token, r => { r.convergence++; });
  }
  resetConvergence(id: number, token: string): boolean {
    return this.#gated(id, token, r => { r.convergence = 0; });
  }
  incrementFailures(id: number, token: string): number | null {
    let total: number | null = null;
    this.#gated(id, token, r => { r.failures++; total = r.failures; });
    return total;
  }
  heartbeat(id: number, token: string): boolean {
    return this.#gated(id, token, r => { r.heartbeat = Date.now(); });
  }
  release(id: number, token: string, status: TaskStatus): boolean {
    return this.#gated(id, token, r => { this.#clearClaim(r); r.status = status; });
  }
  block(id: number): boolean {
    const r = this.get(id);
    if (!r) return false;
    this.#clearClaim(r);
    r.status = 'BLOCKED';
    r.convergence = 0;
    return true;
  }
  unblock(id: number): boolean {
    const r = this.get(id);
    if (!r) return false;
    this.#clearClaim(r);
    r.status = 'PENDING';
    r.failures = 0;
    r.convergence = 0;
    return true;
  }
  recoverStale(cutoff: number): number {
    let n = 0;
    for (const r of this.rows) {
      if (r.status === 'IN_PROGRESS' && (r.heartbeat ?? r.claimed_at ?? 0) < cutoff) {
        this.#clearClaim(r);
        r.status = 'FAILED';
        r.failures++;
        n++;
      }
    }
    return n;
  }
  cascadeBlock(): number {
    let n = 0;
    for (let changed = true; changed;) {
      changed = false;
      for (const r of this.rows) {
        if (r.status !== 'PENDING' && r.status !== 'FAILED') continue;
        const blockedDep = (this.deps.get(r.task_number) ?? []).some(d => this.getByNumber(d)?.status === 'BLOCKED');
        if (blockedDep) { r.status = 'BLOCKED'; n++; changed = true; }
      }
    }
    return n;
  }
  promote(id: number): boolean {
    const r = this.get(id);
    if (!r || r.status !== 'CREATING') return false;
    r.status = 'PENDING';
    return true;
  }
  remove(id: number): boolean {
    const i = this.rows.findIndex(r => r.id === id);
    if (i < 0) return false;
    this.rows.splice(i, 1);
    return true;
  }
  close(): void { /* injected handle — Engine never owns or closes it */ }

  #clearClaim(r: MutableRow): void {
    r.claimed_by = null;
    r.claim_token = null;
    r.claimed_at = null;
    r.heartbeat = null;
  }
}

const noopSleep = () => Promise.resolve();

function makeEngine(fake: FakeTaskDb, opts: Record<string, unknown> = {}): Engine {
  return new Engine(DIR, {
    taskDb: fake as unknown as TaskDb,
    noWorktree: true,
    instanceId: INSTANCE,
    sleep: noopSleep,
    idleSleepMs: 0,
    ...opts,
  });
}

let fake: FakeTaskDb;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake = new FakeTaskDb();
  fsh.existsImpl = defaultExists;
  fsh.appendFileSync.mockClear();
  fsh.rmSync.mockClear();
  fsh.readdirSync.mockReset();
  fsh.readdirSync.mockReturnValue([]);
  migrateMock.mockReset();
  migrateMock.mockReturnValue(0);
  cph.branch = 'main';
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('Engine.tick (mocked TaskDb, no worktree)', () => {
  it('detects the base branch from git output', () => {
    cph.branch = 'dev/feature\n';
    expect(makeEngine(fake).baseBranch).toBe('dev/feature');
  });

  it('returns a stopped result and removes the stop file when present', async () => {
    fsh.existsImpl = (p) => p.endsWith('.stop');
    const r = await makeEngine(fake).tick();
    expect(r.stopped).toBe(true);
    expect(r.task).toBeNull();
    expect(fsh.rmSync).toHaveBeenCalled();
  });

  it('returns null when nothing is actionable', async () => {
    const r = await makeEngine(fake).tick();
    expect(r.task).toBeNull();
    expect(r.converged).toBe(false);
  });

  it('invokes recoverStale and cascadeBlock every tick', async () => {
    const recoverSpy = vi.spyOn(fake, 'recoverStale');
    const cascadeSpy = vi.spyOn(fake, 'cascadeBlock');
    await makeEngine(fake).tick();
    expect(recoverSpy).toHaveBeenCalledWith(expect.any(Number));
    expect(cascadeSpy).toHaveBeenCalled();
  });

  it('logs idle reasons across blocked, foreign-claim, and unmet-dependency tasks', async () => {
    fake.seed({ task_number: 1, name: 'b', status: 'BLOCKED', failures: 2 });
    fake.seed({ task_number: 2, name: 'i', status: 'IN_PROGRESS', claimed_by: 'other-orch', claim_token: 't2', heartbeat: Date.now() + 60_000 });
    fake.seed({ task_number: 4, name: 'p' }); // PENDING, dep on the foreign-claimed T2 (unmet)
    fake.setDeps(4, [2]);
    const r = await makeEngine(fake).tick();
    expect(r.task).toBeNull();
    expect(fake.getByNumber(4)!.status).toBe('PENDING'); // not blocked: dep is not BLOCKED
  });

  it('converges after the threshold of zero-metric runs (benchmark-only)', async () => {
    fake.seed({ task_number: 1, name: 'a' });
    const e = makeEngine(fake, { benchmark: () => 0 });
    for (let i = 0; i < CONVERGENCE_THRESHOLD - 1; i++) {
      expect((await e.tick()).converged).toBe(false);
    }
    const last = await e.tick();
    expect(last.converged).toBe(true);
    expect(fake.getByNumber(1)!.status).toBe(Status.CONVERGED);
  });

  it('a non-zero metric resets convergence and FAILS the task with retries left', async () => {
    fake.seed({ task_number: 1, name: 'a', convergence: 2, max_failures: 5 });
    const resetSpy = vi.spyOn(fake, 'resetConvergence');
    const r = await makeEngine(fake, { benchmark: () => 1 }).tick();
    expect(r.metric).toBe(1);
    expect(r.converged).toBe(false);
    expect(resetSpy).toHaveBeenCalled();
    expect(fake.getByNumber(1)!.status).toBe(Status.FAILED);
    expect(fake.getByNumber(1)!.failures).toBe(1);
  });

  it('blocks the task once failures reach the retry limit', async () => {
    fake.seed({ task_number: 1, name: 'a', max_failures: 1 });
    await makeEngine(fake, { benchmark: () => 1 }).tick();
    expect(fake.getByNumber(1)!.status).toBe(Status.BLOCKED);
  });

  it('treats a throwing benchmark as metric 1 (failed attempt)', async () => {
    fake.seed({ task_number: 1, name: 'a', max_failures: 5 });
    const r = await makeEngine(fake, { benchmark: () => { throw new Error('boom'); } }).tick();
    expect(r.metric).toBe(1);
    expect(fake.getByNumber(1)!.status).toBe(Status.FAILED);
  });

  it('runs the spawn cycle when the metric is non-zero and re-checks after the agent', async () => {
    fake.seed({ task_number: 1, name: 'a' });
    let calls = 0;
    const benchmark = () => (calls++ === 0 ? 1 : 0); // initial non-zero, zero after the agent
    const spawn = vi.fn(async () => ({ success: true, iterations: 2 }));
    const r = await makeEngine(fake, { benchmark, spawn }).tick();
    expect(spawn).toHaveBeenCalledOnce();
    expect(r.converged).toBe(false); // one convergence, below threshold
    expect(fake.getByNumber(1)!.convergence).toBe(1);
  });

  it('stops the run (fail fast) on a coding-agent auth failure without consuming a retry', async () => {
    fake.seed({ task_number: 1, name: 'a' });
    const spawn = vi.fn(async () => ({ success: false, authFailure: true, error: 'auth bad', iterations: 0 }));
    const r = await makeEngine(fake, { benchmark: () => 1, spawn }).tick();
    expect(r.stopped).toBe(true);
    expect(r.environmentError).toBe('auth bad');
    expect(fake.getByNumber(1)!.status).toBe(Status.FAILED);
    expect(fake.getByNumber(1)!.failures).toBe(0); // not counted against retries
  });

  it('honors the retry cooldown by releasing without re-running the benchmark', async () => {
    fake.seed({ task_number: 1, name: 'a', max_failures: 5 });
    let benchCalls = 0;
    const e = makeEngine(fake, { benchmark: () => { benchCalls++; return 1; }, retryCooldownMs: 60_000 });
    await e.tick(); // fails → records cooldown
    const r2 = await e.tick(); // re-picked, but cooled down
    expect(benchCalls).toBe(1);
    expect(r2.task).toBeNull();
    expect(fake.getByNumber(1)!.status).toBe(Status.FAILED);
  });

  it('blocks a FAILED task that has already exhausted its retry budget', async () => {
    fake.seed({ task_number: 1, name: 'a', status: 'FAILED', failures: 5, max_failures: 5 });
    const r = await makeEngine(fake).tick();
    expect(r.task).toBeNull();
    expect(fake.getByNumber(1)!.status).toBe(Status.BLOCKED);
  });
});

describe('Engine startup reconciliation (mocked TaskDb)', () => {
  it('imports shards once, promotes a complete CREATING task, and drops an incomplete one', async () => {
    fake.seed({ task_number: 1, name: 'ready', status: 'CREATING' });
    fake.setDeps(1, [99]); // keep it from being picked after promotion
    fake.seed({ task_number: 2, name: 'incomplete', status: 'CREATING' });
    fsh.existsImpl = (p) => {
      if (p.endsWith('.stop') || p.endsWith('.git')) return false;
      if (p.endsWith('benchmark.js')) return p.includes('T01-ready'); // only the ready task has content
      return true;
    };
    await makeEngine(fake).tick();
    expect(migrateMock).toHaveBeenCalledOnce();
    expect(fake.getByNumber(1)!.status).toBe('PENDING'); // promoted
    expect(fake.getByNumber(2)).toBeUndefined(); // dropped
  });

  it('blocks an actionable task whose content directory has vanished', async () => {
    fake.seed({ task_number: 1, name: 'gone', status: 'PENDING' });
    fsh.existsImpl = (p) => {
      if (p.endsWith('.stop') || p.endsWith('.git')) return false;
      if (p.endsWith('T01-gone')) return false; // content dir missing
      return true;
    };
    await makeEngine(fake).tick();
    expect(fake.getByNumber(1)!.status).toBe('BLOCKED');
  });
});

describe('Engine.loop error dispatch and completion (mocked TaskDb)', () => {
  it('stops with an environment error on a FATAL DB error', async () => {
    vi.spyOn(fake, 'recoverStale').mockImplementation(() => { throw new DbBusyError('locked'); });
    const e = makeEngine(fake);
    const total = await e.loop();
    expect(total).toBe(0);
    expect(e.stopReason).toBe('environment');
    expect(e.environmentError).toBeDefined();
  });

  it('treats repeated unknown tick errors as transient, then stops at the ceiling', async () => {
    vi.spyOn(fake, 'recoverStale').mockImplementation(() => { throw new Error('transient'); });
    const e = makeEngine(fake);
    const total = await e.loop();
    expect(total).toBe(0);
    expect(e.stopReason).toBe('environment');
    expect(e.environmentError).toMatch(/repeated tick failures/);
  });

  it('recovers after a one-off tick error and completes when idle', async () => {
    let n = 0;
    vi.spyOn(fake, 'recoverStale').mockImplementation(() => {
      if (n++ === 0) throw new Error('one-off');
      return 0;
    });
    const e = makeEngine(fake);
    const total = await e.loop();
    expect(total).toBe(0);
    expect(e.stopReason).toBe('complete');
    expect(e.environmentError).toBeUndefined();
    expect(n).toBeGreaterThan(1);
  });

  it('reports a completed task via onTick and finishes when the queue drains', async () => {
    fake.seed({ task_number: 1, name: 'a', max_failures: 1 });
    const onTick = vi.fn();
    const e = makeEngine(fake, { benchmark: () => 1 });
    const total = await e.loop({ onTick });
    expect(total).toBe(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(fake.getByNumber(1)!.status).toBe(Status.BLOCKED);
    expect(e.stopReason).toBe('complete');
  });

  it('in infinite mode, idles until the stop signal arrives', async () => {
    let ticks = 0;
    fsh.existsImpl = (p) => {
      if (p.endsWith('.stop')) return ticks >= 1; // stop file appears after the first idle sleep
      if (p.endsWith('.git')) return false;
      return true;
    };
    const sleep = vi.fn(async () => { ticks++; });
    const e = makeEngine(fake, { infinite: true, sleep });
    await e.loop();
    expect(sleep).toHaveBeenCalled();
    expect(e.stopReason).toBe('signal');
  });
});
