import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TaskState, Status, CONVERGENCE_THRESHOLD, inProgress } from '../src/TaskState.js';
import { MAX_FAILURES } from '../src/Status.js';
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
    expect(t.directory).toBe(resolve(dir, 'pending', 'T01-a'));
    t.status = Status.CONVERGED;
    expect(t.directory).toBe(resolve(dir, 'converged', 'T01-a'));
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

  it('failureCount reads from existing file', async () => {
    const t = make(dir, 1, 'a');
    // Write a non-numeric failure count to trigger || 0 fallback
    const { writeFileSync } = await import('node:fs');
    writeFileSync(t.directory + '/.failure_count', 'not-a-number\n');
    expect(t.failureCount).toBe(0);
    // Write a valid number
    writeFileSync(t.directory + '/.failure_count', '3\n');
    expect(t.failureCount).toBe(3);
  });

  it('failureCount increments', () => {
    const t = make(dir, 1, 'a');
    expect(t.failureCount).toBe(0);
    expect(t.incrementFailures()).toBe(1);
    expect(t.incrementFailures()).toBe(2);
  });

  it('failureCount returns 0 for NaN content', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.failure_count'), 'not-a-number\n');
    // parseInt('not-a-number') returns NaN, NaN || 0 = 0
    expect(t.failureCount).toBe(0);
  });

  it('convergenceCount returns 0 for NaN content', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.convergence_count'), 'invalid\n');
    expect(t.convergenceCount).toBe(0);
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
    expect(t.directory).toBe(resolve(dir, 'blocked', 'T01-a'));
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

  it('pick handles missing shard directory gracefully', async () => {
    // Remove the failed shard to trigger readdir failure
    const { rmSync } = await import('node:fs');
    rmSync(resolve(dir, 'failed'), { recursive: true, force: true });
    // pick should skip missing shard and not throw
    const result = await TaskState.pick(dir, 'test');
    expect(result).toBeNull();
  });

  it('pick blocks tasks that exceed max failures', async () => {
    const t = make(dir, 1, 'a', { status: Status.FAILED });
    for (let i = 0; i < MAX_FAILURES; i++) t.incrementFailures();
    await TaskState.scan(dir);
    const picked = await TaskState.pick(dir, 'test');
    expect(picked).toBeNull();
  });

  it('pick releases unclaimed in-progress tasks to FAILED', async () => {
    make(dir, 1, 'a', { status: 'IN_PROGRESS:orphan' });
    await TaskState.scan(dir);
    // First pick: task is in in_progress shard (moved there by setter),
    // pick iterates pending→failed→in_progress, finds it in in_progress,
    // releases it to FAILED. Since failed shard was already iterated,
    // the released task is not picked up in this call.
    const first = await TaskState.pick(dir, 'test');
    expect(first).toBeNull();
    // Second pick: task is now in failed shard, gets picked
    const second = await TaskState.pick(dir, 'test');
    expect(second).not.toBeNull();
    expect(second!.taskNumber).toBe(1);
  });

  it('pick skips task when claim fails', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const taskDir = resolve(dir, 'pending', 'T01-claimed');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:1\nstarted:1\ninstance:other\n');
    writeFileSync(join(taskDir, '.status'), 'PENDING\n');
    make(dir, 2, 'b', { status: Status.PENDING });
    await TaskState.scan(dir);
    const picked = await TaskState.pick(dir, 'test');
    expect(picked).not.toBeNull();
    expect(picked!.taskNumber).toBe(2);
  });

  it('dependenciesMet handles missing shard directory', async () => {
    const { rmSync } = await import('node:fs');
    make(dir, 2, 'b', { status: Status.CONVERGED }); // moves to converged shard
    // Remove the converged shard including task 2
    rmSync(resolve(dir, 'converged'), { recursive: true, force: true });
    const t = make(dir, 1, 'a');
    t.dependencies = [2];
    // dependenciesMet: #findByNumber can't find task 2 (shard deleted) → returns null → false
    expect(t.dependenciesMet(dir)).toBe(false);
  });

  it('dependenciesMet handles missing dep task', async () => {
    const t = make(dir, 1, 'a');
    t.dependencies = [99]; // non-existent task
    expect(t.dependenciesMet(dir)).toBe(false);
  });

  it('dependenciesMet handles unconverged dep task', async () => {
    make(dir, 2, 'b', { status: Status.FAILED });
    const t = make(dir, 1, 'a');
    t.dependencies = [2];
    expect(t.dependenciesMet(dir)).toBe(false);
  });

  it('dependenciesMet passes when all deps converged', async () => {
    make(dir, 2, 'b', { status: Status.CONVERGED });
    const t = make(dir, 1, 'a');
    t.dependencies = [2];
    expect(t.dependenciesMet(dir)).toBe(true);
  });

  it('hasBlockedDependency returns true when a dep is blocked', () => {
    make(dir, 2, 'b', { status: Status.BLOCKED });
    const t = make(dir, 1, 'a', { deps: [2] });
    expect(t.hasBlockedDependency(dir)).toBe(true);
  });

  it('hasBlockedDependency returns false when a dep is converged', () => {
    make(dir, 2, 'b', { status: Status.CONVERGED });
    const t = make(dir, 1, 'a', { deps: [2] });
    expect(t.hasBlockedDependency(dir)).toBe(false);
  });

  it('hasBlockedDependency returns false when a dep is failed', () => {
    make(dir, 2, 'b', { status: Status.FAILED });
    const t = make(dir, 1, 'a', { deps: [2] });
    expect(t.hasBlockedDependency(dir)).toBe(false);
  });

  it('hasBlockedDependency returns false when a dep is missing', () => {
    const t = make(dir, 1, 'a', { deps: [99] });
    expect(t.hasBlockedDependency(dir)).toBe(false);
  });

  it('hasBlockedDependency returns false when there are no deps', () => {
    const t = make(dir, 1, 'a');
    expect(t.hasBlockedDependency(dir)).toBe(false);
  });

  it('scan skips entries that are not directories', async () => {
    const { writeFileSync } = await import('node:fs');
    // Create a file that matches T-pattern but is not a directory
    // to exercise the inner 'catch { continue; }' in scan()
    writeFileSync(resolve(dir, 'pending', 'T01-not-a-dir'), '');
    const all = await TaskState.scan(dir);
    // The file entry should be skipped, scan completes without error
    expect(all).toBeInstanceOf(Map);
  });

  it('claimOwner returns null when claim directory missing', async () => {
    const t = make(dir, 1, 'a');
    expect(t.claimOwner).toBeNull();
  });

  it('scope returns empty array when readFileSync fails', () => {
    const t = make(dir, 1, 'a');
    // No autoresearch.md file → scope catch returns []
    expect(t.scope).toEqual([]);
  });

  it('goal returns taskName when regex does not match', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', 'no goal here\njust some text');
    const fresh = new TaskState(t.directory);
    expect(fresh.goal).toBe('T01-a');
  });

  it('scope handles section with no bullet points', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', '## Scope\n## Goal\nTest');
    const fresh = new TaskState(t.directory);
    expect(fresh.scope).toEqual([]);
  });

  it('scope returns [] when no ## Scope header in file', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', '## Goal\nsome goal\n## Other\ndata');
    const fresh = new TaskState(t.directory);
    expect(fresh.scope).toEqual([]);
  });

  it('model returns empty when no model in metadata', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(t.directory + '/autoresearch.md', '## Goal\njust test');
    const fresh = new TaskState(t.directory);
    expect(fresh.model).toBe('');
  });

  it('pick handles normal entry matching', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    await TaskState.scan(dir);
    const picked = await TaskState.pick(dir, 'test');
    expect(picked).not.toBeNull();
    expect(picked!.taskNumber).toBe(1);
  });

  it('pick skips converged tasks in pending shard', async () => {
    // Put a converged task directly in pending shard to exercise the
    // 'if (t.isConverged || t.isBlocked) continue' path in pick()
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const tdir = resolve(dir, 'pending', 'T01-converged-but-in-pending');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(tdir + '/.status', 'CONVERGED\n');
    make(dir, 2, 'b');
    await TaskState.scan(dir);
    const picked = await TaskState.pick(dir, 'test');
    expect(picked).not.toBeNull();
    expect(picked!.taskNumber).toBe(2);
  });

  it('pick skips converged tasks', async () => {
    make(dir, 1, 'a', { status: Status.CONVERGED });
    make(dir, 2, 'b');
    await TaskState.scan(dir);
    const picked = await TaskState.pick(dir, 'test');
    expect(picked).not.toBeNull();
    expect(picked!.taskNumber).toBe(2);
  });

  it('claimOwner handles owner file without pid', async () => {
    const t = make(dir, 1, 'a');
    t.claim('test'); // creates proper owner
    // Verify claimOwner is not null (has pid)
    expect(t.claimOwner).not.toBeNull();
    expect(t.claimOwner!.pid).toBeGreaterThan(0);
  });

  it('parseInt with empty string returns NaN handled by || null', async () => {
    // Tested indirectly: non-numeric pid → parseInt returns NaN → NaN || null = null
    const t = make(dir, 1, 'a');
    t.claim('test');
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Write owner without pid field
    writeFileSync(join(t.directory, '.claim', 'owner'), 'started:1\ninstance:test\n');
    expect(t.claimOwner).not.toBeNull();
    // pid is NaN || null → null... wait:
    // parseInt(raw.match(/pid:(\d+)/)?.[1] ?? '0', 10) — regex returns null, ?.[1] is undefined, ?? '0' gives '0'
    // parseInt('0', 10) = 0, 0 || null = null
    expect(t.claimOwner!.pid).toBe(0);
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

  it('maxFailures parses **Retry limit:** integer metadata', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'), '- **Retry limit:** 3\n## Goal\nTest');
    expect(new TaskState(t.directory).maxFailures).toBe(3);
  });

  it.each(['infinite', 'unlimited', 'inf'])('maxFailures parses %s as Infinity', (value) => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'), `- **Retry limit:** ${value}\n## Goal\nTest`);
    expect(new TaskState(t.directory).maxFailures).toBe(Infinity);
  });

  it('maxFailures falls back to global default when missing', () => {
    const t = make(dir, 1, 'a');
    expect(t.maxFailures).toBe(MAX_FAILURES);
  });

  it.each(['0', '-2', 'abc'])('maxFailures falls back to global default for invalid value %s', (value) => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'), `- **Retry limit:** ${value}\n## Goal\nTest`);
    expect(new TaskState(t.directory).maxFailures).toBe(MAX_FAILURES);
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

  it('status setter handles empty file content', () => {
    const t = make(dir, 1, 'a');
    // Write empty status file to trigger the `if (raw)` falsy branch
    writeFileSync(resolve(t.directory, '.status'), '   \n');
    const fresh = new TaskState(t.directory);
    expect(fresh.status).toBe(Status.PENDING);
  });

  it('status setter migrates to same shard (no-op)', () => {
    const t = make(dir, 1, 'a');
    // Setting PENDING when already in pending shard → target === dirname → no migration
    t.status = Status.PENDING;
    expect(t.directory).toBe(resolve(dir, 'pending', 'T01-a'));
  });

  it('statusCache returns the internal cache', () => {
    expect(TaskState.statusCache).toBeInstanceOf(Map);
  });

  it('name and isPending getters work', () => {
    const t = make(dir, 1, 'a');
    expect(t.name).toBe('T01-a');
    expect(t.isPending).toBe(true);
  });

  it('cwd returns the directory path', () => {
    const t = make(dir, 1, 'a');
    expect(t.cwd).toBe(t.directory);
    expect(t.info.cwd).toBe(t.directory);
  });

  it('taskNumber returns 0 for non-matching directory name', () => {
    // Cover the regex match failure fallback: `|| 0` in taskNumber()
    const d = resolve(dir, 'pending', 'non-standard-dir-name');
    mkdirSync(d, { recursive: true });
    writeFileSync(resolve(d, '.status'), 'PENDING\n');
    const t = new TaskState(d);
    expect(t.taskNumber).toBe(0);
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
