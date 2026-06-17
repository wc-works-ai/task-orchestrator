import { Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD, MAX_FAILURES } from './Status.js';
import { TaskDb, type TaskRow } from './TaskDb.js';
import type { BenchmarkOutcome } from '../shared/metrics.js';
export { Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD, MAX_FAILURES };
export interface TaskInfo {
    readonly directory: string;
    readonly number: number;
    readonly name: string;
    readonly repo?: string;
    readonly goal: string;
    readonly model: string;
    readonly reasoning: string;
    readonly status: string;
    /** Working directory for benchmarks (worktree root or repo root) */
    readonly cwd: string;
    /** Declared metric name(s) from autoresearch.md `## Acceptance criteria`; empty = count all */
    readonly metrics: readonly string[];
}
/** A benchmark may return a bare metric total (shorthand for a clean `ok` run)
 *  or a full {@link BenchmarkOutcome} so the Engine can distinguish a crashed or
 *  no-op benchmark from genuine "work remaining". `#run` normalizes the number. */
export type BenchmarkFn = (task: TaskInfo) => Promise<number | BenchmarkOutcome> | number | BenchmarkOutcome;
export interface TickResult {
    readonly task: TaskInfo;
    readonly metric: number;
    readonly converged: boolean;
    readonly stopped?: false;
    readonly environmentError?: string;
}
export interface TickNull {
    readonly task: null;
    readonly metric: 0;
    readonly converged: false;
    readonly stopped?: boolean;
    readonly environmentError?: string;
}
/**
 * A DB-backed view of one task. State (status, convergence, failures, claim,
 * dependencies, target branch, retry limit) is read live from {@link TaskDb}
 * on every access — matching the old "always read fresh" semantics. Content
 * (goal, model, metrics, scope) is parsed from `autoresearch.md` in the task's
 * content directory. Gated mutators carry the claim token this process holds.
 */
export declare class TaskState {
    #private;
    private constructor();
    /** Build a view from a DB row, capturing any claim token the row carries. */
    static fromRow(tdb: TaskDb, tasksRoot: string, row: TaskRow): TaskState;
    get directory(): string;
    get taskNumber(): number;
    get number(): number;
    get taskName(): string;
    get name(): string;
    /** Default cwd — overridden by Engine with the actual worktree/repo root. */
    get cwd(): string;
    get info(): TaskInfo;
    get status(): string;
    get isPending(): boolean;
    get isConverged(): boolean;
    get isFailed(): boolean;
    get isBlocked(): boolean;
    get isInProgress(): boolean;
    get isActionable(): boolean;
    get convergenceCount(): number;
    get hasConverged(): boolean;
    incrementConvergence(): void;
    resetConvergence(): void;
    get failureCount(): number;
    /** Bump the failure count, returning the new total (0 if the claim is stale). */
    incrementFailures(): number;
    get maxFailures(): number;
    /** Scheduling priority; higher is picked sooner (default 0). */
    get priority(): number;
    get isClaimed(): boolean;
    get claimOwnerId(): string;
    heartbeat(): void;
    release(newStatus?: Status): void;
    /** Terminally block this task (clears convergence and the claim). Works on
     *  unclaimed tasks — used for exhausted retries and blocked dependencies. */
    markBlocked(): void;
    /** Reset a blocked/failed task back to PENDING: clear failures, convergence,
     *  and the claim so the loop retries it from scratch. Safe while the loop is
     *  active — blocked/failed tasks are not being processed. */
    unblock(): void;
    get dependencies(): readonly number[];
    dependenciesMet(): boolean;
    get scope(): string[];
    /** Git branch this task targets for worktree creation and merge. Set at task
     *  creation; undefined means Engine uses its own baseBranch. */
    get targetBranch(): string | undefined;
    get repo(): string | undefined;
    get goal(): string;
    get model(): string;
    get reasoning(): string;
    /** Declared metric name(s) from the `## Acceptance criteria` section (the
     *  backtick-quoted identifiers). Used to count only the task's own metric and
     *  ignore foreign metric-shaped lines leaked from benchmark output. Empty when
     *  none is declared (caller then counts all metrics). */
    get metricNames(): readonly string[];
    /** Fingerprint of the acceptance criteria — changes whenever the durable
     *  benchmark contract changes, which triggers benchmark regeneration. */
    get acceptanceFingerprint(): string;
    /** All non-converged tasks (PENDING/IN_PROGRESS/FAILED/BLOCKED), keyed by
     *  task number. Converged tasks are terminal and counted via countConverged(). */
    static scan(tdb: TaskDb, tasksRoot: string): Map<string, TaskState>;
    /** Atomically claim the next actionable task, or null if none is ready. */
    static pick(tdb: TaskDb, tasksRoot: string, instanceId: string): TaskState | null;
    /** Look up a task by its number without claiming it (read-only view). */
    static pickByNumber(tdb: TaskDb, tasksRoot: string, taskNumber: number): TaskState | null;
    /** Total converged tasks. */
    static countConverged(tdb: TaskDb): number;
    /** Delete content dirs of the oldest converged tasks beyond `keep` (best
     *  effort), preserving the DB rows so the converged count is unaffected.
     *  keep=0 means unlimited (no pruning). */
    static pruneConverged(tdb: TaskDb, tasksRoot: string, keep: number): void;
    /** Block every task that transitively depends on a BLOCKED task. */
    static cascadeBlockDependencies(tdb: TaskDb): void;
}
