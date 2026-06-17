/**
 * SQLite-backed task state. Owns the schema (tasks + dependencies), lifecycle
 * (open/init, integrity check, backup), creation, atomic claiming, claim-gated
 * updates, stale-claim recovery, and the dependency cascade. State lives here;
 * the filesystem holds only task content.
 */
import { existsSync, rmSync } from 'node:fs';
import { openDb } from './sqlite.js';
import { SchemaMismatchError, withRetry } from '../shared/errors.js';
// Guard the recursive dependency walk against a malformed graph.
const MAX_DEPENDENCY_DEPTH = 10000;
/** Content directory name for a task, e.g. (1, "auth") → "T01-auth". */
export function taskDirName(taskNumber, name) {
    return `T${String(taskNumber).padStart(2, '0')}-${name}`;
}
/**
 * Ordered schema migrations. Entry `N` upgrades the database from schema version
 * `N` to `N+1`: a fresh database replays them all, an existing one replays only
 * the steps after its stored `user_version`. This list is the single source of
 * truth for the schema — read top-to-bottom it *is* the current shape — so fresh
 * and upgraded databases cannot drift apart. To evolve the schema, append one
 * step; `SCHEMA_VERSION` follows automatically.
 */
const MIGRATIONS = [
    // 0 → 1: initial schema (tasks + dependencies).
    `
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  task_number   INTEGER NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  dir           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status        TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('CREATING','PENDING','IN_PROGRESS','FAILED','BLOCKED','CONVERGED')),
  convergence   INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  max_failures  INTEGER CHECK(max_failures IS NULL OR max_failures > 0),
  target_branch TEXT,
  claimed_by    TEXT,
  claim_token   TEXT,
  claimed_at    INTEGER,
  heartbeat     INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);

CREATE TABLE IF NOT EXISTS dependencies (
  task_number INTEGER NOT NULL,
  depends_on  INTEGER NOT NULL,
  PRIMARY KEY (task_number, depends_on),
  CHECK(task_number != depends_on)
);
CREATE INDEX IF NOT EXISTS idx_dep_on ON dependencies(depends_on);
`,
    // 1 → 2: bind each task to a repository.
    `ALTER TABLE tasks ADD COLUMN repo TEXT;`,
    // 2 → 3: scheduling priority (higher is picked first).
    `ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;`,
];
/** Current schema version — the number of migrations defined above. */
export const SCHEMA_VERSION = MIGRATIONS.length;
export class TaskDb {
    #db;
    #now;
    constructor(db, now) {
        this.#db = db;
        this.#now = now;
    }
    /** Open (creating if needed) the state database at `path` and apply the schema. */
    static open(path) {
        const db = openDb(path);
        try {
            return TaskDb.init(db);
        }
        catch (e) {
            // Don't leak the handle (on Windows a leaked handle also locks the file).
            db.close();
            throw e;
        }
    }
    /** Apply the schema to an already-open Db (tests inject `:memory:` and a clock). */
    static init(db, now = Date.now) {
        const tdb = new TaskDb(db, now);
        tdb.#applySchema();
        return tdb;
    }
    // ── Reads ───────────────────────────────────────────────────────────
    get(id) {
        return withRetry(() => this.#db.get('SELECT * FROM tasks WHERE id=?', [id]));
    }
    getByNumber(taskNumber) {
        return withRetry(() => this.#db.get('SELECT * FROM tasks WHERE task_number=?', [taskNumber]));
    }
    dependencyNumbers(taskNumber) {
        return withRetry(() => this.#db.all('SELECT depends_on FROM dependencies WHERE task_number=? ORDER BY depends_on', [taskNumber])).map(r => r.depends_on);
    }
    /** Every task in any of `statuses`, ordered by task_number. Callers pass a
     *  non-empty list (scan, converged accounting, startup reconciliation). */
    byStatus(statuses) {
        const placeholders = statuses.map(() => '?').join(',');
        return withRetry(() => this.#db.all(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY task_number`, [
            ...statuses,
        ]));
    }
    // ── Creation ────────────────────────────────────────────────────────
    /** Allocate the next task_number, derive its content dir, and insert as
     *  CREATING with its deps — all atomically. Returns the id, number, and dir. */
    insert(t) {
        return withRetry(() => this.#db.transaction(() => {
            const now = this.#now();
            const taskNumber = this.#db.get('SELECT COALESCE(MAX(task_number),0)+1 AS n FROM tasks').n;
            const dir = taskDirName(taskNumber, t.name);
            const repo = t.repo ?? null;
            const row = this.#db.get(`INSERT INTO tasks (task_number, name, dir, status, max_failures, target_branch, repo, priority, created_at, updated_at)
           VALUES (:num, :name, :dir, 'CREATING', :max, :branch, :repo, :priority, :now, :now)
           RETURNING id`, { num: taskNumber, name: t.name, dir, max: t.maxFailures ?? null, branch: t.targetBranch ?? null, repo, priority: t.priority ?? 0, now });
            for (const dep of t.dependsOn ?? []) {
                this.#assertSameRepoDependency(taskNumber, repo, dep);
                this.#db.run('INSERT INTO dependencies (task_number, depends_on) VALUES (?,?)', [taskNumber, dep]);
            }
            return { id: row.id, taskNumber, dir };
        }));
    }
    importTask(t) {
        return withRetry(() => this.#db.transaction(() => {
            const now = this.#now();
            const repo = t.repo ?? null;
            const r = this.#db.run(`INSERT INTO tasks
             (task_number, name, dir, status, convergence, failures, max_failures, target_branch, repo, created_at, updated_at)
           VALUES (:num, :name, :dir, :status, :conv, :fail, :max, :branch, :repo, :now, :now)
           ON CONFLICT(task_number) DO NOTHING`, {
                num: t.taskNumber, name: t.name, dir: t.dir, status: t.status, conv: t.convergence,
                fail: t.failures, max: t.maxFailures, branch: t.targetBranch, repo, now,
            });
            if (r.changes === 0)
                return false;
            for (const dep of t.dependsOn) {
                this.#db.run('INSERT INTO dependencies (task_number, depends_on) VALUES (?,?)', [t.taskNumber, dep]);
            }
            return true;
        }));
    }
    /** Publish a fully-written task: CREATING → PENDING. Returns false if not CREATING. */
    promote(id) {
        const r = withRetry(() => this.#db.run("UPDATE tasks SET status='PENDING', updated_at=:now WHERE id=:id AND status='CREATING'", {
            id,
            now: this.#now(),
        }));
        return r.changes > 0;
    }
    // ── Claiming ────────────────────────────────────────────────────────
    /** Atomically claim the lowest-numbered actionable task whose deps have converged. */
    pick(instanceId) {
        const now = this.#now();
        return withRetry(() => this.#db.get(`UPDATE tasks
         SET status='IN_PROGRESS', claimed_by=:inst, claim_token=hex(randomblob(8)),
             claimed_at=:now, heartbeat=:now, updated_at=:now
         WHERE id = (
           SELECT id FROM tasks WHERE status IN ('PENDING','FAILED')
             AND (max_failures IS NULL OR failures < max_failures)
             AND NOT EXISTS (
               SELECT 1 FROM dependencies d
               LEFT JOIN tasks dep ON dep.task_number = d.depends_on
               WHERE d.task_number = tasks.task_number
                 AND (dep.task_number IS NULL OR dep.status != 'CONVERGED'))
           ORDER BY priority DESC, task_number ASC LIMIT 1)
         RETURNING *`, { inst: instanceId, now }));
    }
    /** Set a task's priority (higher = picked sooner). Not claim-gated — any
     *  caller may re-prioritize. Returns false when no such task exists. */
    setPriority(taskNumber, priority) {
        const r = withRetry(() => this.#db.run('UPDATE tasks SET priority=:p, updated_at=:now WHERE task_number=:tn', {
            p: priority, now: this.#now(), tn: taskNumber,
        }));
        return r.changes > 0;
    }
    // ── Claim-gated writes (only the current owner may apply them) ───────
    /** Set a terminal status and clear every lease field. Returns false if the claim is stale. */
    release(id, token, status) {
        const r = withRetry(() => this.#db.run(`UPDATE tasks SET status=:s, claimed_by=NULL, claim_token=NULL, claimed_at=NULL,
                heartbeat=NULL, updated_at=:now
         WHERE id=:id AND claim_token=:tok`, { s: status, now: this.#now(), id, tok: token }));
        return r.changes > 0;
    }
    incrementConvergence(id, token) {
        return this.#gatedRun('UPDATE tasks SET convergence=convergence+1, updated_at=:now WHERE id=:id AND claim_token=:tok', id, token);
    }
    resetConvergence(id, token) {
        return this.#gatedRun('UPDATE tasks SET convergence=0, updated_at=:now WHERE id=:id AND claim_token=:tok', id, token);
    }
    heartbeat(id, token) {
        return this.#gatedRun('UPDATE tasks SET heartbeat=:now WHERE id=:id AND claim_token=:tok', id, token);
    }
    /** Bump the failure count, returning the new total, or null if the claim is stale. */
    incrementFailures(id, token) {
        const row = withRetry(() => this.#db.get('UPDATE tasks SET failures=failures+1, updated_at=:now WHERE id=:id AND claim_token=:tok RETURNING failures', { now: this.#now(), id, tok: token }));
        return row ? row.failures : null;
    }
    // ── Orchestrator-level (not claim-gated) ────────────────────────────
    /** Fail + fully unclaim IN_PROGRESS tasks last seen before `cutoff`. Returns count. */
    recoverStale(cutoff) {
        const r = withRetry(() => this.#db.run(`UPDATE tasks SET status='FAILED', claimed_by=NULL, claim_token=NULL, claimed_at=NULL,
                heartbeat=NULL, failures=failures+1, updated_at=:now
         WHERE status='IN_PROGRESS' AND COALESCE(heartbeat, claimed_at, 0) < :cutoff`, { now: this.#now(), cutoff }));
        return r.changes;
    }
    /** Block every PENDING/FAILED task that transitively depends on a BLOCKED task. */
    cascadeBlock() {
        const r = withRetry(() => this.#db.run(`WITH RECURSIVE blocked_chain(tn, depth) AS (
           SELECT d.task_number, 1 FROM dependencies d
           JOIN tasks dep ON dep.task_number = d.depends_on
           WHERE dep.status = 'BLOCKED'
           UNION
           SELECT d.task_number, bc.depth+1 FROM dependencies d
           JOIN blocked_chain bc ON d.depends_on = bc.tn
           WHERE bc.depth < ${MAX_DEPENDENCY_DEPTH}
         )
         UPDATE tasks SET status='BLOCKED', updated_at=:now
         WHERE task_number IN (SELECT tn FROM blocked_chain)
           AND status IN ('PENDING','FAILED')`, { now: this.#now() }));
        return r.changes;
    }
    /** Force a task to BLOCKED, clearing convergence and every lease field.
     *  Not claim-gated: terminal blocking of unclaimed tasks (exhausted retries,
     *  missing content dir). */
    block(id) {
        const r = withRetry(() => this.#db.run(`UPDATE tasks SET status='BLOCKED', convergence=0, claimed_by=NULL, claim_token=NULL,
                claimed_at=NULL, heartbeat=NULL, updated_at=:now
         WHERE id=:id`, { now: this.#now(), id }));
        return r.changes > 0;
    }
    /** Reset a task to PENDING, clearing failures, convergence, and every lease
     *  field. Not claim-gated: terminal tasks hold no claim. */
    unblock(id) {
        const r = withRetry(() => this.#db.run(`UPDATE tasks SET status='PENDING', failures=0, convergence=0, claimed_by=NULL,
                claim_token=NULL, claimed_at=NULL, heartbeat=NULL, updated_at=:now
         WHERE id=:id`, { now: this.#now(), id }));
        return r.changes > 0;
    }
    /** Delete a task row outright (stale CREATING reconciliation). */
    remove(id) {
        const r = withRetry(() => this.#db.run('DELETE FROM tasks WHERE id=?', [id]));
        return r.changes > 0;
    }
    integrityOk() {
        const row = this.#db.get('PRAGMA integrity_check');
        return row.integrity_check === 'ok';
    }
    /** Write a consistent snapshot to `toPath`, replacing any existing file. */
    backup(toPath) {
        if (existsSync(toPath))
            rmSync(toPath);
        this.#db.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
    }
    close() {
        this.#db.close();
    }
    #applySchema() {
        const from = this.#userVersion();
        if (from === SCHEMA_VERSION)
            return;
        if (from > SCHEMA_VERSION) {
            throw new SchemaMismatchError(`state.db schema version ${from} is newer than this build supports (expected ${SCHEMA_VERSION})`);
        }
        // Replay every step from the stored version to head in one transaction: a
        // failed step (or a crash) rolls back wholesale, so the database is never
        // left half-migrated and each step may assume the previous one completed.
        this.#db.transaction(() => {
            for (let v = from; v < SCHEMA_VERSION; v++)
                this.#db.exec(MIGRATIONS[v]);
            this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        });
    }
    #userVersion() {
        return this.#db.get('PRAGMA user_version').user_version;
    }
    #assertSameRepoDependency(taskNumber, repo, dep) {
        if (repo === null)
            return;
        const conflict = this.#db.get('SELECT repo FROM tasks WHERE task_number=? AND repo IS NOT NULL AND repo != ?', [dep, repo]);
        if (conflict)
            throw new Error(`Cannot depend across repos: T${taskNumber}(${repo}) -> T${dep}(${conflict.repo})`);
    }
    #gatedRun(sql, id, token) {
        const r = withRetry(() => this.#db.run(sql, { now: this.#now(), id, tok: token }));
        return r.changes > 0;
    }
}
//# sourceMappingURL=TaskDb.js.map