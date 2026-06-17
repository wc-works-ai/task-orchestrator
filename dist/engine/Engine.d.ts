import { TaskState, type BenchmarkFn, type TaskInfo, type TickResult, type TickNull } from '../state/TaskState.js';
import { TaskDb } from '../state/TaskDb.js';
import type { SpawnFn } from '../agent/CodingAgent.js';
export type { SpawnResult, SpawnFn, TokenUsage } from '../agent/CodingAgent.js';
type SleepFn = (ms: number) => Promise<void>;
/** Why loop() returned. 'signal' = --stop/.stop (intentional); 'environment' =
 *  fatal, run-wide failure (e.g. auth, repeated tick errors); 'complete' = all
 *  tasks reached a terminal state (non-infinite/keep-alive). */
export type StopReason = 'signal' | 'environment' | 'complete';
export declare const MergeRecoveryAction: {
    readonly Stop: "stop";
    readonly StashAndRetry: "stash-and-retry";
};
export type MergeRecoveryAction = (typeof MergeRecoveryAction)[keyof typeof MergeRecoveryAction];
export interface MergeRecoveryFailure {
    readonly task: TaskInfo;
    readonly worktreePath: string;
    readonly branch: string;
    readonly error: string;
}
export type MergeRecoveryFn = (failure: MergeRecoveryFailure) => Promise<MergeRecoveryAction> | MergeRecoveryAction;
export interface EngineOptions {
    readonly benchmark?: BenchmarkFn;
    readonly spawn?: SpawnFn;
    readonly mergeRecovery?: MergeRecoveryFn;
    readonly autoStashBeforeMerge?: boolean;
    readonly verifyCmd?: string;
    readonly instanceId?: string;
    readonly repoDir?: string;
    readonly worktreesDir?: string;
    readonly noWorktree?: boolean;
    readonly retryCooldownMs?: number;
    readonly keepAlive?: boolean;
    readonly infinite?: boolean;
    readonly idleSleepMs?: number;
    readonly parallel?: number;
    readonly sleep?: SleepFn;
    readonly onTick?: (result: TickResult | TickNull, total: number) => void | Promise<void>;
    readonly keepConverged?: number;
    /** Inject a shared state DB (tests). When provided, the Engine does not own
     *  it and will not close it; otherwise it opens `<tasksDir>/state.db`. */
    readonly taskDb?: TaskDb;
}
export declare class Engine {
    #private;
    constructor(tasksDir: string, opts?: EngineOptions);
    get instanceId(): string;
    get environmentError(): string | undefined;
    get stopReason(): StopReason | undefined;
    get baseBranch(): string;
    get taskDb(): TaskDb;
    /** Release the owned state DB handle (no-op when the DB was injected). */
    dispose(): void;
    pickByNumber(num: number): TaskState | null;
    tick(): Promise<TickResult | TickNull>;
    loop(opts?: EngineOptions): Promise<number>;
}
