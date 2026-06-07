import { statSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TaskState, Status, type BenchmarkFn, type TickResult, type TickNull } from './TaskState.js';

const HEARTBEAT_MAX_MS = 300_000;

export interface SpawnResult {
  readonly success: boolean;
  readonly iterations: number;
}

export type SpawnFn = (task: TaskState) => Promise<SpawnResult>;

export interface EngineOptions {
  readonly benchmark?: BenchmarkFn;
  readonly spawn?: SpawnFn;
  readonly instanceId?: string;
  readonly onTick?: (result: TickResult | TickNull, total: number) => void | Promise<void>;
}

export class Engine {
  readonly #dir: string;
  readonly #bench: BenchmarkFn;
  readonly #spawn: SpawnFn | null;
  readonly #id: string;

  constructor(tasksDir: string, opts: EngineOptions = {}) {
    this.#dir = tasksDir;
    this.#bench = opts.benchmark ?? (() => 1);
    this.#spawn = opts.spawn ?? null;
    this.#id = opts.instanceId ?? `${process.pid}_${Date.now()}`;
  }

  get instanceId(): string { return this.#id; }

  // ── Single tick ─────────────────────────────────────────────────────

  async tick(): Promise<TickResult | TickNull> {
    this.#recover();
    await TaskState.scan(this.#dir);

    const task = await TaskState.pick(this.#dir, this.#id);
    if (!task) return { task: null, metric: 0, converged: false };

    let metric = await this.#run(task);

    if (metric === 0) return this.#handleZero(task, metric);

    // Non-zero: try spawner if available
    task.resetConvergence();

    if (this.#spawn) {
      try {
        await this.#spawn(task);
      } catch { /* spawn errors are non-fatal */ }
      metric = await this.#run(task);
      if (metric === 0) return this.#handleZero(task, metric);
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

  #handleZero(task: TaskState, metric: number): TickResult {
    task.incrementConvergence();
    if (task.hasConverged) {
      task.status = Status.CONVERGED;
      return { task: task.info, metric, converged: true };
    }
    return { task: task.info, metric, converged: false };
  }

  async #run(task: TaskState): Promise<number> {
    try { return await this.#bench(task.info); }
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
