import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import type { ImportTask, TaskDb } from '../../src/state/TaskDb.js';

// migrate.ts touches the filesystem only through node:fs. Mocking it lets us
// drive every sanitizer/mapping branch from an in-memory virtual filesystem —
// instant, deterministic, no temp dirs.
const h = vi.hoisted(() => ({
  files: new Map<string, string>(), // path → content
  dirs: new Map<string, string[]>(), // dir path → entry names
  bad: new Set<string>(), // paths that exist but throw on read (corrupt/EISDIR)
}));

vi.mock('node:fs', () => ({
  existsSync: (p: string) => h.files.has(p) || h.dirs.has(p) || h.bad.has(p),
  readdirSync: (p: string) => {
    const entries = h.dirs.get(p);
    if (!entries) throw new Error(`ENOENT readdir ${p}`);
    return entries;
  },
  readFileSync: (p: string) => {
    if (h.bad.has(p)) throw new Error(`EISDIR ${p}`);
    const content = h.files.get(p);
    if (content === undefined) throw new Error(`ENOENT read ${p}`);
    return content;
  },
}));

const { migrateShards } = await import('../../src/state/migrate.js');

const ROOT = join('virtual', 'migrate-root');
const UNREADABLE = '@@unreadable@@';

type MetaSpec = Record<string, string>; // metadata file name → content (or UNREADABLE)
type Spec = Record<string, Record<string, MetaSpec>>; // shard → entry → files

/** Populate the virtual filesystem from a shard/entry/metadata description. */
function setVfs(spec: Spec): void {
  h.files.clear();
  h.dirs.clear();
  h.bad.clear();
  for (const [shard, entries] of Object.entries(spec)) {
    h.dirs.set(join(ROOT, shard), Object.keys(entries));
    for (const [entry, metas] of Object.entries(entries)) {
      for (const [fname, content] of Object.entries(metas)) {
        const fpath = join(ROOT, shard, entry, fname);
        if (content === UNREADABLE) h.bad.add(fpath);
        else h.files.set(fpath, content);
      }
    }
  }
}

/** Minimal TaskDb stand-in capturing imported tasks; `present` seeds prior rows. */
function fakeTdb(present: number[] = []) {
  const have = new Set(present);
  const imported: ImportTask[] = [];
  const tdb = {
    getByNumber: (n: number) => (have.has(n) ? ({ task_number: n } as unknown) : undefined),
    importTask: (t: ImportTask) => {
      imported.push(t);
      have.add(t.taskNumber);
      return true;
    },
  };
  return { tdb: tdb as unknown as TaskDb, imported };
}

function byNumber(imported: ImportTask[]): Record<number, ImportTask> {
  return Object.fromEntries(imported.map(t => [t.taskNumber, t]));
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migrateShards (mocked fs)', () => {
  // ── Status mapping ────────────────────────────────────────────────────
  it('maps IN_PROGRESS→FAILED, passes valid statuses through, unknown/missing→PENDING', () => {
    setVfs({
      in_progress: {
        'T01-a': { '.status': 'IN_PROGRESS:inst-9' },
        'T08-h': { '.status': 'IN_PROGRESS' }, // no suffix still starts with IN_PROGRESS
      },
      pending: {
        'T02-b': { '.status': 'PENDING' },
        'T03-c': { '.status': 'WHATEVER' }, // unrecognized
        'T04-d': {}, // missing .status entirely
      },
      converged: { 'T07-g': { '.status': 'CONVERGED' } },
      failed: { 'T05-e': { '.status': 'FAILED' } },
      blocked: { 'T06-f': { '.status': 'BLOCKED' } },
    });
    const { tdb, imported } = fakeTdb();

    expect(migrateShards(tdb, ROOT)).toBe(8);

    const status = Object.fromEntries(imported.map(t => [t.taskNumber, t.status]));
    expect(status).toEqual({
      1: 'FAILED', 8: 'FAILED', 2: 'PENDING', 3: 'PENDING', 4: 'PENDING',
      7: 'CONVERGED', 5: 'FAILED', 6: 'BLOCKED',
    });
  });

  // ── Non-negative integer counters ─────────────────────────────────────
  it('parses non-negative integer counts; garbage, negative, non-integer, and missing → 0', () => {
    setVfs({
      failed: {
        'T01-a': { '.status': 'FAILED', '.convergence_count': '2', '.failure_count': '3' },
        'T02-b': { '.status': 'FAILED', '.convergence_count': 'not-a-number', '.failure_count': '-4' },
        'T03-c': { '.status': 'FAILED', '.convergence_count': '2.5' }, // non-integer
        'T04-d': { '.status': 'FAILED' }, // counts missing
      },
    });
    const { tdb, imported } = fakeTdb();
    migrateShards(tdb, ROOT);

    const m = byNumber(imported);
    expect([m[1]!.convergence, m[1]!.failures]).toEqual([2, 3]);
    expect([m[2]!.convergence, m[2]!.failures]).toEqual([0, 0]);
    expect(m[3]!.convergence).toBe(0);
    expect([m[4]!.convergence, m[4]!.failures]).toEqual([0, 0]);
  });

  // ── Dependency sanitizing ─────────────────────────────────────────────
  it('keeps only valid positive integer dependencies', () => {
    setVfs({ pending: { 'T05-x': { '.status': 'PENDING', '.dependencies': '3\n0\n-1\nx\n4\n2.5\n\n' } } });
    const { tdb, imported } = fakeTdb();
    migrateShards(tdb, ROOT);
    expect(imported[0]!.dependsOn).toEqual([3, 4]);
  });

  it('imports an empty dependency list when .dependencies is absent', () => {
    setVfs({ pending: { 'T05-x': { '.status': 'PENDING' } } });
    const { tdb, imported } = fakeTdb();
    migrateShards(tdb, ROOT);
    expect(imported[0]!.dependsOn).toEqual([]);
  });

  // ── Target branch trimming ────────────────────────────────────────────
  it('trims the target branch; blank or missing → null', () => {
    setVfs({
      pending: {
        'T01-a': { '.status': 'PENDING', '.target_branch': '  dev/x \n' },
        'T02-b': { '.status': 'PENDING', '.target_branch': '   ' }, // whitespace only
        'T03-c': { '.status': 'PENDING' }, // absent
      },
    });
    const { tdb, imported } = fakeTdb();
    migrateShards(tdb, ROOT);

    const branch = Object.fromEntries(imported.map(t => [t.taskNumber, t.targetBranch]));
    expect(branch).toEqual({ 1: 'dev/x', 2: null, 3: null });
  });

  // ── Identity / dir ────────────────────────────────────────────────────
  it('records the shard-relative dir and the name captured from the dir regex', () => {
    setVfs({ blocked: { 'T09-keep': { '.status': 'BLOCKED' } } });
    const { tdb, imported } = fakeTdb();
    migrateShards(tdb, ROOT);

    expect(imported[0]!.dir).toBe(join('blocked', 'T09-keep'));
    expect(imported[0]!.name).toBe('keep');
    expect(imported[0]!.taskNumber).toBe(9);
  });

  // ── Idempotency ───────────────────────────────────────────────────────
  it('skips a task whose number is already present and imports the rest', () => {
    setVfs({ pending: { 'T01-a': { '.status': 'PENDING' }, 'T02-b': { '.status': 'PENDING' } } });
    const { tdb, imported } = fakeTdb([1]);

    expect(migrateShards(tdb, ROOT)).toBe(1);
    expect(imported.map(t => t.taskNumber)).toEqual([2]);
  });

  // ── Per-task error isolation ──────────────────────────────────────────
  it('isolates a per-task read error: logs it, skips the dir, imports the others', () => {
    setVfs({
      pending: {
        'T01-good': { '.status': 'PENDING' },
        'T02-bad': { '.status': UNREADABLE }, // exists but throws on read
      },
    });
    const { tdb, imported } = fakeTdb();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(migrateShards(tdb, ROOT)).toBe(1);
    expect(imported.map(t => t.taskNumber)).toEqual([1]);
    expect(errSpy).toHaveBeenCalledOnce();
  });

  // ── Structure / iteration ─────────────────────────────────────────────
  it('skips shard directories that do not exist', () => {
    setVfs({ pending: { 'T01-a': { '.status': 'PENDING' } } }); // only "pending" exists
    const { tdb } = fakeTdb();
    expect(migrateShards(tdb, ROOT)).toBe(1);
  });

  it('ignores entries that are not T<number>- task dirs', () => {
    setVfs({
      pending: {
        'T01-real': { '.status': 'PENDING' },
        'state.db': {},
        '.staging-T01-foo-123': {},
        notes: {},
      },
    });
    const { tdb, imported } = fakeTdb();
    expect(migrateShards(tdb, ROOT)).toBe(1);
    expect(imported.map(t => t.taskNumber)).toEqual([1]);
  });

  it('returns 0 when no shard directories exist', () => {
    setVfs({});
    const { tdb, imported } = fakeTdb();
    expect(migrateShards(tdb, ROOT)).toBe(0);
    expect(imported).toEqual([]);
  });

  // ── max_failures freeze from env ──────────────────────────────────────
  it('freezes a finite max_failures from the environment', () => {
    setVfs({ pending: { 'T01-a': { '.status': 'PENDING' } } });
    const { tdb, imported } = fakeTdb();

    const prev = process.env.ORCH_MAX_FAILURES;
    process.env.ORCH_MAX_FAILURES = '4';
    try { migrateShards(tdb, ROOT); } finally { restoreEnv('ORCH_MAX_FAILURES', prev); }

    expect(imported[0]!.maxFailures).toBe(4);
  });

  it('imports unlimited retries (infinite env) as null max_failures', () => {
    setVfs({ pending: { 'T01-a': { '.status': 'PENDING' } } });
    const { tdb, imported } = fakeTdb();

    const prev = process.env.ORCH_MAX_FAILURES;
    process.env.ORCH_MAX_FAILURES = 'infinite';
    try { migrateShards(tdb, ROOT); } finally { restoreEnv('ORCH_MAX_FAILURES', prev); }

    expect(imported[0]!.maxFailures).toBeNull();
  });
});
