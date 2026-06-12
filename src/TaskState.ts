import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync, cpSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, basename, join, dirname } from 'node:path';
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
}

export interface TickNull {
  readonly task: null;
  readonly metric: 0;
  readonly converged: false;
  readonly stopped?: boolean;
}

// ── Claim types ─────────────────────────────────────────────────────────────
interface ClaimOwner {
  readonly pid: number;
  readonly startedAt: number;
  readonly instanceId: string;
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
    return this;
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
    try {
      const raw = readFileSync(join(this.#dir, F_STATUS), 'utf-8').trim();
      return (raw || Status.PENDING) as Status;
    } catch { return Status.PENDING; }
  }

  set status(v: Status | string) {
    // Cache stores the base status (PENDING/FAILED/BLOCKED/CONVERGED)
    const cacheBase = isInProgress(v) ? Status.PENDING : (v as Status);
    // Write the status file FIRST — ensures the status is always recorded
    // even if the subsequent shard rename fails.
    const tmp = join(this.#dir, F_STATUS + '.tmp');
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
      try { renameSync(this.#dir, dest); this.#dir = dest; } catch {
        /* v8 ignore start: cross-device rename fallback — requires different filesystem mounts */
        // If rename fails (e.g., cross-device), fall back to copy + delete
        cpSync(this.#dir, dest, { recursive: true });
        rmSync(this.#dir, { recursive: true, force: true });
        this.#dir = dest;
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
    try { return parseInt(readFileSync(join(this.#dir, F_COUNTER), 'utf-8').trim(), 10) || 0; }
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
      return parseInt(readFileSync(join(this.#dir, F_FAILURES), 'utf-8').trim(), 10) || 0;
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
      return readFileSync(join(this.#dir, F_DEPS), 'utf-8')
        .trim().split('\n').filter(Boolean).map(Number);
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

  // ── Claim ───────────────────────────────────────────────────────────
  claim(instanceId: string): boolean {
    const p = join(this.#dir, D_CLAIM);
    try { mkdirSync(p); } catch { return false; }
    writeFileSync(join(p, F_OWNER),
      `pid:${process.pid}\nstarted:${Date.now()}\ninstance:${instanceId}\n`);
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
      };
    } catch { return null; }
  }

  get claimOwnerId(): string { return this.claimOwner?.instanceId ?? ''; }

  heartbeat(): void {
    try { writeFileSync(join(this.#dir, D_CLAIM, F_BEAT), ''); } catch {}
  }

  release(newStatus: Status = Status.PENDING): void {
    try { rmSync(join(this.#dir, D_CLAIM), { recursive: true, force: true }); } catch {}
    this.status = newStatus;
  }

  markBlocked(): void {
    this.release(Status.BLOCKED);
    this.resetConvergence();
  }

  // ── Metadata ────────────────────────────────────────────────────────
  get scope(): string[] {
    try {
      const c = readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8');
      const m = c.match(/^## Scope([\s\S]*?)(?=## |$)/s);
      const raw = m?.[1]?.trim() ?? '';
      return raw ? raw.split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  get goal(): string {
    try {
      const c = readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8');
      return (c.match(/^## Goal:?\s*(.+)/m)
           || c.match(/^## Goal\s*\n(.+)/m)
           || [])[1]?.trim() ?? this.taskName;
    } catch { return this.taskName; }
  }

  get model(): string {
    try {
      return readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8')
        .match(/\*\*Model:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
    } catch { return ''; }
  }

  get reasoning(): string {
    try {
      return readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8')
        .match(/\*\*Reasoning:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
    } catch { return ''; }
  }

  get maxFailures(): number {
    try {
      const raw = readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8')
        .match(/\*\*Retry limit:\*\*\s*(.+)/i)?.[1]?.trim() ?? '';
      if (/^(infinite|unlimited|inf)$/i.test(raw)) return Infinity;
      if (!/^\d+$/.test(raw)) return MAX_FAILURES;
      const n = Number(raw);
      return n >= 1 ? n : MAX_FAILURES;
    } catch { return MAX_FAILURES; }
  }

  // ── Static ──────────────────────────────────────────────────────────

  /** Scan all shards and return a Map of task number → TaskState */
  static async scan(tasksDir: string): Promise<Map<string, TaskState>> {
    TaskState.#cache.clear();
    const all = new Map<string, TaskState>();
    for (const shard of SHARDS) {
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
