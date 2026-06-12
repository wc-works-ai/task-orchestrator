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

  async create(): Promise<string> {
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
  async syncWithBase(): Promise<void> {
    try {
      this.#gitInWT('merge', '--no-edit', this.#base);
    } catch (e: unknown) {
      try { this.#gitInWT('merge', '--abort'); } catch {}
      throw new MergeConflictError(`Conflict updating ${this.#branch} with ${this.#base} in ${this.#name}; branch kept to merge after the block is released: ${gitErrorMessage(e)}`);
    }
  }

  async merge(): Promise<void> {
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
      // Conflict: do not auto-resolve — never silently discard anyone's work.
      // Abort the merge, restore the previous branch so the main checkout stays
      // clean, and keep this branch as-is so it can be merged after the block is
      // released.
      try { this.#git('merge', '--abort'); } catch {}
      try { this.#git('checkout', prevBranch); } catch {}
      throw new MergeConflictError(`Merge conflict in ${this.#name}; branch ${this.#branch} kept to merge after the block is released: ${gitErrorMessage(e)}`);
    }
  }

  async stashParentChanges(message: string): Promise<boolean> {
    if (!this.#git('status', '--porcelain').trim()) return false;
    this.#git('stash', 'push', '-u', '-m', message);
    return true;
  }

  /** Discard all worktree changes — agent starts fresh on retry */
  async resetForRetry(): Promise<void> {
    try {
      this.#gitInWT('checkout', this.#base);          // detach from branch
      this.#gitInWT('checkout', '-B', this.#branch);   // recreate branch at base
    } catch { /* best-effort */ }
  }

  async remove(): Promise<void> {
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

  #gitConfig(key: string): string {
    try {
      return execFileSync('git', ['config', key], { cwd: this.#repo, encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  }
}
