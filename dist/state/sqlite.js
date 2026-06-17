/**
 * Thin, testable wrapper over Node's experimental `node:sqlite` driver.
 *
 * Isolating the driver here keeps the rest of the app off an unstable API and
 * gives us one place to enforce WAL mode, busy-timeout, and a simple
 * transaction helper. Tests use `:memory:` databases for isolation.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DbInitError } from '../shared/errors.js';
const MEMORY = ':memory:';
/** Open (creating if needed) the state database with our standard settings. */
export function openDb(path) {
    // A file DB can't be created if its directory is missing (first run).
    if (path !== MEMORY)
        mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 10000');
    if (path !== MEMORY) {
        db.exec('PRAGMA synchronous = NORMAL');
        const row = db.prepare('PRAGMA journal_mode = WAL').get();
        requireWal(row?.journal_mode);
    }
    return new SqliteDb(db);
}
/** WAL can silently fall back to 'delete' on unsupported volumes; refuse that. */
export function requireWal(journalMode) {
    if (journalMode !== 'wal') {
        throw new DbInitError(`state.db must use WAL journal mode but got '${String(journalMode)}'`);
    }
}
class SqliteDb {
    #db;
    constructor(db) {
        this.#db = db;
    }
    run(sql, params) {
        const { stmt, args } = this.#bind(sql, params);
        const r = stmt.run(...args);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    }
    get(sql, params) {
        const { stmt, args } = this.#bind(sql, params);
        return stmt.get(...args);
    }
    all(sql, params) {
        const { stmt, args } = this.#bind(sql, params);
        return stmt.all(...args);
    }
    exec(sql) {
        this.#db.exec(sql);
    }
    close() {
        this.#db.close();
    }
    transaction(fn) {
        this.#db.exec('BEGIN IMMEDIATE');
        let result;
        try {
            result = fn();
        }
        catch (e) {
            this.#db.exec('ROLLBACK');
            throw e;
        }
        this.#db.exec('COMMIT');
        return result;
    }
    // node:sqlite accepts either positional args or a single named-params object.
    // The cast localizes that dynamic shape to this adapter.
    #bind(sql, params) {
        const stmt = this.#db.prepare(sql);
        const args = params === undefined ? [] : Array.isArray(params) ? [...params] : [params];
        return { stmt, args };
    }
}
//# sourceMappingURL=sqlite.js.map