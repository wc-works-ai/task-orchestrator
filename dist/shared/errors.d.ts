/**
 * Orchestrator errors are FATAL (stop the loop — the DB is unusable) or WARN
 * (skip one task, keep looping). Transient SQLite locks are retried in
 * `withRetry`; an exhausted lock becomes a FATAL `DbBusyError`.
 */
export declare const Severity: {
    readonly FATAL: "fatal";
    readonly WARN: "warn";
};
export type Severity = (typeof Severity)[keyof typeof Severity];
export interface Logger {
    warn(msg: string): void;
    error(msg: string): void;
}
export declare abstract class OrchestratorError extends Error {
    abstract readonly severity: Severity;
    /** Human-readable next step for the operator. */
    abstract readonly action: string;
    /** Task this error concerns, when task-scoped. */
    readonly taskId?: number;
    constructor(message: string, taskId?: number);
}
export declare class DbCorruptError extends OrchestratorError {
    readonly severity: "fatal";
    readonly action = "Restore state.db.bak, or delete state.db to rebuild (loses progress)";
}
export declare class DbBusyError extends OrchestratorError {
    readonly severity: "fatal";
    readonly action = "state.db stayed locked after retries; close other writers and restart";
}
export declare class DbInitError extends OrchestratorError {
    readonly severity: "fatal";
    readonly action = "state.db could not initialize in WAL mode; ensure it is on a local disk";
}
export declare class SchemaMismatchError extends OrchestratorError {
    readonly severity: "fatal";
    readonly action = "Update the orchestrator, or delete state.db to rebuild from task folders";
}
/**
 * Classify the error during a tick and decide whether to keep looping.
 * Unknown (non-orchestrator) errors are treated as task-level warnings so a
 * surprise bug skips one task rather than killing the whole run.
 */
export declare function handleOrchestratorError(err: unknown, log: Logger): 'continue' | 'stop';
export interface RetryOptions {
    /** Max attempts before a transient lock becomes a FATAL DbBusyError. */
    readonly tries?: number;
    /** Base backoff in ms; doubles each attempt. */
    readonly baseMs?: number;
    /** Injectable sleep (tests pass a no-op). */
    readonly sleep?: (ms: number) => void;
}
/**
 * Run a synchronous DB operation, retrying transient SQLITE_BUSY/LOCKED with
 * exponential backoff. Corruption fails fast; everything else is rethrown as-is.
 */
export declare function withRetry<T>(fn: () => T, opts?: RetryOptions): T;
