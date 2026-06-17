import { type Db } from './sqlite.js';
export type TaskStatus = 'CREATING' | 'PENDING' | 'IN_PROGRESS' | 'FAILED' | 'BLOCKED' | 'CONVERGED';
/** Content directory name for a task, e.g. (1, "auth") → "T01-auth". */
export declare function taskDirName(taskNumber: number, name: string): string;
/** A full task row as stored in the database. */
export interface TaskRow {
    readonly id: number;
    readonly task_number: number;
    readonly name: string;
    readonly dir: string;
    readonly status: TaskStatus;
    readonly convergence: number;
    readonly failures: number;
    readonly priority: number;
    readonly max_failures: number | null;
    readonly target_branch: string | null;
    readonly repo: string | null;
    readonly claimed_by: string | null;
    readonly claim_token: string | null;
    readonly claimed_at: number | null;
    readonly heartbeat: number | null;
    readonly created_at: number;
    readonly updated_at: number;
}
/** Fields needed to create a task. `maxFailures` null means unlimited retries. */
export interface NewTask {
    readonly name: string;
    readonly maxFailures?: number | null;
    readonly targetBranch?: string | null;
    readonly repo?: string | null;
    readonly priority?: number;
    readonly dependsOn?: readonly number[];
}
/** Fields needed to import a pre-existing task verbatim (one-time shard
 *  migration). Unlike {@link NewTask}, nothing is derived: the caller supplies
 *  the original number, dir, status, and counters as-is. */
export interface ImportTask {
    readonly taskNumber: number;
    readonly name: string;
    readonly dir: string;
    readonly status: TaskStatus;
    readonly convergence: number;
    readonly failures: number;
    readonly maxFailures: number | null;
    readonly targetBranch: string | null;
    readonly repo: string | null;
    readonly dependsOn: readonly number[];
}
type LegacyImportTask = Omit<ImportTask, 'repo'> & {
    readonly repo?: string | null;
};
/** Current schema version — the number of migrations defined above. */
export declare const SCHEMA_VERSION: number;
export declare class TaskDb {
    #private;
    private constructor();
    /** Open (creating if needed) the state database at `path` and apply the schema. */
    static open(path: string): TaskDb;
    /** Apply the schema to an already-open Db (tests inject `:memory:` and a clock). */
    static init(db: Db, now?: () => number): TaskDb;
    get(id: number): TaskRow | undefined;
    getByNumber(taskNumber: number): TaskRow | undefined;
    dependencyNumbers(taskNumber: number): number[];
    /** Every task in any of `statuses`, ordered by task_number. Callers pass a
     *  non-empty list (scan, converged accounting, startup reconciliation). */
    byStatus(statuses: readonly TaskStatus[]): TaskRow[];
    /** Allocate the next task_number, derive its content dir, and insert as
     *  CREATING with its deps — all atomically. Returns the id, number, and dir. */
    insert(t: NewTask): {
        id: number;
        taskNumber: number;
        dir: string;
    };
    /** Import a pre-existing task verbatim (one-time shard migration): insert the
     *  row with the supplied number/dir/status/counters and its dependency rows,
     *  idempotently via ON CONFLICT(task_number) DO NOTHING. Returns whether a row
     *  was inserted (false when the number already existed). */
    importTask(t: ImportTask): boolean;
    importTask(t: LegacyImportTask): boolean;
    /** Publish a fully-written task: CREATING → PENDING. Returns false if not CREATING. */
    promote(id: number): boolean;
    /** Atomically claim the lowest-numbered actionable task whose deps have converged. */
    pick(instanceId: string): TaskRow | undefined;
    /** Set a task's priority (higher = picked sooner). Not claim-gated — any
     *  caller may re-prioritize. Returns false when no such task exists. */
    setPriority(taskNumber: number, priority: number): boolean;
    /** Set a terminal status and clear every lease field. Returns false if the claim is stale. */
    release(id: number, token: string, status: TaskStatus): boolean;
    incrementConvergence(id: number, token: string): boolean;
    resetConvergence(id: number, token: string): boolean;
    heartbeat(id: number, token: string): boolean;
    /** Bump the failure count, returning the new total, or null if the claim is stale. */
    incrementFailures(id: number, token: string): number | null;
    /** Fail + fully unclaim IN_PROGRESS tasks last seen before `cutoff`. Returns count. */
    recoverStale(cutoff: number): number;
    /** Block every PENDING/FAILED task that transitively depends on a BLOCKED task. */
    cascadeBlock(): number;
    /** Force a task to BLOCKED, clearing convergence and every lease field.
     *  Not claim-gated: terminal blocking of unclaimed tasks (exhausted retries,
     *  missing content dir). */
    block(id: number): boolean;
    /** Reset a task to PENDING, clearing failures, convergence, and every lease
     *  field. Not claim-gated: terminal tasks hold no claim. */
    unblock(id: number): boolean;
    /** Delete a task row outright (stale CREATING reconciliation). */
    remove(id: number): boolean;
    integrityOk(): boolean;
    /** Write a consistent snapshot to `toPath`, replacing any existing file. */
    backup(toPath: string): void;
    close(): void;
}
export {};
