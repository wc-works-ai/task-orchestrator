import { statSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { TaskState, Status, type BenchmarkFn, type TickResult, type TickNull } from './TaskState.js';
import { Worktree } from './Worktree.js';

const HEARTBEAT_MAX_MS = parseInt(process.env.ORCH_HEARTBEAT_MS ?? '300000', 10);

export interface SpawnResult {
  readonly success: boolean;
  readonly iterations: number;
}

export type SpawnFn = (task: TaskState, worktreePath?: string) => Promise<SpawnResult>;

export interface EngineOptions {
  readonly benchmark?: BenchmarkFn;
  readonly spawn?: SpawnFn;
  readonly instanceId?: string;
  readonly repoDir?: string;     // for worktree creation
  readonly onTick?: (result: TickResult | TickNull, total: number) => void | Promise<void>;
}

export class Engine {
  readonly #dir: string;
  readonly #repo: string;
  readonly #bench: BenchmarkFn;
  readonly #spawn: SpawnFn | null;
  readonly #id: string;
  /** Track active worktrees by task number */
  readonly #worktrees = new Map<number, Worktree>();

  constructor(tasksDir: string, opts: EngineOptions = {}) {
    this.#dir = tasksDir;
    this.#repo = opts.repoDir ?? dirname(tasksDir);
    this.#bench = opts.benchmark ?? (() => 1);
    this.#spawn = opts.spawn ?? null;
    this.#id = opts.instanceId ?? `${process.pid}_${Date.now()}`;
  }

  get instanceId(): string { return this.#id; }

  get #stopFile(): string { return resolve(this.#dir, '.stop'); }

  // ── Single tick ─────────────────────────────────────────────────────

  async tick(): Promise<TickResult | TickNull> {
    if (existsSync(this.#stopFile)) {
      try { rmSync(this.#stopFile); } catch {}
      return { task: null, metric: 0, converged: false };
    }
    this.#recover();
    await TaskState.scan(this.#dir);

    const task = await TaskState.pick(this.#dir, this.#id);
    if (!task) return { task: null, metric: 0, converged: false };

    // Reset worktree on retry so agent starts fresh (discard conflicting changes)
    /* c8 ignore next 4 */
    if (task.isFailed) {
      const wt = this.#worktrees.get(task.taskNumber);
      if (wt) await wt.resetForRetry();
    }

    let metric = await this.#run(task);

    if (metric === 0) return this.#handleZero(task, metric);

    // Non-zero: try spawner if available
    task.resetConvergence();

    if (this.#spawn) {
      let wt = this.#worktrees.get(task.taskNumber) ?? null;
      if (!wt && existsSync(resolve(this.#repo, '.git'))) {
        wt = new Worktree(this.#repo, { name: task.taskName });
        await wt.create();
        this.#worktrees.set(task.taskNumber, wt);
      }
      try {
        const hb = setInterval(() => task.heartbeat(), 30_000);
        await this.#spawn(task, wt?.path);
        clearInterval(hb);
        metric = await this.#run(task, wt?.path);
        if (metric === 0) return this.#handleZero(task, metric, wt);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('conflict')) {
          task.status = Status.FAILED;
          console.error(`  ⚠️  T${task.taskNumber}: merge conflict — task FAILED, worktree kept for inspection`);
        }
      }
    }

    task.release(Status.FAILED);
    return { task: task.info, metric, converged: false };
  }

  // ── Loop ────────────────────────────────────────────────────────────

  async loop(opts: EngineOptions = {}): Promise<number> {
    let total = 0;
    while (true) {
      const result = await this.tick();
      if (!result.task) break;
      total++;
      if (opts.onTick) await opts.onTick(result, total);
    }
    return total;
  }

  // ── Private ──────────────────────────────────────────────────────────

  #handleZero(task: TaskState, metric: number, wt: Worktree | null = null): TickResult {
    task.incrementConvergence();
    if (task.hasConverged) {
      task.status = Status.CONVERGED;
      // Use passed worktree or look up from map (for subsequent ticks after spawn)
      const tree = wt ?? this.#worktrees.get(task.taskNumber) ?? null;
      if (tree) { this.#mergeAndRemove(task.taskNumber, tree, task.scope); }
      return { task: task.info, metric, converged: true };
    }
    return { task: task.info, metric, converged: false };
  }

  async #mergeAndRemove(tn: number, wt: Worktree, scope?: string[]): Promise<void> {
    try { await wt.merge(scope); await wt.remove(); } catch { /* leave for inspection */ }
    this.#worktrees.delete(tn);
  }

  async #run(task: TaskState, worktreePath?: string): Promise<number> {
    try {
      const info = worktreePath
        ? { ...task.info, directory: resolve(worktreePath, task.directory.replace(this.#repo, '')) }
        : task.info;
      return await this.#bench(info);
    }
    catch { return 1; }
  }

  #recover(): void {
    const dir = resolve(this.#dir, 'in_progress');
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }

    for (const e of entries) {
      if (!e.startsWith('T')) continue;
      const task = new TaskState(resolve(dir, e));
      if (!task.isInProgress || !task.isClaimed) continue;
      const age = this.#heartbeatAge(task);
      if (age === null || age < HEARTBEAT_MAX_MS) continue;
      const pid = this.#ownerPid(task);
      if (pid !== null && this.#alive(pid)) continue;
      task.release(Status.FAILED);
      task.resetConvergence();
    }
  }

  #heartbeatAge(task: TaskState): number | null {
    try { return Date.now() - statSync(join(task.directory, '.claim', 'heartbeat')).mtimeMs; }
    catch { return null; }
  }

  #ownerPid(task: TaskState): number | null {
    try {
      const raw = readFileSync(join(task.directory, '.claim', 'owner'), 'utf-8');
      return parseInt(raw.match(/pid:(\d+)/)?.[1] ?? '', 10) || null;
    } catch { return null; }
  }

  #alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
}
