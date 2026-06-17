import { Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD, MAX_FAILURES } from './Status.js';
export { Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD, MAX_FAILURES };
export interface TaskInfo {
    readonly directory: string;
    readonly number: number;
    readonly name: string;
    readonly goal: string;
    readonly model: string;
    readonly status: string;
    /** Working directory for benchmarks (worktree root or repo root) */
    readonly cwd: string;
}
export type BenchmarkFn = (task: TaskInfo) => Promise<number> | number;
export interface TickResult {
    readonly task: TaskInfo;
    readonly metric: number;
    readonly converged: boolean;
}
export interface TickNull {
    readonly task: null;
    readonly metric: 0;
    readonly converged: false;
}
interface ClaimOwner {
    readonly pid: number;
    readonly startedAt: number;
    readonly instanceId: string;
}
export declare class TaskState {
    #private;
    constructor(dir: string);
    get directory(): string;
    get taskNumber(): number;
    get taskName(): string;
    get info(): TaskInfo;
    /** Default cwd — overridden by Engine with actual worktree/repo root */
    get cwd(): string;
    get number(): number;
    get name(): string;
    get status(): Status;
    set status(v: Status | string);
    get isPending(): boolean;
    get isConverged(): boolean;
    get isFailed(): boolean;
    get isBlocked(): boolean;
    get isInProgress(): boolean;
    get isActionable(): boolean;
    get convergenceCount(): number;
    incrementConvergence(): number;
    resetConvergence(): void;
    get hasConverged(): boolean;
    get failureCount(): number;
    incrementFailures(): number;
    get dependencies(): readonly number[];
    set dependencies(nums: readonly number[]);
    dependenciesMet(tasksDir: string): boolean;
    claim(instanceId: string): boolean;
    get isClaimed(): boolean;
    get claimOwner(): ClaimOwner | null;
    get claimOwnerId(): string;
    heartbeat(): void;
    release(newStatus?: Status): void;
    markBlocked(): void;
    get scope(): string[];
    get goal(): string;
    get model(): string;
    /** Scan all shards and return a Map of task number → TaskState */
    static scan(tasksDir: string): Promise<Map<string, TaskState>>;
    /** Pick the highest-priority actionable task. Returns null if none. */
    static pick(tasksDir: string, instanceId: string): Promise<TaskState | null>;
    static get statusCache(): ReadonlyMap<string, Status>;
}
