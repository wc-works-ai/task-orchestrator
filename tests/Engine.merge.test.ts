import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Engine } from '../src/Engine.js';
import { TaskState } from '../src/TaskState.js';

const LOCK = '.orchestrator-merge-lock';

/** Real git repo + a single converging task. The agent makes a non-overlapping
 *  change in the worktree and never advances the base, so syncWithBase is a
 *  clean no-op and the merge path is exercised without a real conflict. */
function scenario(dir: string) {
  const repoDir = resolve(dir, 'repo');
  const tasksDir = resolve(dir, 'tasks');
  const worktreesDir = resolve(dir, 'worktrees');
  mkdirSync(repoDir, { recursive: true });
  execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: repoDir });
  for (const s of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(tasksDir, s), { recursive: true });
  }
  const d = resolve(tasksDir, 'pending', 'T01-x');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, '.status'), 'PENDING\n');

  const spawn = vi.fn().mockImplementation(async (_t: TaskState, wtPath?: string) => {
    if (!wtPath) throw new Error('missing worktree path');
    writeFileSync(join(wtPath, 'work.txt'), 'work');
    execSync('git add work.txt && git commit -m "work"', { cwd: wtPath });
    return { success: true, iterations: 1 };
  });
  return { repoDir, tasksDir, worktreesDir, spawn };
}

function writeLock(repoDir: string, startedMs: number): void {
  const lockDir = join(repoDir, LOCK);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner'), `pid:999999\nhost:other\nstarted:${startedMs}\n`);
}

describe('Engine merge robustness', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(resolve('/tmp', 'eng-merge-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('defers the merge when another orchestrator holds the merge lock', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();            // cz=1
    await engine.tick();            // cz=2
    writeLock(repoDir, Date.now()); // fresh lock held by another orchestrator
    const r = await engine.tick();  // cz=3 → merge deferred

    expect(r.converged).toBe(false);
    const t = (await TaskState.scan(tasksDir)).get('1')!;
    expect(t.isInProgress).toBe(true);  // not blocked, not converged — will retry
    expect(t.isBlocked).toBe(false);
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(true); // worktree kept
  });

  it('breaks a stale merge lock and completes the merge', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    const benchmark = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();
    await engine.tick();
    writeLock(repoDir, Date.now() - 700_000); // older than the 600s default ceiling
    const r = await engine.tick();

    expect(r.converged).toBe(true);
    expect(existsSync(join(repoDir, 'work.txt'))).toBe(true); // merged into base
    expect(existsSync(join(repoDir, LOCK))).toBe(false);      // lock released
  });

  it('sends the task back to the agent when base drift breaks acceptance after sync', async () => {
    const { repoDir, tasksDir, worktreesDir, spawn } = scenario(dir);
    // pre, post (tick1), tick2, tick3, then the post-sync re-verify reports
    // non-zero → rework; anything after stays 0.
    const benchmark = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0).mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1).mockResolvedValue(0);
    const engine = new Engine(tasksDir, { benchmark, spawn, repoDir, worktreesDir });

    await engine.tick();
    await engine.tick();
    const r = await engine.tick();

    expect(r.converged).toBe(false);
    const t = (await TaskState.scan(tasksDir)).get('1')!;
    expect(t.isInProgress).toBe(true);  // not blocked — the agent gets another pass
    expect(t.convergenceCount).toBe(0); // reset so acceptance must be re-proven
    expect(existsSync(join(worktreesDir, 'T01-x', '.git'))).toBe(true); // worktree kept
  });
});
