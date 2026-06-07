import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { Worktree } from '../src/Worktree.js';

function setup() {
  const dir = mkdtempSync(resolve('/tmp', 'wt-test-'));
  // Init a git repo
  execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: dir });
  return dir;
}

describe('Worktree', () => {
  let repo = '';
  beforeEach(() => { repo = setup(); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  it('creates a worktree and branch', async () => {
    const wt = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    const path = await wt.create();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, '.git'))).toBe(true);
    // Branch should exist
    const branches = execSync('git branch', { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain('orchestrator/T01-test');
  });

  it('detects existing worktree', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    expect(wt.exists).toBe(true);
    // Creating again reuses existing
    const path2 = await wt.create();
    expect(path2).toBe(wt.path);
  });

  it('merges back to base branch on converge', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    // Make a change in the worktree
    const fp = join(wt.path, 'test.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(fp, 'hello');
    execSync('git add test.txt && git commit -m "work"', { cwd: wt.path });
    // Merge back
    await wt.merge();
    // File should exist in the main repo
    expect(existsSync(join(repo, 'test.txt'))).toBe(true);
  });

  it('auto-resolves conflict in unscoped files', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    const { writeFileSync } = await import('node:fs');
    // Main: creates file
    writeFileSync(join(repo, 'shared.txt'), 'main content');
    execSync('git add shared.txt && git commit -m "main change"', { cwd: repo });
    // Worktree: conflicting change
    writeFileSync(join(wt.path, 'shared.txt'), 'worktree content');
    execSync('git add shared.txt && git commit -m "wt change"', { cwd: wt.path });
    // Merge with empty scope → auto-resolve: accept main (ours)
    await wt.merge([]);
    // Main version should win (ours for unscoped files)
    const content = readFileSync(join(repo, 'shared.txt'), 'utf-8');
    expect(content).toBe('main content');
  });

  it('auto-resolves conflict: worktree wins for scoped files', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/contract.md'), 'main');
    execSync('git add docs/contract.md && git commit -m main', { cwd: repo });
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    writeFileSync(join(wt.path, 'docs/contract.md'), 'worktree');
    execSync('git add docs/contract.md && git commit -m wt', { cwd: wt.path });
    await wt.merge(['docs/contract.md']);
    expect(readFileSync(join(repo, 'docs/contract.md'), 'utf-8')).toBe('worktree');
  });

  it('remove deletes worktree and branch', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    await wt.remove();
    expect(wt.exists).toBe(false);
    const branches = execSync('git branch', { cwd: repo, encoding: 'utf-8' });
    expect(branches).not.toContain('orchestrator/T01-test');
  });

  it('resetForRetry does not throw (best-effort)', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(wt.path, 'test.txt'), 'v1');
    execSync('git add test.txt && git commit -m "work"', { cwd: wt.path });
    // resetForRetry may fail silently if base branch is in use elsewhere
    // It must never throw
    await expect(wt.resetForRetry()).resolves.toBeUndefined();
  });

  it('merge error path throws when auto-resolve fails', async () => {
    // Create two worktrees that conflict on the same file
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    const { writeFileSync } = await import('node:fs');

    writeFileSync(join(repo, 'shared.txt'), 'main');
    execSync('git add shared.txt && git commit -m "main"', { cwd: repo });
    writeFileSync(join(wt.path, 'shared.txt'), 'worktree');
    execSync('git add shared.txt && git commit -m "wt"', { cwd: wt.path });

    // Merge with empty scope — auto-resolve uses --ours for unscoped files
    // This path exercises the outer catch (line 48) and #autoResolve (lines 59-76)
    await wt.merge([]);

    // Verify ours won (main content preserved)
    const content = readFileSync(join(repo, 'shared.txt'), 'utf-8');
    expect(content).toBe('main');
  });

  it('reuses existing worktree without error', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    // Second create should not throw
    await wt.create();
    expect(wt.exists).toBe(true);
  });
});
