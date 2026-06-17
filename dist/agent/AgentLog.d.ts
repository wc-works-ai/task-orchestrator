/**
 * Filesystem-safe log file name for a single agent run, e.g.
 * `agent-20260612-183318-007.log`. Each spawn/retry gets its own file so
 * earlier runs are preserved instead of overwritten. Local time, no colons
 * (Windows-safe).
 */
export declare function runLogName(now?: Date): string;
export interface AgentLog {
    readonly path: string;
    readonly maxBytes: number;
    bytes: number;
}
export declare function openAgentLog(path: string, maxBytes: number): AgentLog;
export declare function appendAgentLog(log: AgentLog, text: string): void;
