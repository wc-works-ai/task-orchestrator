import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
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

  it('merge conflict marks as failed', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    // Create conflicting changes in both main and worktree
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repo, 'conflict.txt'), 'main');
    execSync('git add conflict.txt && git commit -m "main change"', { cwd: repo });
    writeFileSync(join(wt.path, 'conflict.txt'), 'worktree');
    execSync('git add conflict.txt && git commit -m "wt change"', { cwd: wt.path });
    // Merge should throw
    await expect(wt.merge()).rejects.toThrow(/conflict/i);
  });

  it('remove deletes worktree and branch', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    await wt.remove();
    expect(wt.exists).toBe(false);
    const branches = execSync('git branch', { cwd: repo, encoding: 'utf-8' });
    expect(branches).not.toContain('orchestrator/T01-test');
  });

  it('reuses existing worktree without error', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    // Second create should not throw
    await wt.create();
    expect(wt.exists).toBe(true);
  });
});
