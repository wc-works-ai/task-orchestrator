import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync, cpSync, appendFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, basename, join, dirname } from 'node:path';
import { hostname } from 'node:os';
import {
  Status, inProgress, isInProgress, isActionable,
  CONVERGENCE_THRESHOLD, MAX_FAILURES, statusToShard, SHARDS,
} from './Status.js';

export { Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD, MAX_FAILURES };

// ── File names ──────────────────────────────────────────────────────────────
const F_STATUS   = '.status';
const F_COUNTER  = '.convergence_count';
const F_FAILURES = '.failure_count';
const F_DEPS     = '.dependencies';
const D_CLAIM    = '.claim';
const F_OWNER    = 'owner';
const F_BEAT     = 'heartbeat';
const F_CLAIM_LOCK = '.claim.lock';

// ── Types ───────────────────────────────────────────────────────────────────
export interface TaskInfo {
  readonly directory: string;
  readonly number: number;
  readonly name: string;
  readonly goal: string;
  readonly model: string;
  readonly reasoning: string;
  readonly status: string;
  /** Working directory for benchmarks (worktree root or repo root) */
  readonly cwd: string;
}

export type BenchmarkFn = (task: TaskInfo) => Promise<number> | number;

// ── Result types ────────────────────────────────────────────────────────────
export interface TickResult {
  readonly task: TaskInfo;
  readonly metric: number;
  readonly converged: boolean;
  readonly stopped?: false;
  readonly environmentError?: string;
}

export interface TickNull {
  readonly task: null;
  readonly metric: 0;
  readonly converged: false;
  readonly stopped?: boolean;
  readonly environmentError?: string;
}

// ── Claim types ─────────────────────────────────────────────────────────────
interface ClaimOwner {
  readonly pid: number;
  readonly startedAt: number;
  readonly instanceId: string;
  readonly host: string;
}

// ── TaskState ───────────────────────────────────────────────────────────────
export class TaskState {
  static readonly #cache = new Map<string, Status>();

  #dir: string;

  constructor(dir: string) {
    this.#dir = resolve(dir);
  }

  get directory(): string {
    return this.#dir;
  }

  // ── Identity ────────────────────────────────────────────────────────
  get taskNumber(): number {
    return parseInt(basename(this.#dir).match(/^T(\d+)-/)?.[1] ?? '', 10) || 0;
  }
  get taskName(): string {
    return basename(this.#dir);
  }

  get info(): TaskInfo {
    // Return a materialized plain object (not `this`): callers such as
    // Engine spread it (`{ ...task.info, cwd }`) to run benchmarks in a
    // worktree, and spreading the instance would drop getter-based fields
    // (number, goal, ...), surfacing as `Tundefined` in logs.
    return {
      directory: this.directory,
      number: this.number,
      name: this.name,
      goal: this.goal,
      model: this.model,
      reasoning: this.reasoning,
      status: this.status,
      cwd: this.cwd,
    };
  }
  /** Default cwd — overridden by Engine with actual worktree/repo root */
  get cwd(): string { return this.#dir; }
  get number(): number {
    return this.taskNumber;
  }
  get name(): string {
    return this.taskName;
  }

  // ── Status ──────────────────────────────────────────────────────────
  get status(): Status {
    let raw: string;
    try {
      raw = readFileSync(join(this.#dir, F_STATUS), 'utf-8').trim();
    } catch { return Status.PENDING; }
    if (isInProgress(raw)) return raw as Status;
    if (raw === Status.PENDING || raw === Status.FAILED || raw === Status.BLOCKED || raw === Status.CONVERGED) {
      return raw as Status;
    }
    // Empty, unknown, or corrupted value — recover as PENDING so the task is
    // re-processed instead of being silently stranded in an unrecognized state.
    return Status.PENDING;
  }

  set status(v: Status | string) {
    // Cache stores the base status (PENDING/FAILED/BLOCKED/CONVERGED)
    const cacheBase = isInProgress(v) ? Status.PENDING : (v as Status);
    // Write the status file FIRST — ensures the status is always recorded
    // even if the subsequent shard rename fails.
    const tmp = join(this.#dir, `.status.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${v}\n`);
    renameSync(tmp, join(this.#dir, F_STATUS));
    // Then migrate to the correct shard (best-effort).
    // If the rename fails, the task stays in the old shard with the
    // correct status — pick() still works because it reads the status file.
    const target = statusToShard(v);
    if (target !== basename(dirname(this.#dir))) {
      const root = dirname(dirname(this.#dir));
      const dest = resolve(root, target, basename(this.#dir));
      mkdirSync(dirname(dest), { recursive: true });
      try { renameSync(this.#dir, dest); this.#dir = dest; } catch (err: unknown) {
        /* v8 ignore start: cross-device rename fallback — requires different filesystem mounts */
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          cpSync(this.#dir, dest, { recursive: true });
          rmSync(this.#dir, { recursive: true, force: true });
          this.#dir = dest;
        } else {
          throw err;
        }
        /* v8 ignore stop */
      }
    }
    TaskState.#cache.set(String(this.taskNumber), cacheBase as Status);
  }

  get isPending(): boolean    { return this.status === Status.PENDING; }
  get isConverged(): boolean  { return this.status === Status.CONVERGED; }
  get isFailed(): boolean     { return this.status === Status.FAILED; }
  get isBlocked(): boolean    { return this.status === Status.BLOCKED; }
  get isInProgress(): boolean { return isInProgress(this.status); }
  get isActionable(): boolean { return isActionable(this.status); }

  // ── Convergence ─────────────────────────────────────────────────────
  get convergenceCount(): number {
    try { return TaskState.#nonNegInt(readFileSync(join(this.#dir, F_COUNTER), 'utf-8')); }
    catch { return 0; }
  }
  incrementConvergence(): number {
    const n = this.convergenceCount + 1;
    writeFileSync(join(this.#dir, F_COUNTER), `${n}\n`);
    return n;
  }
  resetConvergence(): void { try { rmSync(join(this.#dir, F_COUNTER)); } catch {} }
  get hasConverged(): boolean {
    return this.convergenceCount >= CONVERGENCE_THRESHOLD;
  }

  // ── Failures ────────────────────────────────────────────────────────
  get failureCount(): number {
    try {
      return TaskState.#nonNegInt(readFileSync(join(this.#dir, F_FAILURES), 'utf-8'));
    } catch {
      return 0;
    }
  }
  incrementFailures(): number {
    const n = this.failureCount + 1;
    writeFileSync(join(this.#dir, F_FAILURES), `${n}\n`);
    return n;
  }

  // ── Dependencies ────────────────────────────────────────────────────
  get dependencies(): readonly number[] {
    try {
      // Tolerate corrupted/garbage lines: keep only valid positive task
      // numbers so a malformed entry can't become a NaN dependency that
      // never resolves (deadlocking the task).
      return readFileSync(join(this.#dir, F_DEPS), 'utf-8')
        .trim().split('\n')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n) && n > 0);
    } catch { return []; }
  }
  set dependencies(nums: readonly number[]) {
    writeFileSync(join(this.#dir, F_DEPS), nums.join('\n') + '\n');
  }

  dependenciesMet(tasksDir: string): boolean {
    for (const d of this.dependencies) {
      // Read from disk — cache is per-process, another process may have changed status
      const depTask = TaskState.#findByNumber(tasksDir, d);
      if (!depTask || depTask.status !== Status.CONVERGED) return false;
    }
    return true;
  }

  hasBlockedDependency(tasksDir: string): boolean {
    for (const d of this.dependencies) {
      // Missing deps still wait; only terminal BLOCKED deps cascade.
      const depTask = TaskState.#findByNumber(tasksDir, d);
      if (depTask?.status === Status.BLOCKED) return true;
    }
    return false;
  }

  /** Parse a counter file's contents into a non-negative integer; any
   *  corrupted/garbage/negative value is treated as 0 so it cannot push a task
   *  into a bogus converged/blocked state. */
  static #nonNegInt(raw: string): number {
    const n = parseInt(raw.trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  static #findByNumber(tasksDir: string, num: number): TaskState | null {
    for (const shard of SHARDS) {
      const shardDir = resolve(tasksDir, shard);
      let entries: string[];
      try { entries = readdirSync(shardDir); } catch { continue; }
      const match = entries.find(e => new RegExp(`^T0*${num}-`).test(e));
      if (match) return new TaskState(resolve(shardDir, match));
    }
    return null;
  }

  // ── Cascade ─────────────────────────────────────────────────────────
  /** Iteratively mark tasks BLOCKED whose dependencies are blocked. */
  static cascadeBlockDependencies(tasksDir: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const shard of ['pending', 'failed'] as const) {
        let entries: string[];
        try { entries = readdirSync(resolve(tasksDir, shard)); } catch { continue; }
        for (const e of entries) {
          if (!e.startsWith('T')) continue;
          const task = new TaskState(resolve(tasksDir, shard, e));
          if (task.isConverged || task.isBlocked || task.isInProgress) continue;
          if (!task.hasBlockedDependency(tasksDir)) continue;
          task.markBlocked();
          changed = true;
        }
      }
    }
  }

  // ── Claim ───────────────────────────────────────────────────────────
  claim(instanceId: string): boolean {
    const p = join(this.#dir, D_CLAIM);
    const lockFile = join(this.#dir, F_CLAIM_LOCK);
    
    // Try atomic claim: create lock file with exclusive write flag
    // Only succeeds if file doesn't exist (atomic operation)
    try {
      writeFileSync(lockFile, `pid:${process.pid}\nstarted:${Date.now()}\ninstance:${instanceId}\nhost:${hostname()}\n`, { flag: 'wx' });
    } catch {
      // Lock file already exists - another process claimed it
      return false;
    }

    // We own the lock now, create the claim directory for metadata
    try { mkdirSync(p); } catch { /* may already exist from previous claim */ }
    writeFileSync(join(p, F_OWNER),
      `pid:${process.pid}\nstarted:${Date.now()}\ninstance:${instanceId}\nhost:${hostname()}\n`);
    writeFileSync(join(p, F_BEAT), '');
    this.status = inProgress(instanceId);
    return true;
  }

  get isClaimed(): boolean { return existsSync(join(this.#dir, D_CLAIM)); }

  get claimOwner(): ClaimOwner | null {
    try {
      const raw = readFileSync(join(this.#dir, D_CLAIM, F_OWNER), 'utf-8');
      return {
        pid:        parseInt(raw.match(/pid:(\d+)/)?.[1] ?? '0', 10),
        startedAt:  parseInt(raw.match(/started:(\d+)/)?.[1] ?? '0', 10),
        instanceId: raw.match(/instance:(.+)/)?.[1] ?? '',
        host:       raw.match(/host:(.+)/)?.[1] ?? '',
      };
    } catch { return null; }
  }

  get claimOwnerId(): string { return this.claimOwner?.instanceId ?? ''; }

  heartbeat(): void {
    try { writeFileSync(join(this.#dir, D_CLAIM, F_BEAT), ''); } catch {}
  }

  release(newStatus: Status = Status.PENDING): void {
    this.status = newStatus;
    try { rmSync(join(this.#dir, D_CLAIM), { recursive: true, force: true }); } catch {}
    try { rmSync(join(this.#dir, F_CLAIM_LOCK), { force: true }); } catch {}
  }

  markBlocked(): void {
    this.release(Status.BLOCKED);
    this.resetConvergence();
  }

  /** Reset a blocked/failed task back to PENDING: clear the claim, zero the
   *  failure count and convergence, and move it to the pending shard so the
   *  loop retries it from scratch. Safe to run while a loop is active — no stop
   *  signal needed, since blocked/failed tasks are not being processed. */
  unblock(): void {
    try { rmSync(join(this.#dir, F_FAILURES)); } catch {}
    this.resetConvergence();
    this.release(Status.PENDING);
  }

  // ── Metadata ────────────────────────────────────────────────────────
  #readAutoresearch(): string {
    try { return readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8'); }
    catch { return ''; }
  }

  get scope(): string[] {
    const c = this.#readAutoresearch();
    if (!c) return [];
    const m = c.match(/^## Scope([\s\S]*?)(?=## |$)/s);
    const raw = m?.[1]?.trim() ?? '';
    return raw ? raw.split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean) : [];
  }

  get goal(): string {
    const c = this.#readAutoresearch();
    if (!c) return this.taskName;
    return (c.match(/^## Goal:?\s*(.+)/m)
         || c.match(/^## Goal\s*\n(.+)/m)
         || [])[1]?.trim() ?? this.taskName;
  }

  get model(): string {
    return this.#readAutoresearch().match(/\*\*Model:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
  }

  get reasoning(): string {
    return this.#readAutoresearch().match(/\*\*Reasoning:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
  }

  get maxFailures(): number {
    const raw = this.#readAutoresearch().match(/\*\*Retry limit:\*\*\s*(.+)/i)?.[1]?.trim() ?? '';
    if (/^(infinite|unlimited|inf)$/i.test(raw)) return Infinity;
    if (!/^\d+$/.test(raw)) return MAX_FAILURES;
    const n = Number(raw);
    return n >= 1 ? n : MAX_FAILURES;
  }

  // ── Static ──────────────────────────────────────────────────────────

  /** Scan active shards (pending, in_progress, failed, blocked) and return a Map of task number → TaskState.
   *  Converged tasks are excluded — they are terminal and counted separately via countConverged(). */
  static async scan(tasksDir: string): Promise<Map<string, TaskState>> {
    TaskState.#cache.clear();
    const all = new Map<string, TaskState>();
    for (const shard of ['pending', 'in_progress', 'failed', 'blocked'] as const) {
      try {
        for (const entry of await readdir(resolve(tasksDir, shard))) {
          const m = entry.match(/^T(\d+)-/);
          if (!m?.[1]) continue;
          const dir = resolve(tasksDir, shard, entry);
          try { await readdir(dir); } catch { continue; } // not a dir
          const t = new TaskState(dir);
          all.set(String(parseInt(m[1], 10)), t);
          TaskState.#cache.set(String(parseInt(m[1], 10)), t.status);
        }
      } catch { /* shard doesn't exist */ }
    }
    return all;
  }

  /** Remove oldest converged task dirs beyond `keep`, archiving summaries to .archive.jsonl.
   *  keep=0 means unlimited (no pruning). */
  static pruneConverged(tasksDir: string, keep: number): void {
    if (keep === 0) return;
    const convergedDir = resolve(tasksDir, 'converged');
    let entries: string[];
    try { entries = readdirSync(convergedDir); } catch { return; }

    const taskDirs = entries
      .filter(e => /^T\d+/.test(e))
      .map(e => ({ name: e, num: parseInt(e.slice(1), 10) }))
      .sort((a, b) => a.num - b.num);

    const toPrune = taskDirs.slice(0, Math.max(0, taskDirs.length - keep));
    for (const { name } of toPrune) {
      const dir = resolve(convergedDir, name);
      const t = new TaskState(dir);
      const summary = JSON.stringify({ T: t.taskNumber, name: t.taskName, goal: t.goal, convergedAt: Date.now() });
      try { appendFileSync(resolve(convergedDir, '.archive.jsonl'), summary + '\n'); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  /** Count total converged tasks: task dirs in converged/ plus lines in .archive.jsonl */
  static countConverged(tasksDir: string): number {
    const convergedDir = resolve(tasksDir, 'converged');
    let dirCount = 0;
    let archiveCount = 0;
    try {
      dirCount = readdirSync(convergedDir).filter(e => /^T\d+/.test(e)).length;
    } catch {}
    try {
      archiveCount = readFileSync(resolve(convergedDir, '.archive.jsonl'), 'utf-8')
        .trim().split('\n').filter(Boolean).length;
    } catch {}
    return dirCount + archiveCount;
  }

  /** Pick the highest-priority actionable task. Returns null if none. */
  static async pick(
    tasksDir: string,
    instanceId: string,
  ): Promise<TaskState | null> {
    for (const shard of ['pending', 'failed', 'in_progress'] as const) {
      let entries: string[];
      try { entries = await readdir(resolve(tasksDir, shard)); }
      catch { continue; }

      const nums = entries
        .map(e => { const m = e.match(/^T(\d+)-/); return m?.[1] ? parseInt(m[1], 10) : 0; })
        .filter(Boolean)
        .sort((a, b) => a - b);

      for (const tn of nums) {
        const dirName = entries.find(e =>
          new RegExp(`^T0*${tn}-`).test(e))!;
        const t = new TaskState(resolve(tasksDir, shard, dirName));

        if (t.isClaimed && !t.isInProgress) {
          try { rmSync(join(t.directory, D_CLAIM), { recursive: true, force: true }); } catch {}
          try { rmSync(join(t.directory, F_CLAIM_LOCK), { force: true }); } catch {}
        }
        if (t.isConverged || t.isBlocked) continue;
        if (t.isFailed && t.failureCount >= t.maxFailures) { t.markBlocked(); continue; }
        if (t.isInProgress) {
          if (!t.isClaimed) { t.release(Status.FAILED); continue; }
          if (t.claimOwnerId !== instanceId) continue;
          return t;
        }
        if (!t.isActionable || !t.dependenciesMet(tasksDir)) continue;
        if (!t.claim(instanceId)) continue;
        return t;
      }
    }
    return null;
  }

  static get statusCache(): ReadonlyMap<string, Status> {
    return TaskState.#cache;
  }
}
