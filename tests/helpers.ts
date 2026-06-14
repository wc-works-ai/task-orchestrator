import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { openDb, type Db } from '../src/sqlite.js';
import { TaskDb, taskDirName, type TaskRow, type TaskStatus } from '../src/TaskDb.js';
import { TaskState } from '../src/TaskState.js';

export interface SeedOpts {
  status?: TaskStatus;
  convergence?: number;
  failures?: number;
  maxFailures?: number | null;
  targetBranch?: string | null;
  claimedBy?: string | null;
  claimToken?: string | null;
  claimedAt?: number | null;
  heartbeat?: number | null;
  deps?: readonly number[];
  autoresearch?: string;
  /** Write a benchmark.js stub (used by CREATING/reconcile fixtures). */
  benchmark?: boolean;
}

export interface StateDb {
  readonly db: Db;
  readonly tdb: TaskDb;
}

/** Fresh temp tasks dir using the flat content layout (no shards). */
export function setupTestDir(prefix = 'orch-test-'): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

/** Open a real file-backed state DB under `tasksDir`; Engine/RunReport tests use this. */
export function openStateDb(tasksDir: string): StateDb {
  const db = openDb(join(tasksDir, 'state.db'));
  return { db, tdb: TaskDb.init(db) };
}

/** Open an in-memory state DB; content-only consumer tests use this. */
export function memStateDb(): StateDb {
  const db = openDb(':memory:');
  return { db, tdb: TaskDb.init(db) };
}

/** Insert a fully-specified task row and create its content directory. */
export function seed(db: Db, tasksDir: string, n: number, name: string, opts: SeedOpts = {}): TaskRow {
  const dir = taskDirName(n, name);
  const content = resolve(tasksDir, dir);
  mkdirSync(content, { recursive: true });
  if (opts.autoresearch !== undefined) writeFileSync(join(content, 'autoresearch.md'), opts.autoresearch);
  if (opts.benchmark) writeFileSync(join(content, 'benchmark.js'), 'console.log("METRIC ok 0");');
  const now = Date.now();
  db.run(
    `INSERT INTO tasks (task_number, name, dir, status, convergence, failures, max_failures,
       target_branch, claimed_by, claim_token, claimed_at, heartbeat, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      n, name, dir,
      opts.status ?? 'PENDING',
      opts.convergence ?? 0,
      opts.failures ?? 0,
      opts.maxFailures === undefined ? 5 : opts.maxFailures,
      opts.targetBranch ?? null,
      opts.claimedBy ?? null,
      opts.claimToken ?? null,
      opts.claimedAt ?? null,
      opts.heartbeat ?? null,
      now, now,
    ],
  );
  for (const d of opts.deps ?? []) {
    db.run('INSERT INTO dependencies (task_number, depends_on) VALUES (?,?)', [n, d]);
  }
  return db.get<TaskRow>('SELECT * FROM tasks WHERE task_number=?', [n])!;
}

/** Seed a row and return a DB-backed TaskState view carrying the row's claim token. */
export function seedState(s: StateDb, tasksDir: string, n: number, name: string, opts: SeedOpts = {}): TaskState {
  const row = seed(s.db, tasksDir, n, name, opts);
  return TaskState.fromRow(s.tdb, tasksDir, row);
}

/** Read a task row by number for assertions. */
export function rowOf(db: Db, n: number): TaskRow | undefined {
  return db.get<TaskRow>('SELECT * FROM tasks WHERE task_number=?', [n]);
}

/** Read just the status string of a task by number for assertions. */
export function statusOf(db: Db, n: number): string | undefined {
  return rowOf(db, n)?.status;
}
