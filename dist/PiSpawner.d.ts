import { TaskState } from './TaskState.js';
import type { SpawnResult } from './Engine.js';
export interface PiSpawnerOptions {
    /** Default model when task doesn't specify one */
    readonly model?: string;
    /** Fallback model if primary fails */
    readonly fallbackModel?: string;
    /** Working directory for the agent */
    readonly workDir?: string;
    /** Max ms with no output before killing the agent (default: 120_000 / 2 min) */
    readonly progressTimeout?: number;
    /** Interval (ms) for progress checks (default: 10_000). Only overridden in tests. */
    readonly progressCheckInterval?: number;
}
export declare class PiSpawner {
    #private;
    constructor(opts?: PiSpawnerOptions);
    /** Resolve the model for a task: metadata → constructor → env → default */
    modelFor(task: TaskState): string;
    spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult>;
}
