/** Thrown when merging the task branch into the base branch hits a conflict. */
export declare class MergeConflictError extends Error {
}
export interface WorktreeOptions {
    readonly name: string;
    readonly baseBranch?: string;
    readonly worktreesDir?: string;
}
export declare class Worktree {
    #private;
    constructor(repoDir: string, opts: WorktreeOptions);
    get path(): string;
    get branch(): string;
    /** Current commit SHA of the base branch — used to detect base advancement
     *  between benchmark generation and a later agent-work cycle. */
    baseSha(): string;
    get exists(): boolean;
    create(): string;
    /**
     * Bring the latest base branch into the task branch, inside the worktree,
     * before merging back. This resolves the common case where the base advanced
     * (e.g. a sibling task merged) while the agent worked, so only genuinely
     * overlapping edits still conflict. A real conflict is aborted and surfaced
     * as a MergeConflictError, handled like any other merge conflict.
     */
    syncWithBase(): void;
    merge(): void;
    stashParentChanges(message: string): boolean;
    /** Discard all uncommitted worktree changes so the agent starts clean. */
    cleanWorktree(): void;
    /** Commit any uncommitted changes in the worktree so merge captures
     *  everything the benchmark validates. Returns true if a commit was made. */
    autoCommit(message: string): boolean;
    /** Discard all worktree changes and reset the branch to the current base */
    resetForRetry(): void;
    remove(): void;
}
