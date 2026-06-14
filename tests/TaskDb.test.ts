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

/** A :memory: TaskDb with a controllable clock for time-based operations. */
function clockTaskDb(now: () => number): { tdb: TaskDb; db: Db } {
  const db = openDb(':memory:');
  const tdb = TaskDb.init(db, now);
  dbs.push(tdb);
  return { tdb, db };
}

/** Insert a task and promote it to PENDING (ready to pick). */
function ready(tdb: TaskDb, name: string, opts: { maxFailures?: number | null; dependsOn?: number[] } = {}): number {
  const { id, taskNumber } = tdb.insert({ name, ...opts });
  tdb.promote(id);
  return taskNumber;
}

function taskNumberToId(tdb: TaskDb, taskNumber: number): number {
  return tdb.getByNumber(taskNumber)!.id;
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

describe('TaskDb.insert / promote', () => {
  it('allocates sequential task numbers, derives the dir, and starts in CREATING', () => {
    const { tdb } = memTaskDb();
    const a = tdb.insert({ name: 'a' });
    const b = tdb.insert({ name: 'b' });
    expect(a.taskNumber).toBe(1);
    expect(a.dir).toBe('T01-a');
    expect(b.taskNumber).toBe(2);
    expect(b.dir).toBe('T02-b');
    expect(tdb.get(a.id)!.status).toBe('CREATING');
  });

  it('records max_failures, target_branch, and dependencies', () => {
    const { tdb } = memTaskDb();
    tdb.insert({ name: 'a' });
    const b = tdb.insert({ name: 'b', maxFailures: 9, targetBranch: 'dev', dependsOn: [1] });
    const row = tdb.get(b.id)!;
    expect(row.max_failures).toBe(9);
    expect(row.target_branch).toBe('dev');
    expect(tdb.dependencyNumbers(b.taskNumber)).toEqual([1]);
  });

  it('promote moves CREATING to PENDING and is a no-op otherwise', () => {
    const { tdb } = memTaskDb();
    const { id } = tdb.insert({ name: 'a' });
    expect(tdb.promote(id)).toBe(true);
    expect(tdb.get(id)!.status).toBe('PENDING');
    expect(tdb.promote(id)).toBe(false); // already PENDING
  });
});

describe('TaskDb.pick', () => {
  it('claims the lowest-numbered actionable task with a fresh token', () => {
    const { tdb } = clockTaskDb(() => 5000);
    ready(tdb, 'a');
    ready(tdb, 'b');
    const picked = tdb.pick('inst-1')!;
    expect(picked.task_number).toBe(1);
    expect(picked.status).toBe('IN_PROGRESS');
    expect(picked.claimed_by).toBe('inst-1');
    expect(picked.claim_token).toHaveLength(16);
    expect(picked.claimed_at).toBe(5000);
    expect(picked.heartbeat).toBe(5000);
  });

  it('returns undefined when nothing is actionable', () => {
    const { tdb } = memTaskDb();
    tdb.insert({ name: 'a' }); // CREATING, not pickable
    expect(tdb.pick('inst-1')).toBeUndefined();
  });

  it('also picks FAILED tasks', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    tdb.release(id, tok, 'FAILED');
    expect(tdb.pick('i2')!.task_number).toBe(n);
  });

  it('skips a task whose dependency has not converged, then picks it once converged', () => {
    const { tdb } = memTaskDb();
    const dep = ready(tdb, 'dep');
    ready(tdb, 'main', { dependsOn: [dep] });
    // Only the dependency is actionable first.
    const first = tdb.pick('i')!;
    expect(first.task_number).toBe(dep);
    expect(tdb.pick('i')).toBeUndefined(); // main still blocked by dep
    tdb.release(first.id, first.claim_token!, 'CONVERGED');
    expect(tdb.pick('i')!.name).toBe('main');
  });

  it('treats a dependency on a missing task as unmet (waits, not vacuously satisfied)', () => {
    const { tdb } = memTaskDb();
    const { id } = tdb.insert({ name: 'main', dependsOn: [99] });
    tdb.promote(id);
    expect(tdb.pick('i')).toBeUndefined();
  });

  it('skips a task that has exhausted its max_failures', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a', { maxFailures: 1 });
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    tdb.incrementFailures(id, tok);   // failures = 1, == max
    tdb.release(id, tok, 'FAILED');
    expect(tdb.pick('i2')).toBeUndefined();
  });

  it('keeps picking a task with unlimited (NULL) max_failures', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a', { maxFailures: null });
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    tdb.incrementFailures(id, tok);
    tdb.incrementFailures(id, tok);
    tdb.release(id, tok, 'FAILED');
    expect(tdb.pick('i2')!.task_number).toBe(n);
  });
});

describe('TaskDb claim-gated writes', () => {
  it('release sets status and clears all lease fields when the token matches', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    expect(tdb.release(id, tok, 'CONVERGED')).toBe(true);
    const row = tdb.get(id)!;
    expect(row.status).toBe('CONVERGED');
    expect(row.claim_token).toBeNull();
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(row.heartbeat).toBeNull();
  });

  it('rejects writes from a stale token', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    tdb.pick('i'); // real token differs from the stale one below
    expect(tdb.release(id, 'STALE', 'CONVERGED')).toBe(false);
    expect(tdb.incrementConvergence(id, 'STALE')).toBe(false);
    expect(tdb.resetConvergence(id, 'STALE')).toBe(false);
    expect(tdb.incrementFailures(id, 'STALE')).toBeNull();
    expect(tdb.heartbeat(id, 'STALE')).toBe(false);
  });

  it('increments and resets convergence under the held claim', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    expect(tdb.incrementConvergence(id, tok)).toBe(true);
    expect(tdb.incrementConvergence(id, tok)).toBe(true);
    expect(tdb.get(id)!.convergence).toBe(2);
    expect(tdb.resetConvergence(id, tok)).toBe(true);
    expect(tdb.get(id)!.convergence).toBe(0);
  });

  it('increments failures and returns the new count', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    expect(tdb.incrementFailures(id, tok)).toBe(1);
    expect(tdb.incrementFailures(id, tok)).toBe(2);
  });

  it('refreshes the heartbeat under the held claim', () => {
    let t = 1000;
    const { tdb } = clockTaskDb(() => t);
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    t = 2000;
    expect(tdb.heartbeat(id, tok)).toBe(true);
    expect(tdb.get(id)!.heartbeat).toBe(2000);
  });
});

describe('TaskDb.recoverStale', () => {
  it('fails and unclaims IN_PROGRESS tasks whose heartbeat is older than the cutoff', () => {
    let t = 1000;
    const { tdb } = clockTaskDb(() => t);
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    tdb.pick('i'); // claimed at t=1000 (heartbeat=1000)
    t = 9000;
    const recovered = tdb.recoverStale(5000); // cutoff 5000 > heartbeat 1000 → stale
    expect(recovered).toBe(1);
    const row = tdb.get(id)!;
    expect(row.status).toBe('FAILED');
    expect(row.claim_token).toBeNull();
    expect(row.failures).toBe(1);
  });

  it('leaves a task with a fresh heartbeat alone', () => {
    const { tdb } = clockTaskDb(() => 1000);
    ready(tdb, 'a');
    tdb.pick('i'); // heartbeat = 1000
    expect(tdb.recoverStale(500)).toBe(0); // cutoff 500 <= heartbeat 1000 → fresh
  });

  it('uses claimed_at as a fallback when heartbeat is NULL (migrated/external rows)', () => {
    const { tdb, db } = clockTaskDb(() => 1000);
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    tdb.pick('i');
    db.run('UPDATE tasks SET heartbeat=NULL WHERE id=?', [id]); // claimed_at stays 1000
    expect(tdb.recoverStale(5000)).toBe(1);
    expect(tdb.get(id)!.status).toBe('FAILED');
  });
});

describe('TaskDb.cascadeBlock', () => {
  it('blocks tasks that transitively depend on a BLOCKED task', () => {
    const { tdb } = memTaskDb();
    const a = ready(tdb, 'a');           // will be blocked
    const b = ready(tdb, 'b', { dependsOn: [a] });
    const c = ready(tdb, 'c', { dependsOn: [b] });
    // Block A directly.
    const idA = taskNumberToId(tdb, a);
    const tokA = tdb.pick('i')!.claim_token!;
    tdb.release(idA, tokA, 'BLOCKED');
    const blocked = tdb.cascadeBlock();
    expect(blocked).toBe(2); // b and c
    expect(tdb.getByNumber(b)!.status).toBe('BLOCKED');
    expect(tdb.getByNumber(c)!.status).toBe('BLOCKED');
  });

  it('does not block tasks whose dependencies are fine', () => {
    const { tdb } = memTaskDb();
    const a = ready(tdb, 'a');
    ready(tdb, 'b', { dependsOn: [a] });
    expect(tdb.cascadeBlock()).toBe(0);
  });
});
