/**
 * E2E scenario support: extra helpers layered on top of tests/shared/e2e.ts for
 * the merge / block-retry / recovery suites. Kept here (no `.test.` suffix) so
 * the vitest `e2e` project ignores it as a test file but the suites can import it.
 *
 * Two capabilities the base harness doesn't provide:
 *  - direct state.db access, to seed the buggy states these scenarios reproduce
 *    (stale crashed claims, cross-task dependencies, orphaned reconciliation rows);
 *  - scripted agent / benchmark bodies that drive git deterministically — the
 *    agent and benchmark both inherit `process.env`, so they reach the target
 *    repo via ORCH_REPO to advance or conflict the base branch on cue.
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openDb, type Db, type SqlValue } from '../../src/state/sqlite.js';
import { TaskDb, taskDirName, type TaskStatus } from '../../src/state/TaskDb.js';
import { resolveStatePaths } from '../../src/state/StatePaths.js';
import { tasksDirOf } from '../shared/e2e.js';

// ── Raw state DB access ─────────────────────────────────────────────────────
function statePath(stateRoot: string, repo: string): string {
  return join(tasksDirOf(stateRoot, repo), 'state.db');
}

/**
 * Run `fn` against the raw state DB, ensuring the schema exists first. Opening
 * via TaskDb applies the schema (and creates the tasks dir on a fresh root);
 * the raw {@link openDb} handle is then used for arbitrary INSERT/UPDATE that
 * the typed TaskDb API intentionally doesn't expose.
 */
export function withDb<T>(stateRoot: string, repo: string, fn: (db: Db) => T): T {
  const path = statePath(stateRoot, repo);
  TaskDb.open(path).close(); // ensure dir + schema
  const db = openDb(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** UPDATE arbitrary columns of a task row by task number. */
export function setTaskFields(
  stateRoot: string,
  repo: string,
  taskNumber: number,
  fields: Record<string, SqlValue>,
): void {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const assignments = cols.map(c => `${c}=:${c}`).join(', ');
  withDb(stateRoot, repo, db =>
    db.run(`UPDATE tasks SET ${assignments} WHERE task_number=:tn`, { ...fields, tn: taskNumber }),
  );
}

/** Add a dependency edge (taskNumber depends on dependsOn). The CLI `add`
 *  command can't express deps, so the suites wire them straight into the table. */
export function addDependency(stateRoot: string, repo: string, taskNumber: number, dependsOn: number): void {
  withDb(stateRoot, repo, db =>
    db.run('INSERT INTO dependencies (task_number, depends_on) VALUES (?,?)', [taskNumber, dependsOn]),
  );
}

export interface RawTask {
  readonly taskNumber: number;
  readonly name: string;
  readonly dir: string;
  readonly status: TaskStatus;
  readonly convergence?: number;
  readonly failures?: number;
}

/** Insert a task row verbatim (used to seed startup-reconciliation states). */
export function insertRawTask(stateRoot: string, repo: string, t: RawTask): void {
  withDb(stateRoot, repo, db => {
    const now = Date.now();
    db.run(
      `INSERT INTO tasks (task_number, name, dir, status, convergence, failures, created_at, updated_at)
       VALUES (:num,:name,:dir,:status,:conv,:fail,:now,:now)`,
      { num: t.taskNumber, name: t.name, dir: t.dir, status: t.status, conv: t.convergence ?? 0, fail: t.failures ?? 0, now },
    );
  });
}

/** Simulate a worker that claimed the task then crashed: IN_PROGRESS with a
 *  stale heartbeat far in the past. recoverStale() with a small heartbeat window
 *  reclaims it. `convergence` is preserved by recovery, so seed it to assert that. */
export function simulateStaleClaim(
  stateRoot: string,
  repo: string,
  taskNumber: number,
  opts: { convergence?: number; ageMs?: number } = {},
): void {
  const old = Date.now() - (opts.ageMs ?? 3_600_000); // default: an hour ago
  setTaskFields(stateRoot, repo, taskNumber, {
    status: 'IN_PROGRESS',
    claimed_by: 'crashed-worker',
    claim_token: 'crashed-token',
    claimed_at: old,
    heartbeat: old,
    convergence: opts.convergence ?? 0,
  });
}

/** Claim a task as a foreign worker with a FRESH heartbeat — not recoverable,
 *  so it stays IN_PROGRESS (used to prove a dependent task is gated). */
export function holdInProgress(stateRoot: string, repo: string, taskNumber: number): void {
  const now = Date.now();
  setTaskFields(stateRoot, repo, taskNumber, {
    status: 'IN_PROGRESS', claimed_by: 'other-worker', claim_token: 'other-token', claimed_at: now, heartbeat: now,
  });
}

/** Force a task to CONVERGED and clear its lease (simulate a dependency finishing). */
export function markConverged(stateRoot: string, repo: string, taskNumber: number): void {
  setTaskFields(stateRoot, repo, taskNumber, {
    status: 'CONVERGED', claimed_by: null, claim_token: null, claimed_at: null, heartbeat: null,
  });
}

// ── Worktree / branch location (mirrors the Engine's layout) ────────────────
function worktreesRoot(stateRoot: string, repo: string): string {
  return resolveStatePaths({ repo, stateRoot }).worktrees;
}

/** Absolute worktree dir for task `n` named `name` (Engine uses the T0n-name dir). */
export function worktreeDirOf(stateRoot: string, repo: string, n: number, name: string): string {
  return join(worktreesRoot(stateRoot, repo), taskDirName(n, name));
}

/** Branch name the Engine creates for task `n` named `name`. */
export function branchNameOf(n: number, name: string): string {
  return `orchestrator/${taskDirName(n, name)}`;
}

/** True if `branch` exists in `repo`. */
export function branchExists(repo: string, branch: string): boolean {
  return execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf-8' }).trim().length > 0;
}

/** The branch `repo` currently has checked out. */
export function currentBranch(repo: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
}

/** Create a held merge lock (fresh = not stale) so the next merge defers. */
export function holdMergeLock(repo: string): string {
  const lockDir = join(repo, '.orchestrator-merge-lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner'), `pid:0\nhost:e2e\nstarted:${Date.now()}\ntoken:held-by-test\n`);
  return lockDir;
}

// ── Scripted agent / benchmark bodies ───────────────────────────────────────
/**
 * Wrap an exec-agent body with helpers. The agent runs with cwd = worktree and
 * inherits ORCH_REPO, so a body can edit worktree files (`writeWt`) and/or
 * advance the base branch in the target repo (`commitBase`) to stage conflicts.
 */
export function agentScript(body: string): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { execFileSync } from 'node:child_process';",
    'const CWD = process.cwd();',
    'const REPO = process.env.ORCH_REPO;',
    "const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf-8' });",
    'const writeWt = (f, c) => writeFileSync(join(CWD, f), c);',
    'const commitBase = (f, c, msg) => { writeFileSync(join(REPO, f), c); git(\'add\', f); git(\'commit\', \'-m\', msg); };',
    body,
  ].join('\n');
}

/**
 * Wrap a benchmark body. The body sets `metric` (0 = done). Helpers: `exists(f)`
 * tests a file in cwd (worktree during post-agent / pre-merge checks, repo on the
 * initial check); `wtCalls()` counts how many times the benchmark has run in a
 * worktree (used to fire a base-advancing side effect on an exact pre-merge call);
 * `commitBase(f, c, msg)` commits to the target's base branch (advance/conflict it).
 */
export function benchScript(body: string): string {
  return [
    "import { writeFileSync, readFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { execFileSync } from 'node:child_process';",
    'const CWD = process.cwd();',
    'const REPO = process.env.ORCH_REPO;',
    'const DIR = import.meta.dirname;',
    'const exists = (f) => existsSync(join(CWD, f));',
    "const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf-8' });",
    'const writeWt = (f, c) => writeFileSync(join(CWD, f), c);',
    'const commitBase = (f, c, msg) => { writeFileSync(join(REPO, f), c); git(\'add\', f); git(\'commit\', \'-m\', msg); };',
    'const wtCalls = () => { const p = join(DIR, ".wtcalls"); const n = (existsSync(p) ? Number(readFileSync(p, "utf8")) : 0) + 1; writeFileSync(p, String(n)); return n; };',
    'let metric = 1;',
    body,
    'console.log(`METRIC goal=${metric}`);',
  ].join('\n');
}

/** Benchmark: metric 0 once `marker` exists in the cwd. */
export function markerBench(marker = 'landed.txt'): string {
  return benchScript(`if (exists(${JSON.stringify(marker)})) metric = 0;`);
}

/** Agent: drop `marker` in the worktree (orchestrator auto-commits it). */
export function landAgentBody(marker = 'landed.txt'): string {
  return agentScript(`writeWt(${JSON.stringify(marker)}, 'landed by exec agent\\n');`);
}
