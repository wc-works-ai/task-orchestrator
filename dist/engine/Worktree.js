import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
function gitErrorMessage(e) {
    return e instanceof Error ? e.message.replace(/\s+/g, ' ').trim() : String(e);
}
function logWorktreeWarning(action, e) {
    console.warn(`[Worktree] ${action}: ${gitErrorMessage(e)}`);
}
/** Thrown when merging the task branch into the base branch hits a conflict. */
export class MergeConflictError extends Error {
}
export class Worktree {
    #repo;
    #name;
    #branch;
    #path;
    #base;
    constructor(repoDir, opts) {
        this.#repo = repoDir;
        this.#name = opts.name;
        this.#branch = `orchestrator/${opts.name}`;
        this.#path = resolve(opts.worktreesDir ?? join(repoDir, '.worktrees'), opts.name);
        this.#base = opts.baseBranch ?? 'master';
    }
    get path() {
        return this.#path;
    }
    get branch() {
        return this.#branch;
    }
    /** Current commit SHA of the base branch — used to detect base advancement
     *  between benchmark generation and a later agent-work cycle. */
    baseSha() {
        return this.#git('rev-parse', this.#base).trim();
    }
    get exists() {
        return existsSync(join(this.#path, '.git'));
    }
    create() {
        if (this.exists)
            return this.#path;
        try {
            this.#add();
        }
        catch (e) {
            // Self-heal leftovers from a crashed run: prune stale worktree
            // registrations and drop a partial path, then retry once.
            /* v8 ignore next */
            logWorktreeWarning(`initial worktree add failed for ${this.#branch}; attempting self-heal`, e);
            try {
                this.#git('worktree', 'prune');
            }
            catch (pruneError) {
                /* v8 ignore next */
                logWorktreeWarning(`worktree prune failed for ${this.#branch}`, pruneError);
            }
            try {
                rmSync(this.#path, { recursive: true, force: true });
            }
            catch (removeError) {
                /* v8 ignore next */
                logWorktreeWarning(`failed to remove partial worktree path ${this.#path}`, removeError);
            }
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
    #add() {
        if (this.#branchExists()) {
            this.#git('worktree', 'add', this.#path, this.#branch);
        }
        else {
            this.#git('worktree', 'add', '-b', this.#branch, this.#path, this.#base);
        }
    }
    #branchExists() {
        try {
            this.#git('rev-parse', '--verify', '--quiet', `refs/heads/${this.#branch}`);
            return true;
        }
        catch {
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
    syncWithBase() {
        try {
            this.#gitInWT('merge', '--no-edit', this.#base);
        }
        catch (e) {
            const hasConflict = this.#hasUnmergedPaths(this.#path);
            try {
                this.#gitInWT('merge', '--abort');
            }
            catch (abortError) {
                /* v8 ignore next */
                logWorktreeWarning(`failed to abort merge in ${this.#path}`, abortError);
            }
            if (hasConflict) {
                throw new MergeConflictError(`Conflict updating ${this.#branch} with ${this.#base}: ${gitErrorMessage(e)}`);
            }
            throw new Error(`Failed to merge ${this.#base} into ${this.#branch}: ${gitErrorMessage(e)}`);
        }
    }
    merge() {
        const prevBranch = this.#git('rev-parse', '--abbrev-ref', 'HEAD').trim();
        try {
            this.#git('checkout', this.#base);
        }
        catch (e) {
            try {
                this.#git('checkout', prevBranch);
            }
            catch (restoreError) {
                /* v8 ignore next */
                logWorktreeWarning(`failed to restore parent branch ${prevBranch}`, restoreError);
            }
            throw new Error(`Unable to switch to ${this.#base} before merging ${this.#branch}: ${gitErrorMessage(e)}`);
        }
        try {
            this.#git('merge', '--no-ff', this.#branch, '-m', `Merge ${this.#branch}`);
        }
        catch (e) {
            const hasConflict = this.#hasUnmergedPaths(this.#repo);
            try {
                this.#git('merge', '--abort');
            }
            catch (abortError) {
                /* v8 ignore next */
                logWorktreeWarning(`failed to abort parent merge for ${this.#branch}`, abortError);
            }
            try {
                this.#git('checkout', prevBranch);
            }
            catch (restoreError) {
                /* v8 ignore next */
                logWorktreeWarning(`failed to restore parent branch ${prevBranch}`, restoreError);
            }
            if (hasConflict) {
                throw new MergeConflictError(`Merge conflict in ${this.#name}; branch ${this.#branch} kept: ${gitErrorMessage(e)}`);
            }
            throw new Error(`Merge of ${this.#branch} failed: ${gitErrorMessage(e)}`);
        }
        try {
            this.#git('checkout', prevBranch);
        }
        catch (restoreError) {
            /* v8 ignore next */
            logWorktreeWarning(`failed to restore parent branch ${prevBranch}`, restoreError);
        }
    }
    stashParentChanges(message) {
        if (!this.#git('status', '--porcelain').trim())
            return false;
        this.#git('stash', 'push', '-u', '-m', message);
        return true;
    }
    /** Discard all uncommitted worktree changes so the agent starts clean. */
    cleanWorktree() {
        try {
            this.#gitInWT('reset', 'HEAD');
        }
        catch (e) {
            /* v8 ignore next */
            logWorktreeWarning(`failed to unstage worktree changes in ${this.#path}`, e);
        }
        try {
            // Reset tracked files; --quiet suppresses errors for empty repos
            this.#gitInWT('checkout', '--', '.');
        }
        catch (e) {
            /* v8 ignore next */
            logWorktreeWarning(`failed to reset tracked files in ${this.#path}`, e);
        }
        try {
            this.#gitInWT('clean', '-fd');
        }
        catch (e) {
            /* v8 ignore next */
            logWorktreeWarning(`failed to clean untracked files in ${this.#path}`, e);
        }
    }
    /** Commit any uncommitted changes in the worktree so merge captures
     *  everything the benchmark validates. Returns true if a commit was made. */
    autoCommit(message) {
        try {
            if (!this.#gitInWT('status', '--porcelain').trim())
                return false;
            this.#gitInWT('add', '-A');
            this.#gitInWT('commit', '-m', message);
            return true;
        }
        catch {
            return false;
        }
    }
    /** Discard all worktree changes and reset the branch to the current base */
    resetForRetry() {
        try {
            this.cleanWorktree();
            this.#gitInWT('reset', '--hard', this.#base);
        }
        catch (e) {
            /* v8 ignore next */
            logWorktreeWarning(`failed to reset ${this.#branch} to ${this.#base} for retry`, e);
        }
    }
    remove() {
        try {
            this.#git('worktree', 'remove', '--force', this.#path);
        }
        catch (e) {
            /* v8 ignore next */
            logWorktreeWarning(`failed to remove worktree ${this.#path}`, e);
        }
        try {
            this.#git('branch', '-D', this.#branch);
        }
        catch (e) {
            /* v8 ignore next */
            logWorktreeWarning(`failed to delete branch ${this.#branch}`, e);
        }
    }
    // ── Private ──────────────────────────────────────────────────────────
    #git(...args) {
        return execFileSync('git', args, { cwd: this.#repo, encoding: 'utf-8' });
    }
    #gitInWT(...args) {
        return execFileSync('git', args, { cwd: this.#path, encoding: 'utf-8' });
    }
    #hasUnmergedPaths(cwd) {
        try {
            return execFileSync('git', ['ls-files', '--unmerged'], { cwd, encoding: 'utf-8' }).trim().length > 0;
        }
        catch {
            return false;
        }
    }
    #gitConfig(key) {
        try {
            return execFileSync('git', ['config', key], { cwd: this.#repo, encoding: 'utf-8' }).trim();
        }
        catch {
            return '';
        }
    }
}
//# sourceMappingURL=Worktree.js.map