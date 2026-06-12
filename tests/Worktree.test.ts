import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { Worktree, MergeConflictError } from '../src/Worktree.js';

function setup() {
  const dir = mkdtempSync(resolve('/tmp', 'wt-test-'));
  // Init a git repo
  execSync('git init && git config user.email test@test && git config user.name test && git commit --allow-empty -m init', { cwd: dir });
  return dir;
}

function readGlobalGitConfig(cwd: string, key: string): string {
  try {
    return execFileSync('git', ['config', '--global', key], { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function unsetGlobalGitConfig(cwd: string, key: string): void {
  try { execFileSync('git', ['config', '--global', '--unset', key], { cwd }); } catch {}
}

function writeGlobalGitConfig(cwd: string, key: string, value: string): void {
  execFileSync('git', ['config', '--global', key, value], { cwd });
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
    expect(existsSync(join(wt.path, '.git'))).toBe(true);
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

  it('throws without removing worktree when parent checkout is blocked by local changes', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repo, 'tracked.txt'), 'master');
    execSync('git add tracked.txt && git commit -m "master tracked"', { cwd: repo });
    execSync('git checkout -b dev', { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'dev');
    execSync('git add tracked.txt && git commit -m "dev tracked"', { cwd: repo });

    const wt = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    await wt.create();
    writeFileSync(join(wt.path, 'work.txt'), 'worktree');
    execSync('git add work.txt && git commit -m "work"', { cwd: wt.path });

    writeFileSync(join(repo, 'tracked.txt'), 'dirty dev');

    expect(() => wt.merge()).toThrow(/Unable to switch to master/);
    expect(existsSync(join(wt.path, '.git'))).toBe(true);
    expect(execSync('git branch --show-current', { cwd: repo, encoding: 'utf-8' }).trim()).toBe('dev');
  });

  it('stashes parent changes only when parent repo is dirty', async () => {
    const { writeFileSync } = await import('node:fs');
    const wt = new Worktree(repo, { name: 'T01-test' });

    expect(wt.stashParentChanges('clean stash')).toBe(false);

    writeFileSync(join(repo, 'dirty.txt'), 'dirty');
    expect(wt.stashParentChanges('dirty stash')).toBe(true);

    expect(execSync('git status --porcelain', { cwd: repo, encoding: 'utf-8' })).toBe('');
    expect(execSync('git stash list', { cwd: repo, encoding: 'utf-8' })).toContain('dirty stash');
  });

  it('throws MergeConflictError and keeps the branch when merge conflicts', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    const { writeFileSync } = await import('node:fs');
    // Main and worktree change the same file differently → conflict on merge
    writeFileSync(join(repo, 'shared.txt'), 'main content');
    execSync('git add shared.txt && git commit -m "main change"', { cwd: repo });
    writeFileSync(join(wt.path, 'shared.txt'), 'worktree content');
    execSync('git add shared.txt && git commit -m "wt change"', { cwd: wt.path });

    expect(() => wt.merge()).toThrow(MergeConflictError);

    // No silent resolution: main file untouched, branch kept, merge aborted cleanly
    expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('main content');
    expect(execSync('git branch', { cwd: repo, encoding: 'utf-8' })).toContain('orchestrator/T01-test');
    expect(() => execSync('git rev-parse -q --verify MERGE_HEAD', { cwd: repo, encoding: 'utf-8' })).toThrow();
  });

  it('remove deletes worktree and branch', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    wt.remove();
    expect(existsSync(join(wt.path, '.git'))).toBe(false);
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
    expect(() => wt.resetForRetry()).not.toThrow();
  });

  it('reuses existing worktree without error', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    // Second create should not throw
    await wt.create();
    expect(existsSync(join(wt.path, '.git'))).toBe(true);
  });

  it('exists returns false for non-existent worktree', () => {
    const wt = new Worktree(repo, { name: 'T99-never' });
    expect(existsSync(join(wt.path, '.git'))).toBe(false);
  });

  it('exposes branch and path getters', async () => {
    const wt = new Worktree(repo, { name: 'T01-test' });
    await wt.create();
    expect(wt.path).toContain('T01-test');
    expect(wt.branch).toBe('orchestrator/T01-test');
  });

  it('uses fallback when git config is unset', async () => {
    // Create a fresh repo without git user config
    const { mkdtempSync } = await import('node:fs');
    const unsetRepo = mkdtempSync(resolve('/tmp', 'wt-noconfig-'));
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: unsetRepo });
      const wt = new Worktree(unsetRepo, { name: 'T01-test' });
      await wt.create();
      expect(existsSync(join(wt.path, '.git'))).toBe(true);
      // Clean up worktree so we can remove repo
      wt.remove();
    } finally {
      await rm(unsetRepo, { recursive: true, force: true });
    }
  });

  it('remove is best-effort with non-existent worktree', async () => {
    const wt = new Worktree(repo, { name: 'T99-nonexistent' });
    // Should not throw
    expect(() => wt.remove()).not.toThrow();
  });

  it('gitConfig returns empty for unset config', async () => {
    const { mkdtempSync } = await import('node:fs');
    const bareRepo = mkdtempSync(resolve('/tmp', 'wt-bare-'));
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: bareRepo });
      // Create a worktree which calls #gitConfig for user.name/user.email
      const wt = new Worktree(bareRepo, { name: 'T01-test' });
      // Temporarily unset global user config for this test
      const origUser = readGlobalGitConfig(bareRepo, 'user.name');
      const origEmail = readGlobalGitConfig(bareRepo, 'user.email');
      try {
        if (origUser) unsetGlobalGitConfig(bareRepo, 'user.name');
        if (origEmail) unsetGlobalGitConfig(bareRepo, 'user.email');
        // Now create — should not throw even without user config
        await wt.create();
        expect(existsSync(join(wt.path, '.git'))).toBe(true);
      } finally {
        if (origUser) writeGlobalGitConfig(bareRepo, 'user.name', origUser);
        if (origEmail) writeGlobalGitConfig(bareRepo, 'user.email', origEmail);
      }
      wt.remove();
    } finally {
      await rm(bareRepo, { recursive: true, force: true });
    }
  });

  it('syncWithBase brings an advanced base into the branch, then merges cleanly', async () => {
    const { writeFileSync } = await import('node:fs');
    const wt = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    await wt.create();

    // Task work on the branch
    writeFileSync(join(wt.path, 'work.txt'), 'work');
    execSync('git add work.txt && git commit -m "work"', { cwd: wt.path });

    // Base advances with a non-overlapping file while the agent worked
    writeFileSync(join(repo, 'base.txt'), 'base');
    execSync('git add base.txt && git commit -m "base advance"', { cwd: repo });

    await wt.syncWithBase();
    expect(existsSync(join(wt.path, 'base.txt'))).toBe(true); // branch now has the base advance

    await wt.merge();
    expect(existsSync(join(repo, 'work.txt'))).toBe(true);    // back-merge succeeds
  });

  it('syncWithBase throws MergeConflictError and aborts on overlapping edits', async () => {
    const { writeFileSync } = await import('node:fs');
    const wt = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    await wt.create();

    // Branch and base edit the same file differently → genuine conflict
    writeFileSync(join(wt.path, 'shared.txt'), 'worktree');
    execSync('git add shared.txt && git commit -m "wt"', { cwd: wt.path });
    writeFileSync(join(repo, 'shared.txt'), 'base');
    execSync('git add shared.txt && git commit -m "base"', { cwd: repo });

    expect(() => wt.syncWithBase()).toThrow(MergeConflictError);

    // Aborted cleanly: no MERGE_HEAD left, branch kept
    expect(() => execSync('git rev-parse -q --verify MERGE_HEAD', { cwd: wt.path, encoding: 'utf-8' })).toThrow();
    expect(execSync('git branch --show-current', { cwd: wt.path, encoding: 'utf-8' }).trim()).toBe('orchestrator/T01-test');
  });

  it('syncWithBase throws plain Error for non-conflict merge failures', async () => {
    const { writeFileSync } = await import('node:fs');
    const wt = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    await wt.create();

    writeFileSync(join(wt.path, 'shared.txt'), 'local uncommitted change');
    writeFileSync(join(repo, 'shared.txt'), 'base committed change');
    execSync('git add shared.txt && git commit -m "base change"', { cwd: repo });

    const error = (() => {
      try {
        wt.syncWithBase();
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MergeConflictError);
    expect((error as Error).message).toContain('Failed to merge master into orchestrator/T01-test');
    expect(() => execSync('git rev-parse -q --verify MERGE_HEAD', { cwd: wt.path, encoding: 'utf-8' })).toThrow();
  });

  it('create reuses a branch left behind by a crashed run (preserves work)', async () => {
    const { writeFileSync } = await import('node:fs');
    // Simulate a crash that left the task branch (with work) but no worktree.
    execSync('git worktree add .crashwt -b orchestrator/T01-test master', { cwd: repo });
    writeFileSync(join(repo, '.crashwt', 'prior.txt'), 'prior work');
    execSync('git add prior.txt && git commit -m "prior work"', { cwd: join(repo, '.crashwt') });
    execSync('git worktree remove --force .crashwt', { cwd: repo });

    const wt = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    const path = await wt.create(); // must not fail on "branch already exists"
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(existsSync(join(path, 'prior.txt'))).toBe(true); // reused branch → prior work kept
  });

  it('create self-heals a stale worktree registration left by a crash', async () => {
    const wt1 = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    const p = await wt1.create();
    // Crash: directory vanishes but git keeps the registration + branch.
    rmSync(p, { recursive: true, force: true });

    const wt2 = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    const path = await wt2.create(); // first add fails → prune → retry succeeds
    expect(existsSync(join(path, '.git'))).toBe(true);
  });

  it('merge throws plain Error for non-conflict merge failures', async () => {
    const { writeFileSync } = await import('node:fs');
    const wt = new Worktree(repo, { name: 'T01-test', baseBranch: 'master' });
    await wt.create();

    writeFileSync(join(wt.path, 'shared.txt'), 'branch committed change');
    execSync('git add shared.txt && git commit -m "branch change"', { cwd: wt.path });

    writeFileSync(join(repo, 'shared.txt'), 'main uncommitted change');

    const error = (() => {
      try {
        wt.merge();
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MergeConflictError);
    expect((error as Error).message).toContain('Merge of orchestrator/T01-test failed');
    expect(execSync('git branch --show-current', { cwd: repo, encoding: 'utf-8' }).trim()).toBe('master');
    expect(() => execSync('git rev-parse -q --verify MERGE_HEAD', { cwd: repo, encoding: 'utf-8' })).toThrow();
  });

  it('falls back to stringified non-Error merge failures when unmerged-path detection also fails', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn((_command: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse') return 'master\n';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') throw 'plain-string failure';
        if (args[0] === 'merge' && args[1] === '--abort') return '';
        if (args[0] === 'ls-files') throw new Error('ls-files failed');
        return '';
      }),
    }));

    try {
      const { Worktree: MockedWorktree } = await import('../src/Worktree.js');
      const wt = new MockedWorktree('Q:\\Repos\\not-a-repo', { name: 'T01-test' });

      expect(() => wt.merge()).toThrow('Merge of orchestrator/T01-test failed: plain-string failure');
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});
