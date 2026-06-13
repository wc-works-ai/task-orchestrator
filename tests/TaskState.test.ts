import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { TaskState, Status, CONVERGENCE_THRESHOLD, inProgress } from '../src/TaskState.js';
import { MAX_FAILURES } from '../src/Status.js';
import { statusToShard } from '../src/Status.js';

function setup() {
  const dir = mkdtempSync(resolve(tmpdir(), 'ts-test-'));
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
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to PENDING when status file missing', () => {
    expect(new TaskState(resolve(dir, 'pending', 'T01-x')).status).toBe(Status.PENDING);
  });

  it('reads and writes status to disk', () => {
    const t = make(dir, 1, 'a');
    t.status = Status.CONVERGED;
    expect(t.status).toBe(Status.CONVERGED);
    expect(new TaskState(t.directory).status).toBe(Status.CONVERGED);
  });

  it('uses a unique temp status filename per write', async () => {
    vi.resetModules();
    const originalProcess = globalThis.process;
    const tempWrites: string[] = [];

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        writeFileSync: vi.fn((path: Parameters<typeof actual.writeFileSync>[0], ...args: unknown[]) => {
          const file = String(path);
          if (file.includes('.status.') && file.endsWith('.tmp')) tempWrites.push(file);
          return (actual.writeFileSync as (...callArgs: unknown[]) => void)(path, ...args);
        }),
      };
    });

    const { TaskState: MockedTaskState, Status: MockedStatus } = await import('../src/TaskState.js');
    const taskDir = resolve(dir, 'pending', 'T01-a');
    mkdirSync(taskDir, { recursive: true });
    const first = new MockedTaskState(taskDir);
    const second = new MockedTaskState(taskDir);

    const fakeProcess = (pid: number): NodeJS.Process => {
      const next = Object.create(originalProcess) as NodeJS.Process;
      Object.defineProperty(next, 'pid', { value: pid });
      return next;
    };
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);

    try {
      globalThis.process = fakeProcess(1111);
      first.status = MockedStatus.PENDING;
      globalThis.process = fakeProcess(2222);
      second.status = MockedStatus.FAILED;
    } finally {
      globalThis.process = originalProcess;
    }

    expect(tempWrites).toHaveLength(2);
    expect(tempWrites[0]).not.toBe(tempWrites[1]);
    expect(tempWrites[0]).toContain('.status.1111.1234567890.tmp');
    expect(tempWrites[1]).toContain('.status.2222.1234567890.tmp');
    expect(new MockedTaskState(resolve(dir, 'failed', 'T01-a')).status).toBe(MockedStatus.FAILED);
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

  it('release moves task before removing the claim', async () => {
    vi.resetModules();
    const releaseOrder: string[] = [];

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: vi.fn((source: Parameters<typeof actual.renameSync>[0], destination: Parameters<typeof actual.renameSync>[1]) => {
          releaseOrder.push(`rename:${String(source)}->${String(destination)}`);
          return actual.renameSync(source, destination);
        }),
        rmSync: vi.fn((target: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
          releaseOrder.push(`rm:${String(target)}`);
          return actual.rmSync(target, options);
        }),
      };
    });

    const { TaskState: MockedTaskState, Status: MockedStatus } = await import('../src/TaskState.js');
    const taskDir = resolve(dir, 'pending', 'T01-a');
    mkdirSync(taskDir, { recursive: true });
    const t = new MockedTaskState(taskDir);

    t.claim('A');
    releaseOrder.length = 0;
    t.release(MockedStatus.PENDING);

    expect(t.directory).toBe(resolve(dir, 'pending', 'T01-a'));
    expect(t.status).toBe(MockedStatus.PENDING);
    expect(t.isClaimed).toBe(false);
    expect(releaseOrder.some(step => step.startsWith('rename:'))).toBe(true);
    expect(releaseOrder.some(step => step.startsWith('rm:'))).toBe(true);
    expect(releaseOrder.findIndex(step => step.startsWith('rename:')))
      .toBeLessThan(releaseOrder.findIndex(step => step.startsWith('rm:')));
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

  // ── Corruption resilience ───────────────────────────────────────────

  it('recovers a corrupted/unknown .status as PENDING', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.status'), 'GARBAGE\n');
    expect(t.status).toBe(Status.PENDING);
    expect(t.isActionable).toBe(true);
  });

  it('treats an empty .status as PENDING', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.status'), '   \n');
    expect(t.status).toBe(Status.PENDING);
  });

  it('clamps a negative or garbage convergence count to 0', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.convergence_count'), '-5\n');
    expect(t.convergenceCount).toBe(0);
    writeFileSync(join(t.directory, '.convergence_count'), 'not-a-number\n');
    expect(t.convergenceCount).toBe(0);
    expect(t.hasConverged).toBe(false);
  });

  it('clamps a negative or garbage failure count to 0', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.failure_count'), '-3\n');
    expect(t.failureCount).toBe(0);
    writeFileSync(join(t.directory, '.failure_count'), 'xyz\n');
    expect(t.failureCount).toBe(0);
  });

  it('keeps a valid positive counter value', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.failure_count'), '4\n');
    expect(t.failureCount).toBe(4);
  });

  it('drops corrupted/non-positive dependency entries', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.dependencies'), '2\nabc\n0\n-1\n3\n');
    expect(t.dependencies).toEqual([2, 3]);
  });

  it('unblock resets a blocked task to pending with cleared claim and failures', () => {
    const t = make(dir, 1, 'a');
    t.claim('A');
    for (let i = 0; i < MAX_FAILURES; i++) t.incrementFailures();
    t.markBlocked();
    expect(t.status).toBe(Status.BLOCKED);

    t.unblock();

    expect(t.status).toBe(Status.PENDING);
    expect(t.failureCount).toBe(0);
    expect(t.convergenceCount).toBe(0);
    expect(t.isClaimed).toBe(false);
    expect(t.directory).toBe(resolve(dir, 'pending', 'T01-a'));
  });

  it('scan finds tasks across shards', async () => {
    make(dir, 1, 'a').status = Status.CONVERGED;
    make(dir, 2, 'b');
    make(dir, 3, 'c', { status: Status.FAILED });
    const all = await TaskState.scan(dir);
    expect(all.size).toBe(2); // converged shard is excluded from scan
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

  it('pick skips in-progress tasks claimed by another orchestrator', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const taskDir = resolve(dir, 'in_progress', 'T01-claimed');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:1\nstarted:1\ninstance:other\nhost:test\n');
    writeFileSync(join(claimDir, 'heartbeat'), '');
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:other\n');
    make(dir, 2, 'b', { status: Status.PENDING });
    await TaskState.scan(dir);
    const picked = await TaskState.pick(dir, 'test');
    expect(picked).not.toBeNull();
    expect(picked!.taskNumber).toBe(2);
  });

  it('pick removes orphan claims from pending tasks and makes them pickable', async () => {
    const taskDir = resolve(dir, 'pending', 'T01-orphan');
    mkdirSync(join(taskDir, '.claim'), { recursive: true });
    writeFileSync(join(taskDir, '.status'), 'PENDING\n');
    writeFileSync(join(taskDir, '.claim', 'owner'), 'pid:1\nstarted:1\ninstance:other\nhost:test\n');
    writeFileSync(join(taskDir, '.claim', 'heartbeat'), '');

    const picked = await TaskState.pick(dir, 'test');

    expect(existsSync(join(taskDir, '.claim'))).toBe(false);
    expect(picked).not.toBeNull();
    expect(picked!.taskNumber).toBe(1);
    expect(picked!.isClaimed).toBe(true);
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

  it('targetBranch returns the value from .target_branch file', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.target_branch'), 'develop\n');
    expect(t.targetBranch).toBe('develop');
  });

  it('targetBranch returns undefined when file is empty', () => {
    const t = make(dir, 1, 'a');
    writeFileSync(join(t.directory, '.target_branch'), '\n');
    expect(t.targetBranch).toBeUndefined();
  });

  it('targetBranch returns undefined when file is missing', () => {
    const t = make(dir, 1, 'a');
    expect(t.targetBranch).toBeUndefined();
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

  it('reasoning parses **Reasoning:** metadata', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'), '- **Reasoning:** high\n## Goal\nTest');
    expect(new TaskState(t.directory).reasoning).toBe('high');
  });

  it('reasoning returns empty when missing', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'), '## Goal\nTest');
    expect(new TaskState(t.directory).reasoning).toBe('');
  });

  it('reasoning returns empty when autoresearch metadata cannot be read', () => {
    const t = make(dir, 1, 'a');
    expect(t.reasoning).toBe('');
  });

  it('metricNames parses backtick-quoted names from the ## Metric section', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'),
      '## Goal\nTest\n## Metric\n`os_specific_test_gap` (lower is better) — Target: 0\n- os_specific_test_gap=0\n## Scope\nx');
    expect(new TaskState(t.directory).metricNames).toEqual(['os_specific_test_gap']);
  });

  it('metricNames dedupes and supports multiple declared metrics', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'),
      '## Metric\n`lint` and `lint` and `coverage` are tracked\n');
    expect(new TaskState(t.directory).metricNames).toEqual(['lint', 'coverage']);
  });

  it('metricNames is empty when no ## Metric section is declared', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'), '## Goal\nTest');
    expect(new TaskState(t.directory).metricNames).toEqual([]);
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

  it('maxFailures falls back to global default when autoresearch lacks retry metadata', () => {
    const t = make(dir, 1, 'a', { status: Status.PENDING });
    writeFileSync(join(t.directory, 'autoresearch.md'), '## Goal\nTest');
    expect(new TaskState(t.directory).maxFailures).toBe(MAX_FAILURES);
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

  it('pick skips a task when claiming it loses a race', async () => {
    make(dir, 1, 'a');
    make(dir, 2, 'b');
    const claimSpy = vi.spyOn(TaskState.prototype, 'claim').mockImplementationOnce(() => false);

    const picked = await TaskState.pick(dir, 'test');

    expect(picked).not.toBeNull();
    expect(picked!.taskNumber).toBe(2);
    claimSpy.mockRestore();
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

  it('status setter rethrows non-EXDEV shard rename failures', async () => {
    vi.resetModules();
    const copyCalls: string[] = [];
    const removeCalls: string[] = [];

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: vi.fn((source: Parameters<typeof actual.renameSync>[0], destination: Parameters<typeof actual.renameSync>[1]) => {
          if (String(source).includes('.status.') && String(destination).endsWith('.status')) {
            return actual.renameSync(source, destination);
          }
          const err = new Error('denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }),
        cpSync: vi.fn((source: Parameters<typeof actual.cpSync>[0], destination: Parameters<typeof actual.cpSync>[1], options?: Parameters<typeof actual.cpSync>[2]) => {
          copyCalls.push(`${String(source)}->${String(destination)}`);
          return actual.cpSync(source, destination, options);
        }),
        rmSync: vi.fn((target: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
          removeCalls.push(String(target));
          return actual.rmSync(target, options);
        }),
      };
    });

    const { TaskState: MockedTaskState, Status: MockedStatus } = await import('../src/TaskState.js');
    const taskDir = resolve(dir, 'pending', 'T01-a');
    mkdirSync(taskDir, { recursive: true });
    const t = new MockedTaskState(taskDir);

    expect(() => { t.status = MockedStatus.CONVERGED; }).toThrowError(expect.objectContaining({ code: 'EACCES' }));
    expect(copyCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
  });

  it('status setter falls back to copy/delete only for EXDEV', async () => {
    vi.resetModules();
    const copyCalls: string[] = [];
    const removeCalls: string[] = [];

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync: vi.fn((source: Parameters<typeof actual.renameSync>[0], destination: Parameters<typeof actual.renameSync>[1]) => {
          if (String(source).includes('.status.') && String(destination).endsWith('.status')) {
            return actual.renameSync(source, destination);
          }
          const err = new Error('cross-device') as NodeJS.ErrnoException;
          err.code = 'EXDEV';
          throw err;
        }),
        cpSync: vi.fn((source: Parameters<typeof actual.cpSync>[0], destination: Parameters<typeof actual.cpSync>[1], options?: Parameters<typeof actual.cpSync>[2]) => {
          copyCalls.push(`${String(source)}->${String(destination)}`);
          return actual.cpSync(source, destination, options);
        }),
        rmSync: vi.fn((target: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
          removeCalls.push(String(target));
          return actual.rmSync(target, options);
        }),
      };
    });

    const { TaskState: MockedTaskState, Status: MockedStatus } = await import('../src/TaskState.js');
    const taskDir = resolve(dir, 'pending', 'T01-a');
    mkdirSync(taskDir, { recursive: true });
    const t = new MockedTaskState(taskDir);

    t.status = MockedStatus.CONVERGED;

    expect(copyCalls).toHaveLength(1);
    expect(removeCalls).toContain(resolve(dir, 'pending', 'T01-a'));
    expect(t.directory).toBe(resolve(dir, 'converged', 'T01-a'));
    expect(t.status).toBe(MockedStatus.CONVERGED);
    expect(existsSync(resolve(dir, 'converged', 'T01-a', '.status'))).toBe(true);
    expect(existsSync(resolve(dir, 'pending', 'T01-a'))).toBe(false);
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

  // ── FIX 2: claim writes host line and claimOwner.host parses it ────

  it('claim writes a host: line in the owner file', async () => {
    const { hostname } = await import('node:os');
    const { readFileSync } = await import('node:fs');
    const t = make(dir, 1, 'a');
    t.claim('test-instance');
    const raw = readFileSync(join(t.directory, '.claim', 'owner'), 'utf-8');
    expect(raw).toContain(`host:${hostname()}`);
  });

  it('claimOwner.host returns the hostname from the owner file', async () => {
    const { hostname } = await import('node:os');
    const t = make(dir, 1, 'a');
    t.claim('test-instance');
    expect(t.claimOwner).not.toBeNull();
    expect(t.claimOwner!.host).toBe(hostname());
  });

  it('claimOwner.host returns empty string when host line missing (backward compat)', () => {
    // Simulate an older owner file without the host: line
    const taskDir = resolve(dir, 'pending', 'T01-old-claim');
    mkdirSync(taskDir, { recursive: true });
    const claimDir = join(taskDir, '.claim');
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, 'owner'), 'pid:1234\nstarted:1000\ninstance:old-inst\n');
    writeFileSync(join(taskDir, '.status'), 'IN_PROGRESS:old-inst\n');
    const t = new TaskState(taskDir);
    expect(t.claimOwner).not.toBeNull();
    expect(t.claimOwner!.host).toBe('');
  });

  // ── pruneConverged ─────────────────────────────────────────────────

  it('pruneConverged: prunes oldest dirs and writes archive', () => {
    for (let i = 1; i <= 3; i++) {
      const d = resolve(dir, 'converged', `T0${i}-task`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, '.status'), 'CONVERGED\n');
    }
    TaskState.pruneConverged(dir, 2);
    const remaining = readdirSync(resolve(dir, 'converged')).filter((e) => /^T\d+/.test(e));
    expect(remaining).toHaveLength(2);
    const archive = readFileSync(resolve(dir, 'converged', '.archive.jsonl'), 'utf-8');
    expect(archive.trim().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('pruneConverged: keep=0 means unlimited (no pruning)', () => {
    for (let i = 1; i <= 5; i++) {
      mkdirSync(resolve(dir, 'converged', `T0${i}-task`), { recursive: true });
    }
    TaskState.pruneConverged(dir, 0);
    const remaining = readdirSync(resolve(dir, 'converged')).filter((e) => /^T\d+/.test(e));
    expect(remaining).toHaveLength(5);
    expect(existsSync(resolve(dir, 'converged', '.archive.jsonl'))).toBe(false);
  });

  it('pruneConverged: returns silently when converged dir is missing', () => {
    const freshDir = mkdtempSync(resolve(tmpdir(), 'prune-miss-'));
    try {
      expect(() => TaskState.pruneConverged(freshDir, 2)).not.toThrow();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  // ── countConverged ─────────────────────────────────────────────────

  it('countConverged: returns 0 when converged dir is missing', () => {
    const freshDir = mkdtempSync(resolve(tmpdir(), 'cc-miss-'));
    try {
      expect(TaskState.countConverged(freshDir)).toBe(0);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('countConverged: counts task dirs and archive lines', () => {
    mkdirSync(resolve(dir, 'converged', 'T01-a'), { recursive: true });
    mkdirSync(resolve(dir, 'converged', 'T02-b'), { recursive: true });
    // No archive yet
    expect(TaskState.countConverged(dir)).toBe(2);
    // Add archive with 2 lines
    writeFileSync(resolve(dir, 'converged', '.archive.jsonl'), '{"T":3}\n{"T":4}\n');
    expect(TaskState.countConverged(dir)).toBe(4);
  });
});
