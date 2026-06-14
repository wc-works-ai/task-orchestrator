import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, requireWal, type Db } from '../src/sqlite.js';
import { DbInitError } from '../src/errors.js';

const open: Db[] = [];
const dirs: string[] = [];

function mem(): Db {
  const db = openDb(':memory:');
  open.push(db);
  return db;
}

function fileDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'orch-sqlite-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'state.db'));
  open.push(db);
  return db;
}

afterEach(() => {
  while (open.length) {
    try { open.pop()!.close(); } catch { /* already closed by a test */ }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('openDb', () => {
  it('opens an in-memory database and runs basic statements', () => {
    const db = mem();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)');
    const r = db.run('INSERT INTO t(n) VALUES (?)', [5]);
    expect(r.changes).toBe(1);
    expect(r.lastInsertRowid).toBe(1);
    expect(typeof r.lastInsertRowid).toBe('number');
    expect(db.get('SELECT n FROM t WHERE id=?', [1])).toEqual({ n: 5 });
    expect(db.all('SELECT n FROM t')).toEqual([{ n: 5 }]);
  });

  it('opens a file database in WAL mode', () => {
    const db = fileDb();
    expect(db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
  });

  it('creates missing parent directories for a file database (first run)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-sqlite-'));
    dirs.push(dir);
    const nested = join(dir, 'sub', 'tasks', 'state.db'); // sub/tasks do not exist yet
    const db = openDb(nested);
    open.push(db);
    expect(db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
  });

  it('get returns undefined when no row matches', () => {
    const db = mem();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
    expect(db.get('SELECT * FROM t WHERE id=?', [99])).toBeUndefined();
  });

  it('supports named parameters', () => {
    const db = mem();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)');
    db.run('INSERT INTO t(n) VALUES (:n)', { n: 3 });
    expect(db.get('SELECT n FROM t WHERE n=:n', { n: 3 })).toEqual({ n: 3 });
  });

  it('close() releases the database', () => {
    const db = openDb(':memory:');
    db.close();
    expect(() => db.exec('SELECT 1')).toThrow();
  });
});

describe('transaction', () => {
  it('commits when the body succeeds', () => {
    const db = mem();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)');
    const out = db.transaction(() => {
      db.run('INSERT INTO t(n) VALUES (?)', [9]);
      return 'done';
    });
    expect(out).toBe('done');
    expect(db.all('SELECT n FROM t')).toEqual([{ n: 9 }]);
  });

  it('rolls back and rethrows when the body throws', () => {
    const db = mem();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)');
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t(n) VALUES (?)', [1]);
        throw new Error('boom');
      }),
    ).toThrowError('boom');
    expect(db.all('SELECT * FROM t')).toEqual([]);
  });
});

describe('requireWal', () => {
  it('accepts wal', () => {
    expect(() => requireWal('wal')).not.toThrow();
  });

  it('throws DbInitError for any non-wal journal mode', () => {
    expect(() => requireWal('delete')).toThrowError(DbInitError);
  });
});
