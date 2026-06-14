/**
 * Central error framework for the orchestrator.
 *
 * Two severities are enough:
 *   - FATAL: the database is unusable (corrupt / persistently locked). Stop the
 *     loop — continuing could worsen state. The operator must intervene.
 *   - WARN:  a single task hit a problem (stale claim, missing folder, …). Log
 *     it, skip that task, keep the loop alive. One bad task never stops the run.
 *
 * Repairs (recover-stale claims, reconcile half-created tasks) are *proactive*
 * operations run each tick by the Engine, not exceptions — so they are not a
 * severity. Transient lock backoff is handled inside `withRetry`; only an
 * exhausted lock escalates to a FATAL `DbBusyError`.
 */

export const Severity = {
  FATAL: 'fatal',
  WARN: 'warn',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export interface Logger {
  warn(msg: string): void;
  error(msg: string): void;
}

export abstract class OrchestratorError extends Error {
  abstract readonly severity: Severity;
  /** Human-readable next step for the operator. */
  abstract readonly action: string;
  /** Task this error concerns, when task-scoped. */
  readonly taskId?: number;

  constructor(message: string, taskId?: number) {
    super(message);
    this.name = this.constructor.name;
    if (taskId !== undefined) this.taskId = taskId;
  }
}

export class DbCorruptError extends OrchestratorError {
  readonly severity = Severity.FATAL;
  readonly action = 'Restore state.db.bak, or delete state.db to rebuild (loses progress)';
}

export class DbBusyError extends OrchestratorError {
  readonly severity = Severity.FATAL;
  readonly action = 'state.db stayed locked after retries; close other writers and restart';
}

/**
 * Classify the error during a tick and decide whether to keep looping.
 * Unknown (non-orchestrator) errors are treated as task-level warnings so a
 * surprise bug skips one task rather than killing the whole run.
 */
export function handleOrchestratorError(err: unknown, log: Logger): 'continue' | 'stop' {
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
export function withRetry<T>(fn: () => T, opts: RetryOptions = {}): T {
  const tries = opts.tries ?? 5;
  const baseMs = opts.baseMs ?? 50;
  const sleep = opts.sleep ?? syncSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (isCorrupt(e)) throw new DbCorruptError('database is corrupt or not a database');
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

function describeUnknown(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errcode(e: unknown): number | undefined {
  const c = (e as { errcode?: unknown } | null | undefined)?.errcode;
  return typeof c === 'number' ? c : undefined;
}

// SQLite result codes; low byte covers the extended variants.
function isBusy(e: unknown): boolean {
  const c = errcode(e);
  if (c === undefined) return false;
  const low = c & 0xff;
  return low === 5 /* BUSY */ || low === 6 /* LOCKED */;
}

function isCorrupt(e: unknown): boolean {
  const c = errcode(e);
  if (c === undefined) return false;
  const low = c & 0xff;
  return low === 11 /* CORRUPT */ || low === 26 /* NOTADB */;
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
