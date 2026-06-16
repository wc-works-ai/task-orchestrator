import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/state/sqlite.js';
import { TaskDb, SCHEMA_VERSION } from '../../src/state/TaskDb.js';
import { SchemaMismatchError } from '../../src/shared/errors.js';

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
function ready(
  tdb: TaskDb,
  name: string,
  opts: { maxFailures?: number | null; repo?: string | null; dependsOn?: number[]; priority?: number } = {},
): number {
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

const V1_SCHEMA = `
CREATE TABLE tasks (
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
CREATE INDEX idx_status ON tasks(status);
CREATE TABLE dependencies (
  task_number INTEGER NOT NULL,
  depends_on  INTEGER NOT NULL,
  PRIMARY KEY (task_number, depends_on),
  CHECK(task_number != depends_on)
);
CREATE INDEX idx_dep_on ON dependencies(depends_on);
`;

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

  it('creates the nullable repo column', () => {
    const { db } = memTaskDb();
    const columns = db.all<{ name: string }>('PRAGMA table_info(tasks)').map(c => c.name);
    expect(columns).toContain('repo');
  });

  it('creates the priority column defaulting to 0', () => {
    const { db } = memTaskDb();
    expect(db.all<{ name: string }>('PRAGMA table_info(tasks)').map(c => c.name)).toContain('priority');
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

  it('migrates a v1 database by adding repo as NULL and bumping user_version', () => {
    const path = join(tmp(), 'state.db');
    const raw = openDb(path);
    raw.exec(V1_SCHEMA);
    raw.run(
      `INSERT INTO tasks
         (task_number, name, dir, status, max_failures, target_branch, created_at, updated_at)
       VALUES (1, 'old', 'T01-old', 'PENDING', NULL, NULL, 10, 20)`,
    );
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    const migrated = TaskDb.open(path);
    dbs.push(migrated);

    const columns = openDb(path);
    dbs.push(columns);
    const cols = columns.all<{ name: string }>('PRAGMA table_info(tasks)').map(c => c.name);
    expect(cols).toContain('repo');
    expect(cols).toContain('priority');
    expect(columns.get<{ user_version: number }>('PRAGMA user_version')).toEqual({ user_version: SCHEMA_VERSION });
    expect(migrated.getByNumber(1)!.repo).toBeNull();
    expect(migrated.getByNumber(1)!.priority).toBe(0);
  });

  it('rolls back the entire migration when a later step fails (atomicity)', () => {
    const path = join(tmp(), 'state.db');
    const raw = openDb(path);
    raw.exec(V1_SCHEMA);
    raw.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    // Replay from v1 runs: ADD repo (succeeds) then ADD priority (duplicate →
    // throws). The whole transaction must roll back, leaving the DB untouched.
    expect(() => TaskDb.open(path)).toThrow(/duplicate column name: priority/);

    const check = openDb(path);
    dbs.push(check);
    const cols = check.all<{ name: string }>('PRAGMA table_info(tasks)').map(c => c.name);
    expect(cols).not.toContain('repo'); // the successful ADD repo was rolled back
    expect(cols).toContain('priority'); // the pre-existing column is untouched
    expect(check.get<{ user_version: number }>('PRAGMA user_version')).toEqual({ user_version: 1 });
  });

  it('migrates a v2 database by adding the priority column at 0 and bumping the version', () => {
    const path = join(tmp(), 'state.db');
    const raw = openDb(path);
    raw.exec(V1_SCHEMA);
    raw.exec('ALTER TABLE tasks ADD COLUMN repo TEXT');
    raw.run(
      `INSERT INTO tasks (task_number, name, dir, status, max_failures, created_at, updated_at)
       VALUES (1, 'old', 'T01-old', 'PENDING', NULL, 10, 20)`,
    );
    raw.exec('PRAGMA user_version = 2');
    raw.close();

    const migrated = TaskDb.open(path);
    dbs.push(migrated);
    expect(migrated.getByNumber(1)!.priority).toBe(0);

    const check = openDb(path);
    dbs.push(check);
    expect(check.all<{ name: string }>('PRAGMA table_info(tasks)').map(c => c.name)).toContain('priority');
    expect(check.get<{ user_version: number }>('PRAGMA user_version')).toEqual({ user_version: SCHEMA_VERSION });
  });

  it('produces an identical tasks schema whether created fresh or migrated from v1 or v2', () => {
    type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
    // Apply the schema starting from `seed`'s state, then snapshot the effective
    // tasks schema — column shape (order-insensitive) plus table/index names.
    const schemaOf = (seed: (raw: Db) => void): { cols: ColInfo[]; objects: string[] } => {
      const path = join(tmp(), 'state.db');
      const raw = openDb(path);
      seed(raw);
      raw.close();
      dbs.push(TaskDb.open(path));
      const probe = openDb(path);
      dbs.push(probe);
      const cols = probe
        .all<ColInfo>('PRAGMA table_info(tasks)')
        .map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const objects = probe
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'")
        .map(o => o.name)
        .sort();
      return { cols, objects };
    };

    const fresh = schemaOf(() => {}); // user_version 0 → replays every migration
    const fromV1 = schemaOf(raw => {
      raw.exec(V1_SCHEMA);
      raw.exec('PRAGMA user_version = 1');
    });
    const fromV2 = schemaOf(raw => {
      raw.exec(V1_SCHEMA);
      raw.exec('ALTER TABLE tasks ADD COLUMN repo TEXT');
      raw.exec('PRAGMA user_version = 2');
    });

    expect(fromV1).toEqual(fresh);
    expect(fromV2).toEqual(fresh);
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

  it('round-trips an explicit repo and defaults omitted repo to NULL', () => {
    const { tdb } = memTaskDb();
    const withRepo = tdb.insert({ name: 'with-repo', repo: 'Q:\\Repos\\one' });
    const withoutRepo = tdb.insert({ name: 'without-repo' });
    expect(tdb.get(withRepo.id)!.repo).toBe('Q:\\Repos\\one');
    expect(tdb.get(withoutRepo.id)!.repo).toBeNull();
  });

  it('stores an explicit priority and defaults omitted priority to 0', () => {
    const { tdb } = memTaskDb();
    const hi = tdb.insert({ name: 'hi', priority: 10 });
    const def = tdb.insert({ name: 'def' });
    expect(tdb.get(hi.id)!.priority).toBe(10);
    expect(tdb.get(def.id)!.priority).toBe(0);
  });

  it('rejects dependencies across different non-NULL repos', () => {
    const { tdb } = memTaskDb();
    const dep = tdb.insert({ name: 'dep', repo: 'Q:\\Repos\\a' });
    expect(() =>
      tdb.insert({ name: 'main', repo: 'Q:\\Repos\\b', dependsOn: [dep.taskNumber] }),
    ).toThrow('Cannot depend across repos: T2(Q:\\Repos\\b) -> T1(Q:\\Repos\\a)');
  });

  it('allows dependencies in the same repo', () => {
    const { tdb } = memTaskDb();
    const dep = tdb.insert({ name: 'dep', repo: 'Q:\\Repos\\a' });
    const main = tdb.insert({ name: 'main', repo: 'Q:\\Repos\\a', dependsOn: [dep.taskNumber] });
    expect(tdb.dependencyNumbers(main.taskNumber)).toEqual([dep.taskNumber]);
  });

  it('allows dependencies when either side has a NULL repo', () => {
    const { tdb } = memTaskDb();
    const nullDep = tdb.insert({ name: 'null-dep' });
    const repoDep = tdb.insert({ name: 'repo-dep', repo: 'Q:\\Repos\\a' });
    const repoMain = tdb.insert({ name: 'repo-main', repo: 'Q:\\Repos\\a', dependsOn: [nullDep.taskNumber] });
    const nullMain = tdb.insert({ name: 'null-main', dependsOn: [repoDep.taskNumber] });
    expect(tdb.dependencyNumbers(repoMain.taskNumber)).toEqual([nullDep.taskNumber]);
    expect(tdb.dependencyNumbers(nullMain.taskNumber)).toEqual([repoDep.taskNumber]);
  });

  it('promote moves CREATING to PENDING and is a no-op otherwise', () => {
    const { tdb } = memTaskDb();
    const { id } = tdb.insert({ name: 'a' });
    expect(tdb.promote(id)).toBe(true);
    expect(tdb.get(id)!.status).toBe('PENDING');
    expect(tdb.promote(id)).toBe(false); // already PENDING
  });
});

describe('TaskDb.importTask', () => {
  it('inserts a task verbatim with an explicit number, status, counters, and deps', () => {
    const { tdb } = memTaskDb();
    expect(
      tdb.importTask({
        taskNumber: 7, name: 'foo', dir: 'failed/T07-foo', status: 'FAILED',
        convergence: 2, failures: 3, maxFailures: 9, targetBranch: 'dev',
        repo: 'Q:\\Repos\\imported', dependsOn: [1, 2],
      }),
    ).toBe(true);

    const row = tdb.getByNumber(7)!;
    expect(row.task_number).toBe(7);
    expect(row.name).toBe('foo');
    expect(row.dir).toBe('failed/T07-foo');
    expect(row.status).toBe('FAILED');
    expect(row.convergence).toBe(2);
    expect(row.failures).toBe(3);
    expect(row.max_failures).toBe(9);
    expect(row.target_branch).toBe('dev');
    expect(row.repo).toBe('Q:\\Repos\\imported');
    expect(tdb.dependencyNumbers(7)).toEqual([1, 2]);
  });

  it('imports a task with NULL max_failures, no branch, and no deps', () => {
    const { tdb } = memTaskDb();
    expect(
      tdb.importTask({
        taskNumber: 4, name: 'bare', dir: 'pending/T04-bare', status: 'PENDING',
        convergence: 0, failures: 0, maxFailures: null, targetBranch: null, repo: null, dependsOn: [],
      }),
    ).toBe(true);

    const row = tdb.getByNumber(4)!;
    expect(row.max_failures).toBeNull();
    expect(row.target_branch).toBeNull();
    expect(row.repo).toBeNull();
    expect(tdb.dependencyNumbers(4)).toEqual([]);
  });

  it('keeps legacy import callers working by defaulting omitted repo to NULL', () => {
    const { tdb } = memTaskDb();
    expect(
      tdb.importTask({
        taskNumber: 5, name: 'legacy', dir: 'pending/T05-legacy', status: 'PENDING',
        convergence: 0, failures: 0, maxFailures: null, targetBranch: null, dependsOn: [],
      }),
    ).toBe(true);

    expect(tdb.getByNumber(5)!.repo).toBeNull();
  });

  it('is idempotent: ON CONFLICT(task_number) leaves the existing row and deps intact', () => {
    const { tdb } = memTaskDb();
    tdb.importTask({
      taskNumber: 1, name: 'first', dir: 'pending/T01-first', status: 'PENDING',
      convergence: 0, failures: 0, maxFailures: 5, targetBranch: null, repo: null, dependsOn: [],
    });

    expect(
      tdb.importTask({
        taskNumber: 1, name: 'second', dir: 'failed/T01-second', status: 'FAILED',
        convergence: 9, failures: 9, maxFailures: 1, targetBranch: 'other', repo: 'Q:\\Repos\\other', dependsOn: [2],
      }),
    ).toBe(false);

    const row = tdb.getByNumber(1)!;
    expect(row.name).toBe('first');
    expect(row.dir).toBe('pending/T01-first');
    expect(row.status).toBe('PENDING');
    expect(tdb.dependencyNumbers(1)).toEqual([]);
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

  it('claims the highest-priority actionable task first, regardless of creation order', () => {
    const { tdb } = memTaskDb();
    ready(tdb, 'low');                    // T1, priority 0
    ready(tdb, 'high', { priority: 5 });  // T2, priority 5 (created later)
    expect(tdb.pick('i')!.name).toBe('high');
  });

  it('breaks priority ties by task_number (FIFO within a level)', () => {
    const { tdb } = memTaskDb();
    ready(tdb, 'first', { priority: 3 });
    ready(tdb, 'second', { priority: 3 });
    expect(tdb.pick('i')!.name).toBe('first');
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

describe('TaskDb.setPriority', () => {
  it('updates the priority of an existing task', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    expect(tdb.setPriority(n, 7)).toBe(true);
    expect(tdb.getByNumber(n)!.priority).toBe(7);
  });

  it('returns false for a missing task', () => {
    const { tdb } = memTaskDb();
    expect(tdb.setPriority(999, 7)).toBe(false);
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

describe('TaskDb.byStatus', () => {
  it('returns tasks in any of the given statuses, ordered by task_number', () => {
    const { tdb, db } = memTaskDb();
    addRow(db, 3, 'T03-c', 'FAILED');
    addRow(db, 1, 'T01-a', 'PENDING');
    addRow(db, 2, 'T02-b', 'CONVERGED');
    const rows = tdb.byStatus(['PENDING', 'FAILED']);
    expect(rows.map(r => r.task_number)).toEqual([1, 3]);
  });

  it('returns an empty array when nothing matches', () => {
    const { tdb } = memTaskDb();
    ready(tdb, 'a');
    expect(tdb.byStatus(['BLOCKED'])).toEqual([]);
  });
});

describe('TaskDb.block', () => {
  it('forces a task to BLOCKED and clears convergence and the lease', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    const tok = tdb.pick('i')!.claim_token!;
    tdb.incrementConvergence(id, tok);
    expect(tdb.block(id)).toBe(true);
    const row = tdb.get(id)!;
    expect(row.status).toBe('BLOCKED');
    expect(row.convergence).toBe(0);
    expect(row.claimed_by).toBeNull();
    expect(row.claim_token).toBeNull();
  });

  it('returns false for an unknown id', () => {
    const { tdb } = memTaskDb();
    expect(tdb.block(999)).toBe(false);
  });
});

describe('TaskDb.unblock', () => {
  it('resets a task to PENDING, clearing failures, convergence, and the lease', () => {
    const { tdb, db } = memTaskDb();
    addRow(db, 1, 'T01-a', 'BLOCKED');
    const id = taskNumberToId(tdb, 1);
    db.run('UPDATE tasks SET failures=4, convergence=2 WHERE id=?', [id]);
    expect(tdb.unblock(id)).toBe(true);
    const row = tdb.get(id)!;
    expect(row.status).toBe('PENDING');
    expect(row.failures).toBe(0);
    expect(row.convergence).toBe(0);
    expect(row.claim_token).toBeNull();
  });

  it('returns false for an unknown id', () => {
    const { tdb } = memTaskDb();
    expect(tdb.unblock(999)).toBe(false);
  });
});

describe('TaskDb.remove', () => {
  it('deletes a task row', () => {
    const { tdb } = memTaskDb();
    const n = ready(tdb, 'a');
    const id = taskNumberToId(tdb, n);
    expect(tdb.remove(id)).toBe(true);
    expect(tdb.get(id)).toBeUndefined();
  });

  it('returns false for an unknown id', () => {
    const { tdb } = memTaskDb();
    expect(tdb.remove(999)).toBe(false);
  });
});
