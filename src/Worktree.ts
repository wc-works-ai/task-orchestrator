import { execSync } from 'node:child_process';
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

  get path(): string { return this.#path; }
  get branch(): string { return this.#branch; }
  get exists(): boolean { return existsSync(join(this.#path, '.git')); }

  async create(): Promise<string> {
    if (this.exists) return this.#path;

    this.#git('worktree', 'add', '-b', this.#branch, this.#path, this.#base);
    // Configure git user in worktree (needed for commits)
    const name = this.#gitConfig('user.name') || 'Orchestrator';
    const email = this.#gitConfig('user.email') || 'orchestrator@local';
    this.#gitInWT('config', 'user.name', name);
    this.#gitInWT('config', 'user.email', email);

    return this.#path;
  }

  async merge(): Promise<void> {
    // Checkout base branch and merge
    const prevBranch = this.#git('rev-parse', '--abbrev-ref', 'HEAD').trim();

    try {
      this.#git('checkout', this.#base);
      this.#git('merge', '--no-ff', this.#branch, '-m', `Merge ${this.#branch}`);
    } catch (e: any) {
      // Abort merge on conflict
      try { this.#git('merge', '--abort'); } catch {}
      try { this.#git('checkout', prevBranch); } catch {}
      throw new Error(`Merge conflict in ${this.#name}: ${e?.message ?? 'unknown'}`);
    }
  }

  async remove(): Promise<void> {
    try { this.#git('worktree', 'remove', '--force', this.#path); } catch {}
    try { this.#git('branch', '-D', this.#branch); } catch {}
  }

  // ── Private ──────────────────────────────────────────────────────────

  #git(...args: string[]): string {
    return execSync(`git ${args.join(' ')}`, { cwd: this.#repo, encoding: 'utf-8' });
  }

  #gitInWT(...args: string[]): string {
    return execSync(`git ${args.join(' ')}`, { cwd: this.#path, encoding: 'utf-8' });
  }

  #gitConfig(key: string): string {
    try { return execSync(`git config ${key}`, { cwd: this.#repo, encoding: 'utf-8' }).trim(); }
    catch { return ''; }
  }
}
