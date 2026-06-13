import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

function gitErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message.replace(/\s+/g, ' ').trim() : String(e);
}

/** Thrown when merging the task branch into the base branch hits a conflict. */
export class MergeConflictError extends Error {}

export interface WorktreeOptions {
  readonly name: string;
  readonly baseBranch?: string;
  readonly worktreesDir?: string;
}

export class Worktree {
  readonly #repo: string;
  readonly #name: string;
  readonly #branch: string;
  readonly #path: string;
  readonly #base: string;

  constructor(repoDir: string, opts: WorktreeOptions) {
    this.#repo = repoDir;
    this.#name = opts.name;
    this.#branch = `orchestrator/${opts.name}`;
    this.#path = resolve(opts.worktreesDir ?? join(repoDir, '.worktrees'), opts.name);
    this.#base = opts.baseBranch ?? 'master';
  }

  get path(): string {
    return this.#path;
  }
  get branch(): string {
    return this.#branch;
  }
  get exists(): boolean {
    return existsSync(join(this.#path, '.git'));
  }

  create(): string {
    if (this.exists) return this.#path;

    try {
      this.#add();
    } catch {
      // Self-heal leftovers from a crashed run: prune stale worktree
      // registrations and drop a partial path, then retry once.
      try { this.#git('worktree', 'prune'); } catch {}
      try { rmSync(this.#path, { recursive: true, force: true }); } catch {}
      this.#add();
    }
    // Configure git user in worktree (needed for commits)
    const name = this.#gitConfig('user.name') || 'Orchestrator';
    const email = this.#gitConfig('user.email') || 'orchestrator@local';
    this.#gitInWT('config', 'user.name', name);
    this.#gitInWT('config', 'user.email', email);

    return this.#path;
  }

  /** Add the worktree, reusing the branch if a prior run already created it
   *  (preserves its commits) instead of failing on "branch already exists". */
  #add(): void {
    if (this.#branchExists()) {
      this.#git('worktree', 'add', this.#path, this.#branch);
    } else {
      this.#git('worktree', 'add', '-b', this.#branch, this.#path, this.#base);
    }
  }

  #branchExists(): boolean {
    try {
      this.#git('rev-parse', '--verify', '--quiet', `refs/heads/${this.#branch}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring the latest base branch into the task branch, inside the worktree,
   * before merging back. This resolves the common case where the base advanced
   * (e.g. a sibling task merged) while the agent worked, so only genuinely
   * overlapping edits still conflict. A real conflict is aborted and surfaced
   * as a MergeConflictError, handled like any other merge conflict.
   */
  syncWithBase(): void {
    try {
      this.#gitInWT('merge', '--no-edit', this.#base);
    } catch (e: unknown) {
      const hasConflict = this.#hasUnmergedPaths(this.#path);
      try { this.#gitInWT('merge', '--abort'); } catch {}
      if (hasConflict) {
        throw new MergeConflictError(`Conflict updating ${this.#branch} with ${this.#base}: ${gitErrorMessage(e)}`);
      }
      throw new Error(`Failed to merge ${this.#base} into ${this.#branch}: ${gitErrorMessage(e)}`);
    }
  }

  merge(): void {
    const prevBranch = this.#git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    try {
      this.#git('checkout', this.#base);
    } catch (e: unknown) {
      try { this.#git('checkout', prevBranch); } catch {}
      throw new Error(`Unable to switch to ${this.#base} before merging ${this.#branch}: ${gitErrorMessage(e)}`);
    }

    try {
      this.#git('merge', '--no-ff', this.#branch, '-m', `Merge ${this.#branch}`);
    } catch (e: unknown) {
      const hasConflict = this.#hasUnmergedPaths(this.#repo);
      try { this.#git('merge', '--abort'); } catch {}
      try { this.#git('checkout', prevBranch); } catch {}
      if (hasConflict) {
        throw new MergeConflictError(`Merge conflict in ${this.#name}; branch ${this.#branch} kept: ${gitErrorMessage(e)}`);
      }
      throw new Error(`Merge of ${this.#branch} failed: ${gitErrorMessage(e)}`);
    }
    try { this.#git('checkout', prevBranch); } catch {}
  }

  stashParentChanges(message: string): boolean {
    if (!this.#git('status', '--porcelain').trim()) return false;
    this.#git('stash', 'push', '-u', '-m', message);
    return true;
  }

  /** Discard all uncommitted worktree changes so the agent starts clean. */
  cleanWorktree(): void {
    try { this.#gitInWT('reset', 'HEAD'); } catch {}
    try {
      // Reset tracked files; --quiet suppresses errors for empty repos
      this.#gitInWT('checkout', '--', '.');
    } catch { /* no tracked files to reset */ }
    try { this.#gitInWT('clean', '-fd'); } catch {}
  }

  /** Commit any uncommitted changes in the worktree so merge captures
   *  everything the benchmark validates. Returns true if a commit was made. */
  autoCommit(message: string): boolean {
    try {
      if (!this.#gitInWT('status', '--porcelain').trim()) return false;
      this.#gitInWT('add', '-A');
      this.#gitInWT('commit', '-m', message);
      return true;
    } catch { return false; }
  }

  /** Discard all worktree changes and reset the branch to the current base */
  resetForRetry(): void {
    try {
      this.cleanWorktree();
      this.#gitInWT('reset', '--hard', this.#base);
    } catch { /* best-effort */ }
  }

  remove(): void {
    try { this.#git('worktree', 'remove', '--force', this.#path); } catch {}
    try { this.#git('branch', '-D', this.#branch); } catch {}
  }

  // ── Private ──────────────────────────────────────────────────────────

  #git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.#repo, encoding: 'utf-8' });
  }

  #gitInWT(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.#path, encoding: 'utf-8' });
  }

  #hasUnmergedPaths(cwd: string): boolean {
    try {
      return execFileSync('git', ['ls-files', '--unmerged'], { cwd, encoding: 'utf-8' }).trim().length > 0;
    } catch {
      return false;
    }
  }

  #gitConfig(key: string): string {
    try {
      return execFileSync('git', ['config', key], { cwd: this.#repo, encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  }
}
