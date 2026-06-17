import type { TaskState } from '../state/TaskState.js';
export interface TokenUsage {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
}
export interface SpawnResult {
    readonly success: boolean;
    readonly iterations: number;
    readonly tokenUsage?: TokenUsage;
    readonly authFailure?: boolean;
    readonly error?: string;
    readonly logPath?: string;
}
export type SpawnFn = (task: TaskState, worktreePath?: string, signal?: AbortSignal) => Promise<SpawnResult>;
/** Result of one prerequisite/availability check (CLI present, auth configured, ...). */
export interface PrerequisiteResult {
    readonly name: string;
    readonly ok: boolean;
    readonly message: string;
}
/** Options accepted by every coding agent. Adapters may extend this with extras. */
export interface CodingAgentOptions {
    readonly model?: string;
    readonly reasoning?: string;
    readonly workDir?: string;
    readonly agentLogMaxBytes?: number;
    /** Write agent logs as raw child output instead of timestamped lines. */
    readonly agentLogRaw?: boolean;
}
export declare function positiveInt(value: unknown, fallback: number): number;
export declare function countOccurrences(haystack: string, needle: string): number;
export declare function tail(str: string, maxLen: number): string;
export declare function resolveModel(taskModel: string, optModel: string | undefined, envModel: string | undefined): string | undefined;
export declare function resolveReasoning(taskReasoning: string, optReasoning: string | undefined, envReasoning: string | undefined): string | undefined;
export interface CodingAgent {
    readonly name: string;
    /** Report this agent's prerequisites so the CLI can preflight the SELECTED agent. */
    checkPrerequisites(): PrerequisiteResult[];
    spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult>;
}
