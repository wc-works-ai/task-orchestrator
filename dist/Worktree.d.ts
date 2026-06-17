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
    get exists(): boolean;
    create(): Promise<string>;
    merge(taskScope?: string[]): Promise<void>;
    /** Discard all worktree changes — agent starts fresh on retry */
    resetForRetry(): Promise<void>;
    remove(): Promise<void>;
}
