import { TaskState } from '../state/TaskState.js';
import type { SpawnResult, PrerequisiteResult, CodingAgentOptions } from './CodingAgent.js';
import type { CodingAgent } from './CodingAgent.js';
export interface PiAgentOptions extends CodingAgentOptions {
    /** Optional fallback model if primary fails */
    readonly fallbackModel?: string;
    /** Max ms with no output before killing the agent (default: 120_000 / 2 min) */
    readonly progressTimeout?: number;
    /** Interval (ms) for progress checks (default: 10_000). Only overridden in tests. */
    readonly progressCheckInterval?: number;
    /** Min silent time (ms) before quiet running status lines (default: 30_000). Only overridden in tests. */
    readonly progressStatusInterval?: number;
    /** Write raw spawned-agent stdout/stderr to agent.log (default: false). */
    readonly agentLogRaw?: boolean;
}
export declare function killTree(pid: number): void;
export declare class PiAgent implements CodingAgent {
    #private;
    readonly name = "pi";
    constructor(opts?: PiAgentOptions);
    /** Resolve the model for a task: metadata → constructor → env → pi default */
    modelFor(task: TaskState): string | undefined;
    resolveModel(task: TaskState): string | undefined;
    resolveReasoning(task: TaskState): string | undefined;
    checkPrerequisites(): PrerequisiteResult[];
    spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult>;
}
