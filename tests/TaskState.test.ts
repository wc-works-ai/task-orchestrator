import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskState, Status, CONVERGENCE_THRESHOLD, inProgress } from '../src/TaskState.js';
import { statusToShard } from '../src/Status.js';

function setup() {
  const dir = mkdtempSync(resolve('/tmp', 'ts-test-'));
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

describe('TaskState', () => {
  let dir = '';

  beforeEach(() => { dir = setup(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('defaults to PENDING when status file missing', () => {
    expect(new TaskState(resolve(dir, 'pending', 'T01-x')).status).toBe(Status.PENDING);
  });

  it('reads and writes status to disk', () => {
    const t = make(dir, 1, 'a');
    t.status = Status.CONVERGED;
    expect(t.status).toBe(Status.CONVERGED);
    expect(new TaskState(t.directory).status).toBe(Status.CONVERGED);
  });

  it('moves directory to correct shard on status change', () => {
    const t = make(dir, 1, 'a');
    expect(t.directory).toContain('/pending/');
    t.status = Status.CONVERGED;
    expect(t.directory).toContain('/converged/');
  });

  it('IN_PROGRESS includes instance id', () => {
    const t = make(dir, 1, 'a');
    t.status = inProgress('abc');
    expect(t.isInProgress).toBe(true);
    expect(t.status).toContain('abc');
  });

  it('convergenceCount increments and resets', () => {
    const t = make(dir, 1, 'a');
    expect(t.convergenceCount).toBe(0);
    expect(t.incrementConvergence()).toBe(1);
    expect(t.incrementConvergence()).toBe(2);
    t.resetConvergence();
    expect(t.convergenceCount).toBe(0);
  });

  it(`hasConverged when count >= ${CONVERGENCE_THRESHOLD}`, () => {
    const t = make(dir, 1, 'a');
    for (let i = 0; i < CONVERGENCE_THRESHOLD - 1; i++) t.incrementConvergence();
    expect(t.hasConverged).toBe(false);
    t.incrementConvergence();
    expect(t.hasConverged).toBe(true);
  });

  it('failureCount increments', () => {
    const t = make(dir, 1, 'a');
    expect(t.failureCount).toBe(0);
    expect(t.incrementFailures()).toBe(1);
    expect(t.incrementFailures()).toBe(2);
  });

  it('dependencies read/write round-trip', () => {
    const t = make(dir, 1, 'a');
    t.dependencies = [38, 17];
    expect(t.dependencies).toEqual([38, 17]);
  });

  it('dependenciesMet reads from disk', () => {
    const t = make(dir, 1, 'a');
    t.dependencies = [2];
    // T2 doesn't exist — deps not met
    expect(t.dependenciesMet(dir)).toBe(false);
  });

  it('claim uses atomic mkdir', () => {
    const t = make(dir, 1, 'a');
    expect(t.claim('inst-A')).toBe(true);
    expect(t.isClaimed).toBe(true);
    expect(t.claimOwnerId).toBe('inst-A');
    // Second claim fails
    expect(t.claim('inst-B')).toBe(false);
  });

  it('release clears claim and resets status', () => {
    const t = make(dir, 1, 'a');
    t.claim('A');
    t.release(Status.PENDING);
    expect(t.isClaimed).toBe(false);
    expect(t.status).toBe(Status.PENDING);
  });

  it('markBlocked moves to blocked shard', () => {
    const t = make(dir, 1, 'a');
    t.claim('A');
    t.incrementConvergence();
    t.markBlocked();
    expect(t.status).toBe(Status.BLOCKED);
    expect(t.convergenceCount).toBe(0);
    expect(t.directory).toContain('/blocked/');
  });

  it('scan finds tasks across shards', async () => {
    make(dir, 1, 'a').status = Status.CONVERGED;
    make(dir, 2, 'b');
    make(dir, 3, 'c', { status: Status.FAILED });
    const all = await TaskState.scan(dir);
    expect(all.size).toBe(3);
  });

  it('pick returns highest priority', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    await TaskState.scan(dir);
    const p = await TaskState.pick(dir, 'test');
    expect(p).not.toBeNull();
    expect(p!.taskNumber).toBe(1);
  });

  it('pick skips when deps not met, picks next available', async () => {
    make(dir, 1, 'a', { deps: [2] });
    make(dir, 2, 'b');
    await TaskState.scan(dir);
    const p = await TaskState.pick(dir, 'test');
    expect(p).not.toBeNull();
    expect(p!.taskNumber).toBe(2);
  });

  it('pick skips blocked tasks', async () => {
    make(dir, 1, 'a', { status: Status.BLOCKED });
    await TaskState.scan(dir);
    expect(await TaskState.pick(dir, 'test')).toBeNull();
  });

  it('pick returns null when nothing actionable', async () => {
    await TaskState.scan(dir);
    expect(await TaskState.pick(dir, 'test')).toBeNull();
  });

  // ── scope / goal / model getters ──────────────────────────────────

  it('scope returns [] when no autoresearch.md', () => {
    const t = make(dir, 1, 'a');
    expect(t.scope).toEqual([]);
  });

  it('scope parses bulleted list', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', '## Scope\n- file1.ts\n- file2.ts');
    const fresh = new TaskState(t.directory);
    expect(fresh.scope).toEqual(['file1.ts', 'file2.ts']);
  });

  it('goal returns taskName when no autoresearch.md', () => {
    const t = make(dir, 1, 'a');
    expect(t.goal).toBe('T01-a');
  });

  it('goal parses ## Goal: inline format', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', '## Goal: optimize speed');
    const fresh = new TaskState(t.directory);
    expect(fresh.goal).toBe('optimize speed');
  });

  it('goal parses ## Goal block format', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', '## Goal\nreduce latency');
    const fresh = new TaskState(t.directory);
    expect(fresh.goal).toBe('reduce latency');
  });

  it('model returns empty when no autoresearch.md', () => {
    const t = make(dir, 1, 'a');
    expect(t.model).toBe('');
  });

  it('model parses **Model:** metadata', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', '- **Model:** gpt-5\n## Goal\nTest');
    const fresh = new TaskState(t.directory);
    expect(fresh.model).toBe('gpt-5');
  });

  // ── Claim details ──────────────────────────────────────────────────

  it('claimOwner returns null when unclaimed', () => {
    const t = make(dir, 1, 'a');
    expect(t.claimOwner).toBeNull();
    expect(t.claimOwnerId).toBe('');
  });

  it('heartbeat writes without error', () => {
    const t = make(dir, 1, 'a');
    t.claim('test');
    expect(() => t.heartbeat()).not.toThrow();
  });

  it('statusCache returns the internal cache', () => {
    expect(TaskState.statusCache).toBeInstanceOf(Map);
  });

  // ── Status utilities ───────────────────────────────────────────────

  it('statusToShard maps all Status values', () => {
    expect(statusToShard(Status.PENDING)).toBe('pending');
    expect(statusToShard(Status.FAILED)).toBe('failed');
    expect(statusToShard(Status.BLOCKED)).toBe('blocked');
    expect(statusToShard(Status.CONVERGED)).toBe('converged');
    expect(statusToShard('IN_PROGRESS:orchestrator-1')).toBe('in_progress');
  });
});
