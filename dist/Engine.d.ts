import { TaskState, type BenchmarkFn, type TickResult, type TickNull } from './TaskState.js';
export interface SpawnResult {
    readonly success: boolean;
    readonly iterations: number;
}
export type SpawnFn = (task: TaskState, worktreePath?: string, signal?: AbortSignal) => Promise<SpawnResult>;
export interface EngineOptions {
    readonly benchmark?: BenchmarkFn;
    readonly spawn?: SpawnFn;
    readonly instanceId?: string;
    readonly repoDir?: string;
    readonly worktreesDir?: string;
    readonly retryCooldownMs?: number;
    readonly onTick?: (result: TickResult | TickNull, total: number) => void | Promise<void>;
}
export declare class Engine {
    #private;
    constructor(tasksDir: string, opts?: EngineOptions);
    get instanceId(): string;
    pickByNumber(num: number): Promise<TaskState | null>;
    tick(): Promise<TickResult | TickNull>;
    loop(opts?: EngineOptions): Promise<number>;
}
