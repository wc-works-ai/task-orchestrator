import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/sqlite.js';
import { TaskDb, SCHEMA_VERSION } from '../src/TaskDb.js';
import { SchemaMismatchError } from '../src/errors.js';

const dirs: string[] = [];
const dbs: Array<{ close(): void }> = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-taskdb-'));
  dirs.push(dir);
  return dir;
}

/** A :memory: TaskDb plus the shared Db handle for white-box schema checks. */
function memTaskDb(): { tdb: TaskDb; db: Db } {
  const db = openDb(':memory:');
  const tdb = TaskDb.init(db);
  dbs.push(tdb);
  return { tdb, db };
}

const INSERT =
  'INSERT INTO tasks(task_number,name,dir,status,max_failures,created_at,updated_at) ' +
  'VALUES (:n,:name,:dir,:status,:max,0,0)';

function addRow(
  db: Db,
  n: number,
  dir: string,
  status = 'PENDING',
  max: number | null = null,
): void {
  db.run(INSERT, { n, name: `t${n}`, dir, status, max });
}

afterEach(() => {
  while (dbs.length) {
    try { dbs.pop()!.close(); } catch { /* already closed */ }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('TaskDb schema', () => {
  it('creates the tasks and dependencies tables', () => {
    const { db } = memTaskDb();
    const names = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .map(r => r.name);
    expect(names).toContain('tasks');
    expect(names).toContain('dependencies');
  });

  it('sets the schema version on a fresh database', () => {
    const { db } = memTaskDb();
    expect(db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
      user_version: SCHEMA_VERSION,
    });
  });

  it('allows the CREATING status (regression: must be in the CHECK list)', () => {
    const { db } = memTaskDb();
    expect(() => addRow(db, 1, 'T1-a', 'CREATING')).not.toThrow();
  });

  it('rejects an unknown status via the CHECK constraint', () => {
    const { db } = memTaskDb();
    expect(() => addRow(db, 1, 'T1-a', 'BOGUS')).toThrow();
  });

  it('enforces case-insensitive uniqueness on dir (Windows safety)', () => {
    const { db } = memTaskDb();
    addRow(db, 1, 'T1-Alpha');
    expect(() => addRow(db, 2, 't1-alpha')).toThrow();
  });

  it('rejects a non-positive max_failures and accepts NULL or positive', () => {
    const { db } = memTaskDb();
    expect(() => addRow(db, 1, 'T1-a', 'PENDING', 0)).toThrow();
    expect(() => addRow(db, 2, 'T2-a', 'PENDING', null)).not.toThrow();
    expect(() => addRow(db, 3, 'T3-a', 'PENDING', 4)).not.toThrow();
  });

  it('rejects a self-dependency', () => {
    const { db } = memTaskDb();
    expect(() =>
      db.run('INSERT INTO dependencies(task_number,depends_on) VALUES (5,5)'),
    ).toThrow();
  });
});

describe('TaskDb lifecycle', () => {
  it('opens a file database, then reopens it without a schema error', () => {
    const path = join(tmp(), 'state.db');
    TaskDb.open(path).close();
    const reopened = TaskDb.open(path);
    expect(reopened.integrityOk()).toBe(true);
    reopened.close();
  });

  it('throws SchemaMismatchError when the stored version is newer', () => {
    const path = join(tmp(), 'state.db');
    TaskDb.open(path).close();
    const raw = openDb(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => TaskDb.open(path)).toThrowError(SchemaMismatchError);
  });

  it('reports a healthy integrity check', () => {
    const { tdb } = memTaskDb();
    expect(tdb.integrityOk()).toBe(true);
  });
});

describe('TaskDb backup', () => {
  it('writes a consistent snapshot that is itself a valid database', () => {
    const dir = tmp();
    const tdb = TaskDb.open(join(dir, 'state.db'));
    dbs.push(tdb);
    const bak = join(dir, 'state.db.bak');
    tdb.backup(bak);
    expect(existsSync(bak)).toBe(true);
    const snap = TaskDb.open(bak);
    expect(snap.integrityOk()).toBe(true);
    snap.close();
  });

  it('overwrites an existing snapshot file', () => {
    const dir = tmp();
    const tdb = TaskDb.open(join(dir, 'state.db'));
    dbs.push(tdb);
    const bak = join(dir, 'state.db.bak');
    tdb.backup(bak);
    expect(() => tdb.backup(bak)).not.toThrow();
  });
});
