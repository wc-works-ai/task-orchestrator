import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { resolve, join } from 'node:path';
import { TaskState, Status, inProgress, CONVERGENCE_THRESHOLD } from '../../src/state/TaskState.js';
import { taskDirName, type TaskRow, type TaskStatus, type TaskDb } from '../../src/state/TaskDb.js';

// TaskState reads content from autoresearch.md via node:fs and prunes via rmSync.
// Mock both so content getters and pruning are exercised without touching disk.
const h = vi.hoisted(() => ({
  content: new Map<string, string>(), // autoresearch path → file body
  rmSync: vi.fn(),
}));

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (p: unknown) => {
      const body = h.content.get(String(p));
      if (body === undefined) throw new Error(`ENOENT ${String(p)}`);
      return body;
    },
    rmSync: h.rmSync,
  };
});

const ROOT = join('virtual', 'taskstate-root');

const FULL_AR = [
  '# Task',
  '## Goal: Make it fast',
  '- **Model:** task-model',
  '- **Reasoning:** high',
  '## Acceptance criteria',
  'Track `latency`, `latency`, and `throughput`.',
  '## Scope',
  '- src/a.ts',
  '- src/b.ts',
].join('\n');

/** Build a TaskRow with sensible defaults; id defaults to the task number. */
function row(over: Partial<TaskRow> & { task_number: number }): TaskRow {
  const number = over.task_number;
  const name = over.name ?? `t${number}`;
  return {
    id: over.id ?? number,
    task_number: number,
    name,
    dir: over.dir ?? taskDirName(number, name),
    status: over.status ?? 'PENDING',
    convergence: over.convergence ?? 0,
    failures: over.failures ?? 0,
    priority: over.priority ?? 0,
    max_failures: over.max_failures ?? null,
    repo: over.repo ?? null,
    target_branch: over.target_branch ?? null,
    claimed_by: over.claimed_by ?? null,
    claim_token: over.claim_token ?? null,
    claimed_at: over.claimed_at ?? null,
    heartbeat: over.heartbeat ?? null,
    created_at: 0,
    updated_at: 0,
  };
}

interface FakeTdb {
  get: Mock;
  getByNumber: Mock;
  byStatus: Mock;
  dependencyNumbers: Mock;
  pick: Mock;
  incrementConvergence: Mock;
  resetConvergence: Mock;
  incrementFailures: Mock;
  heartbeat: Mock;
  release: Mock;
  block: Mock;
  unblock: Mock;
  cascadeBlock: Mock;
}

/** A TaskDb stand-in backed by plain maps; mutators are spies to assert delegation. */
function tdbWith(rows: TaskRow[] = []) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const byNum = new Map(rows.map(r => [r.task_number, r]));
  const deps = new Map<number, number[]>();
  const raw: FakeTdb = {
    get: vi.fn((id: number) => byId.get(id)),
    getByNumber: vi.fn((n: number) => byNum.get(n)),
    byStatus: vi.fn((st: readonly TaskStatus[]) =>
      rows.filter(r => st.includes(r.status)).sort((a, b) => a.task_number - b.task_number)),
    dependencyNumbers: vi.fn((n: number) => deps.get(n) ?? []),
    pick: vi.fn(),
    incrementConvergence: vi.fn(() => true),
    resetConvergence: vi.fn(() => true),
    incrementFailures: vi.fn(() => 1),
    heartbeat: vi.fn(() => true),
    release: vi.fn(() => true),
    block: vi.fn(() => true),
    unblock: vi.fn(() => true),
    cascadeBlock: vi.fn(() => 0),
  };
  return { tdb: raw as unknown as TaskDb, raw, byId, byNum, deps };
}

/** Build a TaskState view of `r`, registering its autoresearch.md body if given. */
function viewOf(
  r: TaskRow,
  opts: { autoresearch?: string; deps?: number[]; extra?: TaskRow[] } = {},
) {
  const ctx = tdbWith([r, ...(opts.extra ?? [])]);
  if (opts.deps) ctx.deps.set(r.task_number, opts.deps);
  if (opts.autoresearch !== undefined) {
    h.content.set(join(resolve(ROOT, r.dir), 'autoresearch.md'), opts.autoresearch);
  }
  return { state: TaskState.fromRow(ctx.tdb, ROOT, r), ...ctx };
}

beforeEach(() => {
  h.content.clear();
  h.rmSync.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaskState (mocked TaskDb)', () => {
  // ── Identity ──────────────────────────────────────────────────────────
  it('derives identity from the row and the tasks root', () => {
    const { state } = viewOf(row({ task_number: 1, name: 'auth' }));
    expect(state.taskNumber).toBe(1);
    expect(state.number).toBe(1);
    expect(state.taskName).toBe('T01-auth');
    expect(state.name).toBe('T01-auth');
    expect(state.directory).toBe(resolve(ROOT, 'T01-auth'));
    expect(state.cwd).toBe(resolve(ROOT, 'T01-auth'));
  });

  it('info materializes a plain TaskInfo snapshot', () => {
    const { state } = viewOf(row({ task_number: 2, name: 'speed', repo: resolve('repo-a') }), { autoresearch: FULL_AR });
    expect(state.info).toEqual({
      directory: resolve(ROOT, 'T02-speed'),
      number: 2,
      name: 'T02-speed',
      repo: resolve('repo-a'),
      goal: 'Make it fast',
      model: 'task-model',
      reasoning: 'high',
      status: Status.PENDING,
      cwd: resolve(ROOT, 'T02-speed'),
      metrics: ['latency', 'throughput'],
    });
  });

  // ── Status mapping ────────────────────────────────────────────────────
  it('falls back to PENDING (and zero state) when the row is gone', () => {
    const { tdb } = tdbWith([]); // get() returns undefined for any id
    const t = TaskState.fromRow(tdb, ROOT, row({ task_number: 1, claim_token: 'tok' }));
    expect(t.status).toBe(Status.PENDING);
    expect(t.isPending).toBe(true);
    expect(t.convergenceCount).toBe(0);
    expect(t.failureCount).toBe(0);
    expect(t.maxFailures).toBe(Infinity);
    expect(t.priority).toBe(0);
    expect(t.isClaimed).toBe(false);
    expect(t.claimOwnerId).toBe('');
    expect(t.repo).toBeUndefined();
    expect(t.targetBranch).toBeUndefined();
  });

  it('surfaces CREATING as PENDING', () => {
    const { state } = viewOf(row({ task_number: 1, status: 'CREATING' }));
    expect(state.status).toBe(Status.PENDING);
    expect(state.isPending).toBe(true);
  });

  it('embeds the claim owner for IN_PROGRESS, empty when unclaimed', () => {
    const owned = viewOf(row({ task_number: 1, status: 'IN_PROGRESS', claimed_by: 'orch-9', claim_token: 'tok' }));
    expect(owned.state.status).toBe(inProgress('orch-9'));
    expect(owned.state.isInProgress).toBe(true);
    expect(owned.state.isActionable).toBe(false);

    const unowned = viewOf(row({ task_number: 2, status: 'IN_PROGRESS', claimed_by: null }));
    expect(unowned.state.status).toBe(inProgress(''));
  });

  it('passes terminal statuses through directly', () => {
    expect(viewOf(row({ task_number: 1, status: 'FAILED' })).state.isFailed).toBe(true);
    expect(viewOf(row({ task_number: 2, status: 'BLOCKED' })).state.isBlocked).toBe(true);
    expect(viewOf(row({ task_number: 3, status: 'CONVERGED' })).state.isConverged).toBe(true);
    expect(viewOf(row({ task_number: 4, status: 'PENDING' })).state.isActionable).toBe(true);
  });

  // ── Convergence ───────────────────────────────────────────────────────
  it('reads convergenceCount and hasConverged from the row', () => {
    const below = viewOf(row({ task_number: 1, convergence: CONVERGENCE_THRESHOLD - 1 }));
    const at = viewOf(row({ task_number: 2, convergence: CONVERGENCE_THRESHOLD }));
    expect(below.state.convergenceCount).toBe(CONVERGENCE_THRESHOLD - 1);
    expect(below.state.hasConverged).toBe(false);
    expect(at.state.hasConverged).toBe(true);
  });

  it('delegates increment/reset convergence with the held claim token', () => {
    const { state, raw } = viewOf(row({ task_number: 1, status: 'IN_PROGRESS', claimed_by: 'me', claim_token: 'tok' }));
    state.incrementConvergence();
    expect(raw.incrementConvergence).toHaveBeenCalledWith(1, 'tok');
    state.resetConvergence();
    expect(raw.resetConvergence).toHaveBeenCalledWith(1, 'tok');
  });

  // ── Failures ──────────────────────────────────────────────────────────
  it('returns the new failure total, or 0 when the claim is stale', () => {
    const { state, raw } = viewOf(row({ task_number: 1, status: 'IN_PROGRESS', claimed_by: 'me', claim_token: 'tok' }));
    raw.incrementFailures.mockReturnValueOnce(2);
    expect(state.incrementFailures()).toBe(2);
    expect(raw.incrementFailures).toHaveBeenCalledWith(1, 'tok');
    raw.incrementFailures.mockReturnValueOnce(null);
    expect(state.incrementFailures()).toBe(0);
  });

  it('reads maxFailures from the row, Infinity when null', () => {
    expect(viewOf(row({ task_number: 1, max_failures: 3 })).state.maxFailures).toBe(3);
    expect(viewOf(row({ task_number: 2, max_failures: null })).state.maxFailures).toBe(Infinity);
  });

  it('reads priority from the row, defaulting to 0', () => {
    expect(viewOf(row({ task_number: 1, priority: 5 })).state.priority).toBe(5);
    expect(viewOf(row({ task_number: 2 })).state.priority).toBe(0);
  });

  // ── Claim ─────────────────────────────────────────────────────────────
  it('reports claim ownership from the row', () => {
    const claimed = viewOf(row({ task_number: 1, status: 'IN_PROGRESS', claimed_by: 'owner-x', claim_token: 'tok' }));
    const free = viewOf(row({ task_number: 2 }));
    expect(claimed.state.isClaimed).toBe(true);
    expect(claimed.state.claimOwnerId).toBe('owner-x');
    expect(free.state.isClaimed).toBe(false);
    expect(free.state.claimOwnerId).toBe('');
  });

  it('delegates heartbeat and release with the held claim token', () => {
    const { state, raw } = viewOf(row({ task_number: 1, status: 'IN_PROGRESS', claimed_by: 'me', claim_token: 'tok' }));
    state.heartbeat();
    expect(raw.heartbeat).toHaveBeenCalledWith(1, 'tok');
    state.release();
    expect(raw.release).toHaveBeenCalledWith(1, 'tok', Status.PENDING);
    state.release(Status.CONVERGED);
    expect(raw.release).toHaveBeenCalledWith(1, 'tok', Status.CONVERGED);
  });

  it('delegates markBlocked and unblock by id (not claim-gated)', () => {
    const { state, raw } = viewOf(row({ task_number: 1, status: 'FAILED' }));
    state.markBlocked();
    expect(raw.block).toHaveBeenCalledWith(1);
    state.unblock();
    expect(raw.unblock).toHaveBeenCalledWith(1);
  });

  // ── Dependencies ──────────────────────────────────────────────────────
  it('reads dependencies from the dependency table', () => {
    const { state } = viewOf(row({ task_number: 3 }), { deps: [1, 2] });
    expect([...state.dependencies]).toEqual([1, 2]);
  });

  it('dependenciesMet is true only when every dependency has converged', () => {
    const dep = row({ task_number: 1, status: 'CONVERGED' });
    const { state, byNum } = viewOf(row({ task_number: 2 }), { deps: [1], extra: [dep] });
    expect(state.dependenciesMet()).toBe(true);

    byNum.set(1, row({ task_number: 1, status: 'PENDING' })); // dep no longer converged
    expect(state.dependenciesMet()).toBe(false);

    byNum.delete(1); // dependency row missing entirely
    expect(state.dependenciesMet()).toBe(false);
  });

  // ── Content getters (parsed from autoresearch.md) ─────────────────────
  it('parses goal/model/reasoning/metricNames from a full autoresearch.md', () => {
    const { state } = viewOf(row({ task_number: 1, name: 'a' }), { autoresearch: FULL_AR });
    expect(state.goal).toBe('Make it fast');
    expect(state.model).toBe('task-model');
    expect(state.reasoning).toBe('high');
    expect(state.metricNames).toEqual(['latency', 'throughput']); // deduped
  });

  it('parses the block (## Goal newline) goal format', () => {
    const { state } = viewOf(row({ task_number: 1, name: 'a' }), { autoresearch: '## Goal\nDo the thing\n' });
    expect(state.goal).toBe('Do the thing');
  });

  it('parses a bulleted ## Scope section', () => {
    const { state } = viewOf(row({ task_number: 1, name: 'a' }), { autoresearch: '## Scope\n- src/a.ts\n- src/b.ts' });
    expect(state.scope).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns [] for a ## Scope header with no bullet points', () => {
    const { state } = viewOf(row({ task_number: 1, name: 'a' }), { autoresearch: '## Scope\n\n## Next\n- x\n' });
    expect(state.scope).toEqual([]);
  });

  it('falls back when autoresearch.md is missing (read throws)', () => {
    const { state } = viewOf(row({ task_number: 1, name: 'a' })); // no content registered
    expect(state.goal).toBe('T01-a'); // task name fallback
    expect(state.model).toBe('');
    expect(state.reasoning).toBe('');
    expect(state.metricNames).toEqual([]);
    expect(state.scope).toEqual([]);
  });

  it('falls back when autoresearch.md lacks the sections', () => {
    const { state } = viewOf(row({ task_number: 1, name: 'a' }), { autoresearch: 'nothing useful here\n' });
    expect(state.goal).toBe('T01-a');
    expect(state.model).toBe('');
    expect(state.metricNames).toEqual([]);
    expect(state.scope).toEqual([]);
  });

  it('acceptanceFingerprint hashes the criteria section deterministically', () => {
    const a = viewOf(row({ task_number: 1, name: 'a' }), { autoresearch: FULL_AR });
    const b = viewOf(row({ task_number: 2, name: 'b' }), { autoresearch: FULL_AR });
    expect(a.state.acceptanceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.state.acceptanceFingerprint).toBe(a.state.acceptanceFingerprint);

    const changed = viewOf(row({ task_number: 3, name: 'c' }), { autoresearch: FULL_AR.replace('throughput', 'tput') });
    expect(changed.state.acceptanceFingerprint).not.toBe(a.state.acceptanceFingerprint);
  });

  it('acceptanceFingerprint is stable when the section is absent', () => {
    const missing = viewOf(row({ task_number: 1, name: 'a' }), { autoresearch: 'nothing useful\n' });
    const none = viewOf(row({ task_number: 2, name: 'b' })); // no autoresearch.md at all
    expect(missing.state.acceptanceFingerprint).toBe(none.state.acceptanceFingerprint);
  });

  it('targetBranch reflects the row column', () => {
    expect(viewOf(row({ task_number: 1, target_branch: 'release/1.0' })).state.targetBranch).toBe('release/1.0');
    expect(viewOf(row({ task_number: 2, target_branch: null })).state.targetBranch).toBeUndefined();
  });

  it('repo reflects the row column', () => {
    expect(viewOf(row({ task_number: 1, repo: resolve('repo-a') })).state.repo).toBe(resolve('repo-a'));
    expect(viewOf(row({ task_number: 2, repo: null })).state.repo).toBeUndefined();
  });

  // ── Statics ───────────────────────────────────────────────────────────
  it('scan returns every non-converged task keyed by number', () => {
    const rows = [
      row({ task_number: 1 }),
      row({ task_number: 2, status: 'IN_PROGRESS', claimed_by: 'x', claim_token: 't' }),
      row({ task_number: 3, status: 'FAILED' }),
      row({ task_number: 4, status: 'BLOCKED' }),
      row({ task_number: 5, status: 'CONVERGED' }),
    ];
    const { tdb, raw } = tdbWith(rows);
    const all = TaskState.scan(tdb, ROOT);
    expect([...all.keys()].sort()).toEqual(['1', '2', '3', '4']);
    expect(raw.byStatus).toHaveBeenCalledWith(['PENDING', 'IN_PROGRESS', 'FAILED', 'BLOCKED']);
  });

  it('pick returns a claimed view, or null when nothing is ready', () => {
    const { tdb, raw } = tdbWith([]);
    raw.pick.mockReturnValueOnce(row({ task_number: 1, status: 'IN_PROGRESS', claimed_by: 'inst', claim_token: 'tok' }));
    const picked = TaskState.pick(tdb, ROOT, 'inst');
    expect(picked?.taskNumber).toBe(1);
    expect(raw.pick).toHaveBeenCalledWith('inst');

    raw.pick.mockReturnValueOnce(undefined);
    expect(TaskState.pick(tdb, ROOT, 'inst')).toBeNull();
  });

  it('pickByNumber returns a read-only view or null', () => {
    const { tdb } = tdbWith([row({ task_number: 7, name: 'g' })]);
    expect(TaskState.pickByNumber(tdb, ROOT, 7)?.taskNumber).toBe(7);
    expect(TaskState.pickByNumber(tdb, ROOT, 99)).toBeNull();
  });

  it('countConverged counts only CONVERGED rows', () => {
    const { tdb } = tdbWith([
      row({ task_number: 1, status: 'CONVERGED' }),
      row({ task_number: 2, status: 'CONVERGED' }),
      row({ task_number: 3 }),
    ]);
    expect(TaskState.countConverged(tdb)).toBe(2);
  });

  it('pruneConverged with keep=0 prunes nothing', () => {
    const { tdb } = tdbWith([row({ task_number: 1, status: 'CONVERGED' })]);
    TaskState.pruneConverged(tdb, ROOT, 0);
    expect(h.rmSync).not.toHaveBeenCalled();
  });

  it('pruneConverged removes the oldest content dirs beyond keep', () => {
    const rows = [1, 2, 3].map(n => row({ task_number: n, name: String.fromCharCode(96 + n), status: 'CONVERGED' }));
    const { tdb } = tdbWith(rows);
    TaskState.pruneConverged(tdb, ROOT, 1);
    expect(h.rmSync).toHaveBeenCalledTimes(2);
    expect(h.rmSync).toHaveBeenNthCalledWith(1, resolve(ROOT, rows[0]!.dir), { recursive: true, force: true });
    expect(h.rmSync).toHaveBeenNthCalledWith(2, resolve(ROOT, rows[1]!.dir), { recursive: true, force: true });
  });

  it('cascadeBlockDependencies delegates to tdb.cascadeBlock', () => {
    const { tdb, raw } = tdbWith([]);
    TaskState.cascadeBlockDependencies(tdb);
    expect(raw.cascadeBlock).toHaveBeenCalled();
  });
});
