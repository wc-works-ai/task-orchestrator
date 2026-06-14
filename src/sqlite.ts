/**
 * Thin, testable wrapper over Node's experimental `node:sqlite` driver.
 *
 * Isolating the driver here keeps the rest of the app off an unstable API and
 * gives us one place to enforce WAL mode, busy-timeout, and a simple
 * transaction helper. Tests use `:memory:` databases for isolation.
 */
import { DatabaseSync } from 'node:sqlite';
import { DbInitError } from './errors.js';

export type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>;
export type Row = Record<string, SqlValue>;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface Db {
  run(sql: string, params?: SqlParams): RunResult;
  get<T = Row>(sql: string, params?: SqlParams): T | undefined;
  all<T = Row>(sql: string, params?: SqlParams): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

const MEMORY = ':memory:';

/** Open (creating if needed) the state database with our standard settings. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000');
  if (path !== MEMORY) {
    db.exec('PRAGMA synchronous = NORMAL');
    const row = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
    requireWal(row?.journal_mode);
  }
  return new SqliteDb(db);
}

/** WAL can silently fall back to 'delete' on unsupported volumes; refuse that. */
export function requireWal(journalMode: string | undefined): void {
  if (journalMode !== 'wal') {
    throw new DbInitError(`state.db must use WAL journal mode but got '${String(journalMode)}'`);
  }
}

type DynArg = SqlValue | Record<string, SqlValue>;
type DynStmt = {
  run(...a: DynArg[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...a: DynArg[]): Row | undefined;
  all(...a: DynArg[]): Row[];
};

class SqliteDb implements Db {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  run(sql: string, params?: SqlParams): RunResult {
    const { stmt, args } = this.#bind(sql, params);
    const r = stmt.run(...args);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params?: SqlParams): T | undefined {
    const { stmt, args } = this.#bind(sql, params);
    return stmt.get(...args) as T | undefined;
  }

  all<T = Row>(sql: string, params?: SqlParams): T[] {
    const { stmt, args } = this.#bind(sql, params);
    return stmt.all(...args) as T[];
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = fn();
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    this.#db.exec('COMMIT');
    return result;
  }

  // node:sqlite accepts either positional args or a single named-params object.
  // The cast localizes that dynamic shape to this adapter.
  #bind(sql: string, params: SqlParams | undefined): { stmt: DynStmt; args: DynArg[] } {
    const stmt = this.#db.prepare(sql) as unknown as DynStmt;
    const args: DynArg[] = params === undefined ? [] : Array.isArray(params) ? [...params] : [params];
    return { stmt, args };
  }
}
