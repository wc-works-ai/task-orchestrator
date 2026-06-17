export interface StatePathInputs {
    readonly repo?: string | undefined;
    readonly stateRoot?: string | undefined;
    readonly tasks?: string | undefined;
    readonly worktrees?: string | undefined;
}
export interface StatePaths {
    readonly repo: string | undefined;
    readonly stateRoot: string;
    readonly repoSlug: string | undefined;
    readonly tasks: string;
    readonly worktrees: string;
}
export declare function repoSlug(repoPath: string): string;
export declare function defaultStateRoot(): string;
export declare function resolveStatePaths(inputs: StatePathInputs): StatePaths;
