export interface AddTaskOptions {
    readonly goal?: string;
    readonly metric?: string;
    readonly scope?: readonly string[];
    /** Git branch this task targets for worktree creation and merge. Defaults to current HEAD. */
    readonly targetBranch?: string;
    /** Repository directory for detecting the current branch. */
    readonly repoDir?: string;
    /** Scheduling priority; higher runs sooner (default 0). */
    readonly priority?: number;
}
export declare function addTask(tasksDir: string, name: string, opts?: AddTaskOptions): {
    number: number;
    name: string;
    directory: string;
    goal: string;
    metric: string;
    scope: readonly string[];
    repo: string | null;
    targetBranch: string | undefined;
};
