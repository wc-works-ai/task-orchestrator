import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../../src/sqlite.js';
import { TaskDb, type TaskRow } from '../../src/TaskDb.js';
import { migrateShards } from '../../src/migrate.js';

const dirs: string[] = [];
const dbs: Array<{ close(): void }> = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-migrate-'));
  dirs.push(dir);
  return dir;
}

function memTaskDb(): TaskDb {
  const tdb = TaskDb.init(openDb(':memory:'));
  dbs.push(tdb);
  return tdb;
}

/** Write an old-format task dir under a shard with the given metadata files. */
function oldTask(root: string, shard: string, dirName: string, files: Record<string, string> = {}): string {
  const d = join(root, shard, dirName);
  mkdirSync(d, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
  return d;
}

function rowOf(tdb: TaskDb, n: number): TaskRow | undefined {
  return tdb.getByNumber(n);
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length) { try { dbs.pop()!.close(); } catch { /* already closed */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('migrateShards', () => {
  it('imports number, status, convergence, failures, deps, and target branch', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'converged', 'T01-dep', { '.status': 'CONVERGED' });
    oldTask(root, 'failed', 'T07-foo', {
      '.status': 'FAILED',
      '.convergence_count': '2',
      '.failure_count': '3',
      '.dependencies': '1\n',
      '.target_branch': 'dev/x',
      'autoresearch.md': '# content',
    });

    expect(migrateShards(tdb, root)).toBe(2);

    const foo = rowOf(tdb, 7)!;
    expect(foo.status).toBe('FAILED');
    expect(foo.convergence).toBe(2);
    expect(foo.failures).toBe(3);
    expect(foo.target_branch).toBe('dev/x');
    expect(tdb.dependencyNumbers(7)).toEqual([1]);
    expect(rowOf(tdb, 1)!.status).toBe('CONVERGED');
  });

  it('maps an IN_PROGRESS claim to FAILED so it is cleanly re-picked', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'in_progress', 'T03-wip', { '.status': 'IN_PROGRESS:inst-abc' });

    expect(migrateShards(tdb, root)).toBe(1);
    expect(rowOf(tdb, 3)!.status).toBe('FAILED');
  });

  it('defaults missing metadata: PENDING, zero counts, no deps, null branch', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'pending', 'T05-bare', { 'autoresearch.md': '# only content' });

    expect(migrateShards(tdb, root)).toBe(1);

    const row = rowOf(tdb, 5)!;
    expect(row.status).toBe('PENDING');
    expect(row.convergence).toBe(0);
    expect(row.failures).toBe(0);
    expect(row.target_branch).toBeNull();
    expect(tdb.dependencyNumbers(5)).toEqual([]);
  });

  it('sanitizes unrecognized status, bad counts, blank branch, and invalid deps', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'pending', 'T02-weird', {
      '.status': 'WHATEVER',
      '.convergence_count': 'not-a-number',
      '.failure_count': '-4',
      '.target_branch': '   ',
      '.dependencies': '3\n0\n-1\nx\n4\n',
    });
    oldTask(root, 'converged', 'T03-a', { '.status': 'CONVERGED' });
    oldTask(root, 'converged', 'T04-b', { '.status': 'CONVERGED' });

    migrateShards(tdb, root);

    const row = rowOf(tdb, 2)!;
    expect(row.status).toBe('PENDING');
    expect(row.convergence).toBe(0);
    expect(row.failures).toBe(0);
    expect(row.target_branch).toBeNull();
    expect(tdb.dependencyNumbers(2)).toEqual([3, 4]);
  });

  it('is idempotent — a second run imports nothing and does not duplicate', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'pending', 'T01-a', { '.status': 'PENDING' });

    expect(migrateShards(tdb, root)).toBe(1);
    expect(migrateShards(tdb, root)).toBe(0);
    expect(tdb.byStatus(['PENDING']).length).toBe(1);
  });

  it('stores the shard-relative dir so content resolves in place', () => {
    const root = tmp();
    const tdb = memTaskDb();
    const taskDir = oldTask(root, 'blocked', 'T09-keep', {
      '.status': 'BLOCKED',
      'autoresearch.md': '# stays here',
    });

    migrateShards(tdb, root);

    const row = rowOf(tdb, 9)!;
    expect(resolve(root, row.dir)).toBe(taskDir);
    expect(existsSync(join(resolve(root, row.dir), 'autoresearch.md'))).toBe(true);
    expect(row.status).toBe('BLOCKED');
  });

  it('ignores entries that are not T<number>- task dirs', () => {
    const root = tmp();
    const tdb = memTaskDb();
    mkdirSync(join(root, 'pending'), { recursive: true });
    writeFileSync(join(root, 'pending', 'state.db'), 'x');
    mkdirSync(join(root, 'pending', '.staging-T01-foo-123'), { recursive: true });
    mkdirSync(join(root, 'pending', 'notes'), { recursive: true });
    oldTask(root, 'pending', 'T01-real', { '.status': 'PENDING' });

    expect(migrateShards(tdb, root)).toBe(1);
    expect(rowOf(tdb, 1)).toBeDefined();
    expect(tdb.byStatus(['PENDING']).length).toBe(1);
  });

  it('skips a single unreadable task dir and imports the rest', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'pending', 'T01-good', { '.status': 'PENDING' });
    const bad = oldTask(root, 'pending', 'T02-bad', {});
    mkdirSync(join(bad, '.status')); // a directory where a file is expected → read throws

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = migrateShards(tdb, root);

    expect(n).toBe(1);
    expect(rowOf(tdb, 1)).toBeDefined();
    expect(rowOf(tdb, 2)).toBeUndefined();
    expect(errSpy).toHaveBeenCalledOnce();
  });

  it('returns 0 when no shard dirs exist', () => {
    const root = tmp();
    const tdb = memTaskDb();
    expect(migrateShards(tdb, root)).toBe(0);
  });

  it('freezes a finite max_failures from the environment', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'pending', 'T01-a', { '.status': 'PENDING' });

    const prev = process.env.ORCH_MAX_FAILURES;
    process.env.ORCH_MAX_FAILURES = '4';
    try { migrateShards(tdb, root); } finally { restoreEnv('ORCH_MAX_FAILURES', prev); }

    expect(rowOf(tdb, 1)!.max_failures).toBe(4);
  });

  it('imports unlimited retries (infinite env) as NULL max_failures', () => {
    const root = tmp();
    const tdb = memTaskDb();
    oldTask(root, 'pending', 'T01-a', { '.status': 'PENDING' });

    const prev = process.env.ORCH_MAX_FAILURES;
    process.env.ORCH_MAX_FAILURES = 'infinite';
    try { migrateShards(tdb, root); } finally { restoreEnv('ORCH_MAX_FAILURES', prev); }

    expect(rowOf(tdb, 1)!.max_failures).toBeNull();
  });
});
