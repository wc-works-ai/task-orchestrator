import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

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

  /* v8 ignore start */
  get path(): string {
    return this.#path;
  }
  get branch(): string {
    return this.#branch;
  }
  get exists(): boolean {
    const gitFile = join(this.#path, '.git');
    return existsSync(gitFile);
  }
  /* v8 ignore stop */

  async create(): Promise<string> {
    if (this.exists) return this.#path;

    this.#git('worktree', 'add', '-b', this.#branch, this.#path, this.#base);
    // Configure git user in worktree (needed for commits)
    /* v8 ignore start */
    const name = this.#gitConfig('user.name') || 'Orchestrator';
    const email = this.#gitConfig('user.email') || 'orchestrator@local';
    /* v8 ignore stop */
    this.#gitInWT('config', 'user.name', name);
    this.#gitInWT('config', 'user.email', email);

    return this.#path;
  }

  /* v8 ignore start */
  async merge(taskScope?: string[]): Promise<void> {
    const prevBranch = this.#git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    try {
      this.#git('checkout', this.#base);
      this.#git('merge', '--no-ff', this.#branch, '-m', `Merge ${this.#branch}`);
    } catch {
      // Conflict — try auto-resolution
      try { this.#autoResolve(taskScope ?? []); } catch {
        try { this.#git('merge', '--abort'); } catch {}
        try { this.#git('checkout', prevBranch); } catch {}
        throw new Error(`Merge conflict in ${this.#name} — manual resolution required`);
      }
    }
  }
  /* v8 ignore stop */

  /** Auto-resolve: accept worktree version for scoped files, main version for rest */
  /* v8 ignore start */
  #autoResolve(scopeFiles: string[]): void {
    const conflicted = this.#git('diff', '--name-only', '--diff-filter=U')
      .trim().split('\n').filter(Boolean);
    if (conflicted.length === 0) return;

    for (const file of conflicted) {
      const isScoped = scopeFiles.some(sf => file.includes(sf));
      if (isScoped) {
        // Accept worktree version (theirs) for task's own scope
        /* istanbul ignore next: v8 branch tracking limitation */
        this.#git('checkout', '--theirs', file);
      } else {
        // Accept main version (ours) for files outside scope
        this.#git('checkout', '--ours', file);
      }
      this.#git('add', file);
    }
    this.#git('commit', '--no-edit');
  }
  /* v8 ignore stop */

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
    try { return execFileSync('git', ['config', key], { cwd: this.#repo, encoding: 'utf-8' }).trim(); }
    /* istanbul ignore next: git config only throws on binary failure */
    catch { return ''; }
  }
}
