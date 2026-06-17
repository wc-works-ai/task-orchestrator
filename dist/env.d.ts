/** Centralized env var config: CLI flag > env var > default (lazy — reads process.env on access) */
export declare const env: {
    readonly tasksDir: string;
    readonly repoDir: string;
    readonly model: string;
    readonly converge: number;
    readonly maxFailures: number;
    readonly worktreesDir: string;
    readonly heartbeatMs: number;
    readonly progressTimeoutMs: number;
};
