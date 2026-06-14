/**
 * Task state schema and database lifecycle.
 *
 * TaskDb owns the SQLite schema (tasks + dependencies) and the open/init,
 * integrity-check, and backup operations. Task operations (pick, claim, …) are
 * added on top of this in later steps. State lives here; the filesystem holds
 * only task content.
 */
import { existsSync, rmSync } from 'node:fs';
import { openDb, type Db } from './sqlite.js';
import { SchemaMismatchError } from './errors.js';

export const SCHEMA_VERSION = 1;

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
`;

export class TaskDb {
  readonly #db: Db;

  private constructor(db: Db) {
    this.#db = db;
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

  /** Apply the schema to an already-open Db (tests inject a `:memory:` handle). */
  static init(db: Db): TaskDb {
    const tdb = new TaskDb(db);
    tdb.#applySchema();
    return tdb;
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
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw new SchemaMismatchError(
        `state.db schema version ${version} is not supported (expected ${SCHEMA_VERSION})`,
      );
    }
    this.#db.exec(SCHEMA);
    if (version === 0) this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  #userVersion(): number {
    return this.#db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
  }
}
