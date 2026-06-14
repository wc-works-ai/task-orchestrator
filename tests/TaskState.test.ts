import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  TaskState, Status, inProgress, CONVERGENCE_THRESHOLD,
} from '../src/TaskState.js';
import { memStateDb, seed, seedState, rowOf, statusOf, type StateDb } from './helpers.js';

const FULL_AR = [
  '# Task',
  '## Goal: Make it fast',
  '- **Model:** task-model',
  '- **Reasoning:** high',
  '## Metric',
  'Track `latency`, `latency`, and `throughput`.',
  '## Scope',
  '- src/a.ts',
  '- src/b.ts',
].join('\n');

describe('TaskState (DB-backed)', () => {
  let dir = '';
  let s: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'taskstate-'));
    s = memStateDb();
  });

  afterEach(() => {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Identity ──────────────────────────────────────────────────────────
  it('exposes identity from the row and tasks root', () => {
    const t = seedState(s, dir, 1, 'auth');
    expect(t.taskNumber).toBe(1);
    expect(t.number).toBe(1);
    expect(t.taskName).toBe('T01-auth');
    expect(t.name).toBe('T01-auth');
    expect(t.directory).toBe(resolve(dir, 'T01-auth'));
    expect(t.cwd).toBe(resolve(dir, 'T01-auth'));
  });

  it('info returns a materialized TaskInfo snapshot', () => {
    const t = seedState(s, dir, 2, 'speed', { autoresearch: FULL_AR });
    const info = t.info;
    expect(info).toEqual({
      directory: resolve(dir, 'T02-speed'),
      number: 2,
      name: 'T02-speed',
      goal: 'Make it fast',
      model: 'task-model',
      reasoning: 'high',
      status: Status.PENDING,
      cwd: resolve(dir, 'T02-speed'),
      metrics: ['latency', 'throughput'],
    });
  });

  // ── Status getter branches ────────────────────────────────────────────
  it('status is PENDING when the row is gone', () => {
    const row = seed(s.db, dir, 1, 'gone');
    const t = TaskState.fromRow(s.tdb, dir, row);
    s.db.run('DELETE FROM tasks WHERE id=?', [row.id]);
    expect(t.status).toBe(Status.PENDING);
    expect(t.isPending).toBe(true);
    expect(t.convergenceCount).toBe(0);
    expect(t.failureCount).toBe(0);
    expect(t.maxFailures).toBe(Infinity);
    expect(t.isClaimed).toBe(false);
    expect(t.claimOwnerId).toBe('');
    expect(t.targetBranch).toBeUndefined();
  });

  it('status surfaces CREATING as PENDING', () => {
    const t = seedState(s, dir, 1, 'creating', { status: 'CREATING' });
    expect(t.status).toBe(Status.PENDING);
    expect(t.isPending).toBe(true);
  });

  it('status embeds the claim owner for IN_PROGRESS', () => {
    const t = seedState(s, dir, 1, 'run', { status: 'IN_PROGRESS', claimedBy: 'orch-9', claimToken: 'tok' });
    expect(t.status).toBe(inProgress('orch-9'));
    expect(t.isInProgress).toBe(true);
    expect(t.isActionable).toBe(false);
  });

  it('status embeds an empty owner when IN_PROGRESS has no claimant', () => {
    const t = seedState(s, dir, 1, 'run', { status: 'IN_PROGRESS', claimedBy: null });
    expect(t.status).toBe(inProgress(''));
    expect(t.isInProgress).toBe(true);
  });

  it('maps terminal statuses through directly', () => {
    expect(seedState(s, dir, 1, 'f', { status: 'FAILED' }).isFailed).toBe(true);
    expect(seedState(s, dir, 2, 'b', { status: 'BLOCKED' }).isBlocked).toBe(true);
    expect(seedState(s, dir, 3, 'c', { status: 'CONVERGED' }).isConverged).toBe(true);
    expect(seedState(s, dir, 4, 'p').isActionable).toBe(true);
  });

  // ── Convergence ───────────────────────────────────────────────────────
  it('reads convergence and hasConverged from the row', () => {
    const below = seedState(s, dir, 1, 'a', { convergence: CONVERGENCE_THRESHOLD - 1 });
    const at = seedState(s, dir, 2, 'b', { convergence: CONVERGENCE_THRESHOLD });
    expect(below.convergenceCount).toBe(CONVERGENCE_THRESHOLD - 1);
    expect(below.hasConverged).toBe(false);
    expect(at.hasConverged).toBe(true);
  });

  it('increments and resets convergence using the held claim token', () => {
    const t = seedState(s, dir, 1, 'a', { status: 'IN_PROGRESS', claimedBy: 'me', claimToken: 'tok' });
    t.incrementConvergence();
    expect(rowOf(s.db, 1)?.convergence).toBe(1);
    t.resetConvergence();
    expect(rowOf(s.db, 1)?.convergence).toBe(0);
  });

  // ── Failures ──────────────────────────────────────────────────────────
  it('increments failures and returns the new total when claim is held', () => {
    const t = seedState(s, dir, 1, 'a', { status: 'IN_PROGRESS', claimedBy: 'me', claimToken: 'tok' });
    expect(t.incrementFailures()).toBe(1);
    expect(t.incrementFailures()).toBe(2);
    expect(rowOf(s.db, 1)?.failures).toBe(2);
  });

  it('incrementFailures returns 0 when no claim token is held', () => {
    const t = seedState(s, dir, 1, 'a'); // PENDING, no token
    expect(t.incrementFailures()).toBe(0);
    expect(rowOf(s.db, 1)?.failures).toBe(0);
  });

  it('reads maxFailures from the row, unlimited when null', () => {
    expect(seedState(s, dir, 1, 'a', { maxFailures: 3 }).maxFailures).toBe(3);
    expect(seedState(s, dir, 2, 'b', { maxFailures: null }).maxFailures).toBe(Infinity);
  });

  // ── Claim ─────────────────────────────────────────────────────────────
  it('reports claim ownership from the row', () => {
    const claimed = seedState(s, dir, 1, 'a', { status: 'IN_PROGRESS', claimedBy: 'owner-x', claimToken: 'tok' });
    const free = seedState(s, dir, 2, 'b');
    expect(claimed.isClaimed).toBe(true);
    expect(claimed.claimOwnerId).toBe('owner-x');
    expect(free.isClaimed).toBe(false);
    expect(free.claimOwnerId).toBe('');
  });

  it('heartbeat writes a timestamp when the claim is held', () => {
    const t = seedState(s, dir, 1, 'a', { status: 'IN_PROGRESS', claimedBy: 'me', claimToken: 'tok' });
    expect(rowOf(s.db, 1)?.heartbeat).toBeNull();
    t.heartbeat();
    expect(typeof rowOf(s.db, 1)?.heartbeat).toBe('number');
  });

  it('release sets a terminal status and clears the claim (default PENDING)', () => {
    const t = seedState(s, dir, 1, 'a', { status: 'IN_PROGRESS', claimedBy: 'me', claimToken: 'tok' });
    t.release();
    expect(statusOf(s.db, 1)).toBe('PENDING');
    expect(rowOf(s.db, 1)?.claimed_by).toBeNull();
  });

  it('release accepts an explicit terminal status', () => {
    const t = seedState(s, dir, 1, 'a', { status: 'IN_PROGRESS', claimedBy: 'me', claimToken: 'tok' });
    t.release(Status.CONVERGED);
    expect(statusOf(s.db, 1)).toBe('CONVERGED');
  });

  it('markBlocked blocks the task and clears convergence + claim', () => {
    const t = seedState(s, dir, 1, 'a', { status: 'FAILED', convergence: 2, failures: 4 });
    t.markBlocked();
    const row = rowOf(s.db, 1);
    expect(row?.status).toBe('BLOCKED');
    expect(row?.convergence).toBe(0);
    expect(row?.claimed_by).toBeNull();
  });

  it('unblock resets a blocked task to PENDING with cleared failures/convergence', () => {
    const t = seedState(s, dir, 1, 'a', { status: 'BLOCKED', failures: 4, convergence: 1 });
    t.unblock();
    const row = rowOf(s.db, 1);
    expect(row?.status).toBe('PENDING');
    expect(row?.failures).toBe(0);
    expect(row?.convergence).toBe(0);
  });

  // ── Dependencies ──────────────────────────────────────────────────────
  it('dependencies come from the dependency table', () => {
    const t = seedState(s, dir, 3, 'c', { deps: [1, 2] });
    expect([...t.dependencies]).toEqual([1, 2]);
  });

  it('dependenciesMet is true only when every dependency has converged', () => {
    seed(s.db, dir, 1, 'dep-converged', { status: 'CONVERGED' });
    const met = seedState(s, dir, 2, 'a', { deps: [1] });
    expect(met.dependenciesMet()).toBe(true);

    seed(s.db, dir, 3, 'dep-pending'); // PENDING
    const unmet = seedState(s, dir, 4, 'b', { deps: [3] });
    expect(unmet.dependenciesMet()).toBe(false);

    const missing = seedState(s, dir, 5, 'c', { deps: [99] }); // no such dep row
    expect(missing.dependenciesMet()).toBe(false);
  });

  // ── Content getters ───────────────────────────────────────────────────
  it('goal/model/reasoning/metric parse a full autoresearch.md', () => {
    const t = seedState(s, dir, 1, 'a', { autoresearch: FULL_AR });
    expect(t.goal).toBe('Make it fast');
    expect(t.model).toBe('task-model');
    expect(t.reasoning).toBe('high');
    expect(t.metricNames).toEqual(['latency', 'throughput']);
  });

  it('scope parses a leading bulleted ## Scope section', () => {
    const t = seedState(s, dir, 1, 'a', { autoresearch: '## Scope\n- src/a.ts\n- src/b.ts' });
    expect(t.scope).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('goal parses the block (## Goal newline) format', () => {
    const t = seedState(s, dir, 1, 'a', { autoresearch: '## Goal\nDo the thing\n' });
    expect(t.goal).toBe('Do the thing');
  });

  it('content getters fall back when autoresearch.md is missing', () => {
    const t = seedState(s, dir, 1, 'a'); // no autoresearch written
    expect(t.goal).toBe('T01-a');
    expect(t.model).toBe('');
    expect(t.reasoning).toBe('');
    expect(t.metricNames).toEqual([]);
    expect(t.scope).toEqual([]);
  });

  it('content getters fall back when autoresearch.md lacks the sections', () => {
    const t = seedState(s, dir, 1, 'a', { autoresearch: 'nothing useful here\n' });
    expect(t.goal).toBe('T01-a');
    expect(t.model).toBe('');
    expect(t.reasoning).toBe('');
    expect(t.metricNames).toEqual([]);
    expect(t.scope).toEqual([]);
  });

  it('scope returns [] for a header with no bullet points', () => {
    const t = seedState(s, dir, 1, 'a', { autoresearch: '## Scope\n\n## Next\n- x\n' });
    expect(t.scope).toEqual([]);
  });

  it('targetBranch reflects the row column', () => {
    expect(seedState(s, dir, 1, 'a', { targetBranch: 'release/1.0' }).targetBranch).toBe('release/1.0');
    expect(seedState(s, dir, 2, 'b', { targetBranch: null }).targetBranch).toBeUndefined();
  });

  // ── Statics ───────────────────────────────────────────────────────────
  it('scan returns every non-converged task keyed by number', () => {
    seed(s.db, dir, 1, 'p');
    seed(s.db, dir, 2, 'i', { status: 'IN_PROGRESS', claimedBy: 'x', claimToken: 't' });
    seed(s.db, dir, 3, 'f', { status: 'FAILED' });
    seed(s.db, dir, 4, 'b', { status: 'BLOCKED' });
    seed(s.db, dir, 5, 'c', { status: 'CONVERGED' });
    const all = TaskState.scan(s.tdb, dir);
    expect([...all.keys()].sort()).toEqual(['1', '2', '3', '4']);
    expect(all.get('1')?.taskNumber).toBe(1);
  });

  it('pick atomically claims the next actionable task, then null', () => {
    seed(s.db, dir, 1, 'a');
    const picked = TaskState.pick(s.tdb, dir, 'inst-1');
    expect(picked?.taskNumber).toBe(1);
    expect(picked?.claimOwnerId).toBe('inst-1');
    expect(statusOf(s.db, 1)).toBe('IN_PROGRESS');
    // Token captured → gated mutation works through the returned view.
    picked!.incrementConvergence();
    expect(rowOf(s.db, 1)?.convergence).toBe(1);
    expect(TaskState.pick(s.tdb, dir, 'inst-1')).toBeNull();
  });

  it('pickByNumber returns a read-only view or null', () => {
    seed(s.db, dir, 7, 'g');
    expect(TaskState.pickByNumber(s.tdb, dir, 7)?.taskNumber).toBe(7);
    expect(statusOf(s.db, 7)).toBe('PENDING'); // not claimed
    expect(TaskState.pickByNumber(s.tdb, dir, 99)).toBeNull();
  });

  it('countConverged counts only CONVERGED rows', () => {
    seed(s.db, dir, 1, 'a', { status: 'CONVERGED' });
    seed(s.db, dir, 2, 'b', { status: 'CONVERGED' });
    seed(s.db, dir, 3, 'c');
    expect(TaskState.countConverged(s.tdb)).toBe(2);
  });

  it('pruneConverged with keep=0 prunes nothing', () => {
    seed(s.db, dir, 1, 'a', { status: 'CONVERGED' });
    TaskState.pruneConverged(s.tdb, dir, 0);
    expect(existsSync(resolve(dir, 'T01-a'))).toBe(true);
    expect(TaskState.countConverged(s.tdb)).toBe(1);
  });

  it('pruneConverged removes oldest content dirs beyond keep but keeps the rows', () => {
    seed(s.db, dir, 1, 'a', { status: 'CONVERGED' });
    seed(s.db, dir, 2, 'b', { status: 'CONVERGED' });
    seed(s.db, dir, 3, 'c', { status: 'CONVERGED' });
    TaskState.pruneConverged(s.tdb, dir, 1);
    expect(existsSync(resolve(dir, 'T01-a'))).toBe(false);
    expect(existsSync(resolve(dir, 'T02-b'))).toBe(false);
    expect(existsSync(resolve(dir, 'T03-c'))).toBe(true);
    // Rows preserved so the converged count is unaffected by pruning.
    expect(TaskState.countConverged(s.tdb)).toBe(3);
  });

  it('cascadeBlockDependencies blocks dependents of blocked tasks', () => {
    seed(s.db, dir, 1, 'a', { status: 'BLOCKED' });
    seed(s.db, dir, 2, 'b', { deps: [1] });
    TaskState.cascadeBlockDependencies(s.tdb);
    expect(statusOf(s.db, 2)).toBe('BLOCKED');
  });
});
