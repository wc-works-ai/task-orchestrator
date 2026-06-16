/**
 * SQLite-backed task state. Owns the schema (tasks + dependencies), lifecycle
 * (open/init, integrity check, backup), creation, atomic claiming, claim-gated
 * updates, stale-claim recovery, and the dependency cascade. State lives here;
 * the filesystem holds only task content.
 */
import { existsSync, rmSync } from 'node:fs';
import { openDb, type Db } from './sqlite.js';
import { SchemaMismatchError, withRetry } from '../shared/errors.js';

export const SCHEMA_VERSION = 3;

// Guard the recursive dependency walk against a malformed graph.
const MAX_DEPENDENCY_DEPTH = 10000;

export type TaskStatus =
  | 'CREATING' | 'PENDING' | 'IN_PROGRESS' | 'FAILED' | 'BLOCKED' | 'CONVERGED';

/** Content directory name for a task, e.g. (1, "auth") → "T01-auth". */
export function taskDirName(taskNumber: number, name: string): string {
  return `T${String(taskNumber).padStart(2, '0')}-${name}`;
}

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

type LegacyImportTask = Omit<ImportTask, 'repo'> & { readonly repo?: string | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  task_number   INTEGER NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  dir           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status        TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('CREATING','PENDING','IN_PROGRESS','FAILED','BLOCKED','CONVERGED')),
  convergence   INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  max_failures  INTEGER CHECK(max_failures IS NULL OR max_failures > 0),
  target_branch TEXT,
  repo          TEXT,
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
`;

export class TaskDb {
  readonly #db: Db;
  readonly #now: () => number;

  private constructor(db: Db, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  /** Open (creating if needed) the state database at `path` and apply the schema. */
  static open(path: string): TaskDb {
    const db = openDb(path);
    try {
      return TaskDb.init(db);
    } catch (e) {
      // Don't leak the handle (on Windows a leaked handle also locks the file).
      db.close();
      throw e;
    }
  }

  /** Apply the schema to an already-open Db (tests inject `:memory:` and a clock). */
  static init(db: Db, now: () => number = Date.now): TaskDb {
    const tdb = new TaskDb(db, now);
    tdb.#applySchema();
    return tdb;
  }

  // ── Reads ───────────────────────────────────────────────────────────
  get(id: number): TaskRow | undefined {
    return withRetry(() => this.#db.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [id]));
  }

  getByNumber(taskNumber: number): TaskRow | undefined {
    return withRetry(() => this.#db.get<TaskRow>('SELECT * FROM tasks WHERE task_number=?', [taskNumber]));
  }

  dependencyNumbers(taskNumber: number): number[] {
    return withRetry(() =>
      this.#db.all<{ depends_on: number }>(
        'SELECT depends_on FROM dependencies WHERE task_number=? ORDER BY depends_on',
        [taskNumber],
      ),
    ).map(r => r.depends_on);
  }

  /** Every task in any of `statuses`, ordered by task_number. Callers pass a
   *  non-empty list (scan, converged accounting, startup reconciliation). */
  byStatus(statuses: readonly TaskStatus[]): TaskRow[] {
    const placeholders = statuses.map(() => '?').join(',');
    return withRetry(() =>
      this.#db.all<TaskRow>(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY task_number`, [
        ...statuses,
      ]),
    );
  }

  // ── Creation ────────────────────────────────────────────────────────
  /** Allocate the next task_number, derive its content dir, and insert as
   *  CREATING with its deps — all atomically. Returns the id, number, and dir. */
  insert(t: NewTask): { id: number; taskNumber: number; dir: string } {
    return withRetry(() =>
      this.#db.transaction(() => {
        const now = this.#now();
        const taskNumber = this.#db.get<{ n: number }>(
          'SELECT COALESCE(MAX(task_number),0)+1 AS n FROM tasks',
        )!.n;
        const dir = taskDirName(taskNumber, t.name);
        const repo = t.repo ?? null;
        const row = this.#db.get<{ id: number }>(
          `INSERT INTO tasks (task_number, name, dir, status, max_failures, target_branch, repo, priority, created_at, updated_at)
           VALUES (:num, :name, :dir, 'CREATING', :max, :branch, :repo, :priority, :now, :now)
           RETURNING id`,
          { num: taskNumber, name: t.name, dir, max: t.maxFailures ?? null, branch: t.targetBranch ?? null, repo, priority: t.priority ?? 0, now },
        )!;
        for (const dep of t.dependsOn ?? []) {
          this.#assertSameRepoDependency(taskNumber, repo, dep);
          this.#db.run('INSERT INTO dependencies (task_number, depends_on) VALUES (?,?)', [taskNumber, dep]);
        }
        return { id: row.id, taskNumber, dir };
      }),
    );
  }

  /** Import a pre-existing task verbatim (one-time shard migration): insert the
   *  row with the supplied number/dir/status/counters and its dependency rows,
   *  idempotently via ON CONFLICT(task_number) DO NOTHING. Returns whether a row
   *  was inserted (false when the number already existed). */
  importTask(t: ImportTask): boolean;
  importTask(t: LegacyImportTask): boolean;
  importTask(t: ImportTask | LegacyImportTask): boolean {
    return withRetry(() =>
      this.#db.transaction(() => {
        const now = this.#now();
        const repo = t.repo ?? null;
        const r = this.#db.run(
          `INSERT INTO tasks
             (task_number, name, dir, status, convergence, failures, max_failures, target_branch, repo, created_at, updated_at)
           VALUES (:num, :name, :dir, :status, :conv, :fail, :max, :branch, :repo, :now, :now)
           ON CONFLICT(task_number) DO NOTHING`,
          {
            num: t.taskNumber, name: t.name, dir: t.dir, status: t.status, conv: t.convergence,
            fail: t.failures, max: t.maxFailures, branch: t.targetBranch, repo, now,
          },
        );
        if (r.changes === 0) return false;
        for (const dep of t.dependsOn) {
          this.#db.run('INSERT INTO dependencies (task_number, depends_on) VALUES (?,?)', [t.taskNumber, dep]);
        }
        return true;
      }),
    );
  }

  /** Publish a fully-written task: CREATING → PENDING. Returns false if not CREATING. */
  promote(id: number): boolean {
    const r = withRetry(() =>
      this.#db.run("UPDATE tasks SET status='PENDING', updated_at=:now WHERE id=:id AND status='CREATING'", {
        id,
        now: this.#now(),
      }),
    );
    return r.changes > 0;
  }

  // ── Claiming ────────────────────────────────────────────────────────
  /** Atomically claim the lowest-numbered actionable task whose deps have converged. */
  pick(instanceId: string): TaskRow | undefined {
    const now = this.#now();
    return withRetry(() =>
      this.#db.get<TaskRow>(
        `UPDATE tasks
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
         RETURNING *`,
        { inst: instanceId, now },
      ),
    );
  }

  /** Set a task's priority (higher = picked sooner). Not claim-gated — any
   *  caller may re-prioritize. Returns false when no such task exists. */
  setPriority(taskNumber: number, priority: number): boolean {
    const r = withRetry(() =>
      this.#db.run('UPDATE tasks SET priority=:p, updated_at=:now WHERE task_number=:tn', {
        p: priority, now: this.#now(), tn: taskNumber,
      }),
    );
    return r.changes > 0;
  }

  // ── Claim-gated writes (only the current owner may apply them) ───────
  /** Set a terminal status and clear every lease field. Returns false if the claim is stale. */
  release(id: number, token: string, status: TaskStatus): boolean {
    const r = withRetry(() =>
      this.#db.run(
        `UPDATE tasks SET status=:s, claimed_by=NULL, claim_token=NULL, claimed_at=NULL,
                heartbeat=NULL, updated_at=:now
         WHERE id=:id AND claim_token=:tok`,
        { s: status, now: this.#now(), id, tok: token },
      ),
    );
    return r.changes > 0;
  }

  incrementConvergence(id: number, token: string): boolean {
    return this.#gatedRun(
      'UPDATE tasks SET convergence=convergence+1, updated_at=:now WHERE id=:id AND claim_token=:tok',
      id,
      token,
    );
  }

  resetConvergence(id: number, token: string): boolean {
    return this.#gatedRun(
      'UPDATE tasks SET convergence=0, updated_at=:now WHERE id=:id AND claim_token=:tok',
      id,
      token,
    );
  }

  heartbeat(id: number, token: string): boolean {
    return this.#gatedRun(
      'UPDATE tasks SET heartbeat=:now WHERE id=:id AND claim_token=:tok',
      id,
      token,
    );
  }

  /** Bump the failure count, returning the new total, or null if the claim is stale. */
  incrementFailures(id: number, token: string): number | null {
    const row = withRetry(() =>
      this.#db.get<{ failures: number }>(
        'UPDATE tasks SET failures=failures+1, updated_at=:now WHERE id=:id AND claim_token=:tok RETURNING failures',
        { now: this.#now(), id, tok: token },
      ),
    );
    return row ? row.failures : null;
  }

  // ── Orchestrator-level (not claim-gated) ────────────────────────────
  /** Fail + fully unclaim IN_PROGRESS tasks last seen before `cutoff`. Returns count. */
  recoverStale(cutoff: number): number {
    const r = withRetry(() =>
      this.#db.run(
        `UPDATE tasks SET status='FAILED', claimed_by=NULL, claim_token=NULL, claimed_at=NULL,
                heartbeat=NULL, failures=failures+1, updated_at=:now
         WHERE status='IN_PROGRESS' AND COALESCE(heartbeat, claimed_at, 0) < :cutoff`,
        { now: this.#now(), cutoff },
      ),
    );
    return r.changes;
  }

  /** Block every PENDING/FAILED task that transitively depends on a BLOCKED task. */
  cascadeBlock(): number {
    const r = withRetry(() =>
      this.#db.run(
        `WITH RECURSIVE blocked_chain(tn, depth) AS (
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
           AND status IN ('PENDING','FAILED')`,
        { now: this.#now() },
      ),
    );
    return r.changes;
  }

  /** Force a task to BLOCKED, clearing convergence and every lease field.
   *  Not claim-gated: terminal blocking of unclaimed tasks (exhausted retries,
   *  missing content dir). */
  block(id: number): boolean {
    const r = withRetry(() =>
      this.#db.run(
        `UPDATE tasks SET status='BLOCKED', convergence=0, claimed_by=NULL, claim_token=NULL,
                claimed_at=NULL, heartbeat=NULL, updated_at=:now
         WHERE id=:id`,
        { now: this.#now(), id },
      ),
    );
    return r.changes > 0;
  }

  /** Reset a task to PENDING, clearing failures, convergence, and every lease
   *  field. Not claim-gated: terminal tasks hold no claim. */
  unblock(id: number): boolean {
    const r = withRetry(() =>
      this.#db.run(
        `UPDATE tasks SET status='PENDING', failures=0, convergence=0, claimed_by=NULL,
                claim_token=NULL, claimed_at=NULL, heartbeat=NULL, updated_at=:now
         WHERE id=:id`,
        { now: this.#now(), id },
      ),
    );
    return r.changes > 0;
  }

  /** Delete a task row outright (stale CREATING reconciliation). */
  remove(id: number): boolean {
    const r = withRetry(() => this.#db.run('DELETE FROM tasks WHERE id=?', [id]));
    return r.changes > 0;
  }

  integrityOk(): boolean {
    const row = this.#db.get<{ integrity_check: string }>('PRAGMA integrity_check')!;
    return row.integrity_check === 'ok';
  }

  /** Write a consistent snapshot to `toPath`, replacing any existing file. */
  backup(toPath: string): void {
    if (existsSync(toPath)) rmSync(toPath);
    this.#db.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.#db.close();
  }

  #applySchema(): void {
    const version = this.#userVersion();
    if (version === 0) {
      this.#db.exec(SCHEMA);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return;
    }
    if (version === 1 || version === 2) {
      this.#migrateColumns();
      return;
    }
    if (version === SCHEMA_VERSION) return;
    throw new SchemaMismatchError(
      `state.db schema version ${version} is not supported (expected ${SCHEMA_VERSION})`,
    );
  }

  #userVersion(): number {
    return this.#db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
  }

  /** Bring a v1 or v2 schema up to the current version. `repo` may already
   *  exist (added in v2) so it is added only when missing; `priority` is new in
   *  v3 and always absent at v1/v2, so it is added unconditionally. */
  #migrateColumns(): void {
    const cols = this.#db.all<{ name: string }>('PRAGMA table_info(tasks)').map(c => c.name);
    if (!cols.includes('repo')) this.#db.exec('ALTER TABLE tasks ADD COLUMN repo TEXT');
    this.#db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  #assertSameRepoDependency(taskNumber: number, repo: string | null, dep: number): void {
    if (repo === null) return;
    const conflict = this.#db.get<{ repo: string }>(
      'SELECT repo FROM tasks WHERE task_number=? AND repo IS NOT NULL AND repo != ?',
      [dep, repo],
    );
    if (conflict) throw new Error(`Cannot depend across repos: T${taskNumber}(${repo}) -> T${dep}(${conflict.repo})`);
  }

  #gatedRun(sql: string, id: number, token: string): boolean {
    const r = withRetry(() => this.#db.run(sql, { now: this.#now(), id, tok: token }));
    return r.changes > 0;
  }
}
