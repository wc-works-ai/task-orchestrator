/**
 * Orchestrator errors are FATAL (stop the loop — the DB is unusable) or WARN
 * (skip one task, keep looping). Transient SQLite locks are retried in
 * `withRetry`; an exhausted lock becomes a FATAL `DbBusyError`.
 */
export const Severity = {
    FATAL: 'fatal',
    WARN: 'warn',
};
export class OrchestratorError extends Error {
    /** Task this error concerns, when task-scoped. */
    taskId;
    constructor(message, taskId) {
        super(message);
        this.name = this.constructor.name;
        if (taskId !== undefined)
            this.taskId = taskId;
    }
}
export class DbCorruptError extends OrchestratorError {
    severity = Severity.FATAL;
    action = 'Restore state.db.bak, or delete state.db to rebuild (loses progress)';
}
export class DbBusyError extends OrchestratorError {
    severity = Severity.FATAL;
    action = 'state.db stayed locked after retries; close other writers and restart';
}
export class DbInitError extends OrchestratorError {
    severity = Severity.FATAL;
    action = 'state.db could not initialize in WAL mode; ensure it is on a local disk';
}
export class SchemaMismatchError extends OrchestratorError {
    severity = Severity.FATAL;
    action = 'Update the orchestrator, or delete state.db to rebuild from task folders';
}
/**
 * Classify the error during a tick and decide whether to keep looping.
 * Unknown (non-orchestrator) errors are treated as task-level warnings so a
 * surprise bug skips one task rather than killing the whole run.
 */
export function handleOrchestratorError(err, log) {
    if (!(err instanceof OrchestratorError)) {
        log.warn(`Unexpected error: ${describeUnknown(err)}`);
        return 'continue';
    }
    if (err.severity === Severity.FATAL) {
        log.error(`FATAL: ${err.message} — ${err.action}`);
        return 'stop';
    }
    log.warn(`${err.message} — ${err.action}`);
    return 'continue';
}
/**
 * Run a synchronous DB operation, retrying transient SQLITE_BUSY/LOCKED with
 * exponential backoff. Corruption fails fast; everything else is rethrown as-is.
 */
export function withRetry(fn, opts = {}) {
    const tries = opts.tries ?? 5;
    const baseMs = opts.baseMs ?? 50;
    const sleep = opts.sleep ?? syncSleep;
    for (let attempt = 0;; attempt++) {
        try {
            return fn();
        }
        catch (e) {
            if (isCorrupt(e))
                throw new DbCorruptError('database is corrupt or not a database');
            if (isBusy(e)) {
                if (attempt < tries) {
                    sleep(baseMs * 2 ** attempt);
                    continue;
                }
                throw new DbBusyError('database is locked (retries exhausted)');
            }
            throw e;
        }
    }
}
function describeUnknown(e) {
    return e instanceof Error ? e.message : String(e);
}
function errcode(e) {
    const c = e?.errcode;
    return typeof c === 'number' ? c : undefined;
}
// SQLite result codes; low byte covers the extended variants.
function isBusy(e) {
    const c = errcode(e);
    if (c === undefined)
        return false;
    const low = c & 0xff;
    return low === 5 /* BUSY */ || low === 6 /* LOCKED */;
}
function isCorrupt(e) {
    const c = errcode(e);
    if (c === undefined)
        return false;
    const low = c & 0xff;
    return low === 11 /* CORRUPT */ || low === 26 /* NOTADB */;
}
// Block the thread for `ms` (node:sqlite is synchronous, so the backoff must be
// too). Atomics.wait on a throwaway buffer is the standard synchronous sleep.
function syncSleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
//# sourceMappingURL=errors.js.map