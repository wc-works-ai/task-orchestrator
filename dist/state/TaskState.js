import { readFileSync, rmSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { Status, inProgress, isInProgress, isActionable, CONVERGENCE_THRESHOLD, MAX_FAILURES, } from './Status.js';
import { TaskDb } from './TaskDb.js';
import { sha256 } from '../shared/BenchmarkMeta.js';
export { Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD, MAX_FAILURES };
/**
 * A DB-backed view of one task. State (status, convergence, failures, claim,
 * dependencies, target branch, retry limit) is read live from {@link TaskDb}
 * on every access — matching the old "always read fresh" semantics. Content
 * (goal, model, metrics, scope) is parsed from `autoresearch.md` in the task's
 * content directory. Gated mutators carry the claim token this process holds.
 */
export class TaskState {
    #tdb;
    #tasksRoot;
    #id;
    #taskNumber;
    #dir; // content dir name relative to the tasks root, e.g. "T01-auth"
    #token; // claim token held by this process ('' = unheld; gated writes no-op)
    constructor(tdb, tasksRoot, row) {
        this.#tdb = tdb;
        this.#tasksRoot = tasksRoot;
        this.#id = row.id;
        this.#taskNumber = row.task_number;
        this.#dir = row.dir;
        this.#token = row.claim_token ?? '';
    }
    /** Build a view from a DB row, capturing any claim token the row carries. */
    static fromRow(tdb, tasksRoot, row) {
        return new TaskState(tdb, resolve(tasksRoot), row);
    }
    #row() {
        return this.#tdb.get(this.#id);
    }
    // ── Identity ────────────────────────────────────────────────────────
    get directory() {
        return resolve(this.#tasksRoot, this.#dir);
    }
    get taskNumber() {
        return this.#taskNumber;
    }
    get number() {
        return this.#taskNumber;
    }
    get taskName() {
        return basename(this.#dir);
    }
    get name() {
        return this.taskName;
    }
    /** Default cwd — overridden by Engine with the actual worktree/repo root. */
    get cwd() {
        return this.directory;
    }
    get info() {
        // Return a materialized plain object (not `this`): callers such as Engine
        // spread it (`{ ...task.info, cwd }`) to run benchmarks in a worktree, and
        // spreading the instance would drop getter-based fields.
        return {
            directory: this.directory,
            number: this.number,
            name: this.name,
            ...(this.repo ? { repo: this.repo } : {}),
            goal: this.goal,
            model: this.model,
            reasoning: this.reasoning,
            status: this.status,
            cwd: this.cwd,
            metrics: this.metricNames,
        };
    }
    // ── Status ──────────────────────────────────────────────────────────
    get status() {
        const row = this.#row();
        if (!row)
            return Status.PENDING;
        if (row.status === 'IN_PROGRESS')
            return inProgress(row.claimed_by ?? '');
        // CREATING is a transient publish state; surface it as PENDING so a view
        // built from one is treated as not-yet-started rather than unrecognized.
        if (row.status === 'CREATING')
            return Status.PENDING;
        return row.status;
    }
    get isPending() { return this.status === Status.PENDING; }
    get isConverged() { return this.status === Status.CONVERGED; }
    get isFailed() { return this.status === Status.FAILED; }
    get isBlocked() { return this.status === Status.BLOCKED; }
    get isInProgress() { return isInProgress(this.status); }
    get isActionable() { return isActionable(this.status); }
    // ── Convergence ─────────────────────────────────────────────────────
    get convergenceCount() {
        return this.#row()?.convergence ?? 0;
    }
    get hasConverged() {
        return this.convergenceCount >= CONVERGENCE_THRESHOLD;
    }
    incrementConvergence() {
        this.#tdb.incrementConvergence(this.#id, this.#token);
    }
    resetConvergence() {
        this.#tdb.resetConvergence(this.#id, this.#token);
    }
    // ── Failures ────────────────────────────────────────────────────────
    get failureCount() {
        return this.#row()?.failures ?? 0;
    }
    /** Bump the failure count, returning the new total (0 if the claim is stale). */
    incrementFailures() {
        return this.#tdb.incrementFailures(this.#id, this.#token) ?? 0;
    }
    get maxFailures() {
        const m = this.#row()?.max_failures;
        return m ?? Infinity;
    }
    /** Scheduling priority; higher is picked sooner (default 0). */
    get priority() {
        return this.#row()?.priority ?? 0;
    }
    // ── Claim ───────────────────────────────────────────────────────────
    get isClaimed() {
        return this.#row()?.claimed_by != null;
    }
    get claimOwnerId() {
        return this.#row()?.claimed_by ?? '';
    }
    heartbeat() {
        this.#tdb.heartbeat(this.#id, this.#token);
    }
    release(newStatus = Status.PENDING) {
        this.#tdb.release(this.#id, this.#token, newStatus);
    }
    /** Terminally block this task (clears convergence and the claim). Works on
     *  unclaimed tasks — used for exhausted retries and blocked dependencies. */
    markBlocked() {
        this.#tdb.block(this.#id);
    }
    /** Reset a blocked/failed task back to PENDING: clear failures, convergence,
     *  and the claim so the loop retries it from scratch. Safe while the loop is
     *  active — blocked/failed tasks are not being processed. */
    unblock() {
        this.#tdb.unblock(this.#id);
    }
    // ── Dependencies ────────────────────────────────────────────────────
    get dependencies() {
        return this.#tdb.dependencyNumbers(this.#taskNumber);
    }
    dependenciesMet() {
        for (const d of this.dependencies) {
            // Missing dep counts as unmet (its row is gone or never converged).
            if (this.#tdb.getByNumber(d)?.status !== 'CONVERGED')
                return false;
        }
        return true;
    }
    // ── Content (parsed from autoresearch.md) ───────────────────────────
    #readAutoresearch() {
        try {
            return readFileSync(join(this.directory, 'autoresearch.md'), 'utf-8');
        }
        catch {
            return '';
        }
    }
    get scope() {
        const c = this.#readAutoresearch();
        if (!c)
            return [];
        const m = c.match(/^## Scope([\s\S]*?)(?=## |$)/s);
        const raw = m?.[1]?.trim() ?? '';
        return raw ? raw.split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean) : [];
    }
    /** Git branch this task targets for worktree creation and merge. Set at task
     *  creation; undefined means Engine uses its own baseBranch. */
    get targetBranch() {
        return this.#row()?.target_branch ?? undefined;
    }
    get repo() {
        return this.#row()?.repo ?? undefined;
    }
    get goal() {
        const c = this.#readAutoresearch();
        if (!c)
            return this.taskName;
        return (c.match(/^## Goal:?\s*(.+)/m)
            || c.match(/^## Goal\s*\n(.+)/m)
            || [])[1]?.trim() ?? this.taskName;
    }
    get model() {
        return this.#readAutoresearch().match(/\*\*Model:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
    }
    get reasoning() {
        return this.#readAutoresearch().match(/\*\*Reasoning:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
    }
    /** Body of the `## Acceptance criteria` section — the durable benchmark
     *  contract. Empty when the section is absent. */
    #acceptanceSection() {
        return this.#readAutoresearch().match(/^## Acceptance criteria\b([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() ?? '';
    }
    /** Declared metric name(s) from the `## Acceptance criteria` section (the
     *  backtick-quoted identifiers). Used to count only the task's own metric and
     *  ignore foreign metric-shaped lines leaked from benchmark output. Empty when
     *  none is declared (caller then counts all metrics). */
    get metricNames() {
        const names = [...this.#acceptanceSection().matchAll(/`([A-Za-z_]\w*)`/g)].map(m => m[1]);
        return [...new Set(names)];
    }
    /** Fingerprint of the acceptance criteria — changes whenever the durable
     *  benchmark contract changes, which triggers benchmark regeneration. */
    get acceptanceFingerprint() {
        return sha256(this.#acceptanceSection());
    }
    // ── Static (DB-backed) ──────────────────────────────────────────────
    /** All non-converged tasks (PENDING/IN_PROGRESS/FAILED/BLOCKED), keyed by
     *  task number. Converged tasks are terminal and counted via countConverged(). */
    static scan(tdb, tasksRoot) {
        const all = new Map();
        for (const row of tdb.byStatus(['PENDING', 'IN_PROGRESS', 'FAILED', 'BLOCKED'])) {
            all.set(String(row.task_number), TaskState.fromRow(tdb, tasksRoot, row));
        }
        return all;
    }
    /** Atomically claim the next actionable task, or null if none is ready. */
    static pick(tdb, tasksRoot, instanceId) {
        const row = tdb.pick(instanceId);
        return row ? TaskState.fromRow(tdb, tasksRoot, row) : null;
    }
    /** Look up a task by its number without claiming it (read-only view). */
    static pickByNumber(tdb, tasksRoot, taskNumber) {
        const row = tdb.getByNumber(taskNumber);
        return row ? TaskState.fromRow(tdb, tasksRoot, row) : null;
    }
    /** Total converged tasks. */
    static countConverged(tdb) {
        return tdb.byStatus(['CONVERGED']).length;
    }
    /** Delete content dirs of the oldest converged tasks beyond `keep` (best
     *  effort), preserving the DB rows so the converged count is unaffected.
     *  keep=0 means unlimited (no pruning). */
    static pruneConverged(tdb, tasksRoot, keep) {
        if (keep === 0)
            return;
        const root = resolve(tasksRoot);
        const converged = tdb.byStatus(['CONVERGED']); // ordered by task_number asc
        const toPrune = converged.slice(0, Math.max(0, converged.length - keep));
        for (const row of toPrune) {
            rmSync(resolve(root, row.dir), { recursive: true, force: true });
        }
    }
    /** Block every task that transitively depends on a BLOCKED task. */
    static cascadeBlockDependencies(tdb) {
        tdb.cascadeBlock();
    }
}
//# sourceMappingURL=TaskState.js.map