import { statSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync, cpSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { TaskState, Status, type BenchmarkFn, type TaskInfo, type TickResult, type TickNull } from './TaskState.js';
import { Worktree, MergeConflictError } from './Worktree.js';
import { env } from './env.js';

const HEARTBEAT_MAX_MS = env.heartbeatMs;

const retryLimitLabel = (limit: number): string => Number.isFinite(limit) ? String(limit) : 'infinite';

export interface SpawnResult {
  readonly success: boolean;
  readonly iterations: number;
  readonly tokenUsage?: TokenUsage;
  readonly authFailure?: boolean;
  readonly error?: string;
  readonly logPath?: string;
}

export type SpawnFn = (task: TaskState, worktreePath?: string, signal?: AbortSignal) => Promise<SpawnResult>;

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

type LogCategory = 'routine' | 'transition' | 'always';
type SleepFn = (ms: number) => Promise<void>;

const sleep: SleepFn = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const MergeRecoveryAction = {
  Stop: 'stop',
  StashAndRetry: 'stash-and-retry',
} as const;
export type MergeRecoveryAction = (typeof MergeRecoveryAction)[keyof typeof MergeRecoveryAction];

export interface MergeRecoveryFailure {
  readonly task: TaskInfo;
  readonly worktreePath: string;
  readonly branch: string;
  readonly error: string;
}

export type MergeRecoveryFn = (failure: MergeRecoveryFailure) => Promise<MergeRecoveryAction> | MergeRecoveryAction;

export interface EngineOptions {
  readonly benchmark?: BenchmarkFn;
  readonly spawn?: SpawnFn;
  readonly mergeRecovery?: MergeRecoveryFn;
  readonly autoStashBeforeMerge?: boolean;
  readonly instanceId?: string;
  readonly repoDir?: string;     // for worktree creation
  readonly worktreesDir?: string; // override default .worktrees/ location
  readonly retryCooldownMs?: number; // min ms between spawn retries (0 = no cooldown, default 30000)
  readonly keepAlive?: boolean;
  readonly infinite?: boolean;
  readonly idleSleepMs?: number;
  readonly sleep?: SleepFn;
  readonly onTick?: (result: TickResult | TickNull, total: number) => void | Promise<void>;
}

export class Engine {
  readonly #dir: string;
  readonly #repo: string;
  readonly #worktreesDir: string | undefined;
  readonly #bench: BenchmarkFn;
  readonly #spawn: SpawnFn | null;
  readonly #mergeRecovery: MergeRecoveryFn | undefined;
  readonly #autoStashBeforeMerge: boolean;
  readonly #id: string;
  readonly #retryCooldownMs: number;
  readonly #keepAlive: boolean;
  readonly #infinite: boolean;
  readonly #idleSleepMs: number;
  readonly #sleep: SleepFn;
  #environmentError?: string;
  /** Track active worktrees by task number */
  readonly #worktrees = new Map<number, Worktree>();
  /** Track last failure time per task for retry cooldown */
  readonly #retryCooldowns = new Map<number, number>();

  constructor(tasksDir: string, opts: EngineOptions = {}) {
    this.#dir = tasksDir;
    this.#repo = opts.repoDir ?? dirname(tasksDir);
    this.#worktreesDir = opts.worktreesDir ?? env.worktreesDir;
    this.#bench = opts.benchmark ?? (() => 1);
    this.#spawn = opts.spawn ?? null;
    this.#mergeRecovery = opts.mergeRecovery;
    this.#autoStashBeforeMerge = opts.autoStashBeforeMerge ?? false;
    this.#id = opts.instanceId ?? `${process.pid}_${Date.now()}`;
    this.#retryCooldownMs = opts.retryCooldownMs ?? 0; // default: no cooldown
    this.#keepAlive = opts.keepAlive ?? env.keepAlive;
    this.#infinite = opts.infinite ?? env.infinite;
    this.#idleSleepMs = opts.idleSleepMs ?? env.idleSleepMs;
    this.#sleep = opts.sleep ?? sleep;
  }

  get instanceId(): string { return this.#id; }
  get environmentError(): string | undefined { return this.#environmentError; }

  #log(msg: string, category: LogCategory = 'routine'): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (env.logLevel !== 'quiet' || category !== 'routine') console.log(`[${ts}] ${msg}`);
    try { appendFileSync(resolve(this.#dir, 'orchestrator.log'), `[${ts}] ${msg}\n`); } catch {}
  }

  get #stopFile(): string { return resolve(this.#dir, '.stop'); }

  // ── Single tick ─────────────────────────────────────────────────────


  async pickByNumber(num: number): Promise<TaskState | null> {
    await TaskState.scan(this.#dir);
    for (const shard of ["pending","in_progress","failed","converged","blocked"]) {
      try { for (const e of readdirSync(resolve(this.#dir, shard))) {
        if (new RegExp(`^T0*${num}-`).test(e)) return new TaskState(resolve(this.#dir, shard, e));
      }} catch {}
    }
    return null;
  }
  async tick(): Promise<TickResult | TickNull> {
    if (existsSync(this.#stopFile)) {
      try { rmSync(this.#stopFile); } catch {}
      return { task: null, metric: 0, converged: false, stopped: true };
    }
    this.#recover();
    await TaskState.scan(this.#dir);
    this.#blockTasksWithBlockedDependencies();

    const task = await TaskState.pick(this.#dir, this.#id);
    if (!task) {
      this.#blockTasksWithBlockedDependencies();
      // Diagnostic: show why nothing was picked
      for (const shard of ['pending', 'in_progress', 'failed', 'blocked'] as const) {
        let entries: string[];
        try { entries = readdirSync(resolve(this.#dir, shard)); } catch { continue; }
        for (const e of entries) {
          if (!e.startsWith('T')) continue;
          const t = new TaskState(resolve(this.#dir, shard, e));
          const tn = `T${t.taskNumber}`;
          if (t.isConverged) continue;
          if (t.isBlocked) {
            this.#log(`${tn}: skipped — blocked (${t.failureCount} failures)`);
            continue;
          }
          if (t.isInProgress && t.isClaimed) {
            const owner = t.claimOwnerId;
            /* c8 ignore start: byUs=true is unreachable — pick() returns our own claims */
            const byUs = owner === this.#id;
            this.#log(`${tn}: skipped — ${byUs ? 'our claim (convergence check)' : `claim held by ${owner.slice(0, 12)}...`}`);
            /* c8 ignore stop */
          } else if (!t.dependenciesMet(this.#dir)) {
            this.#log(`${tn}: skipped — unmet deps [${t.dependencies.join(',')}]`);
          }
        }
      }
      this.#log('No actionable tasks');
      return { task: null, metric: 0, converged: false };
    }

    // Check retry cooldown — if this task failed recently, skip it
    const lastFail = this.#retryCooldowns.get(task.taskNumber);
    if (this.#retryCooldownMs > 0 && lastFail && Date.now() - lastFail < this.#retryCooldownMs) {
      task.release(Status.FAILED);
      this.#log(`T${task.taskNumber}: cooldown (${Date.now() - lastFail}ms < ${this.#retryCooldownMs}ms)`);
      return { task: null, metric: 0, converged: false };
    }

    // Reset worktree on retry so agent starts fresh (discard conflicting changes)
    /* istanbul ignore next: dead code — pick() always sets IN_PROGRESS */
    if (task.isFailed) {
      const wt = this.#worktrees.get(task.taskNumber);
      /* istanbul ignore next */
      if (wt) await wt.resetForRetry();
    }

    let metric = await this.#run(task);
    this.#log(`T${task.taskNumber} check: metric=${metric}${metric === 0 ? ' (done)' : ' (needs work; target is 0)'}`);

    if (metric === 0) return await this.#handleZero(task, metric);

    // Non-zero: try spawner if available
    task.resetConvergence();

    if (this.#spawn) {
      let wt = this.#worktrees.get(task.taskNumber) ?? null;
      if (!wt && existsSync(resolve(this.#repo, '.git'))) {
        wt = new Worktree(this.#repo, { name: task.taskName, ...(this.#worktreesDir ? { worktreesDir: this.#worktreesDir } : {}) });
        await wt.create();
        this.#worktrees.set(task.taskNumber, wt);
      }
      let spawnTask = task;
      if (wt) {
        // Copy task directory into worktree (tasks/ not tracked in git)
        const wtTaskDir = this.#taskDirectoryInWorktree(task, wt.path);
        try {
          cpSync(task.directory, wtTaskDir, { recursive: true, filter: (f: string) => !f.endsWith('agent.log') });
          spawnTask = new TaskState(wtTaskDir);
        } catch {}
        // Copy node_modules for isolated npm commands (no symlink — avoids circular chain risk)
        const wtNm = join(wt.path, 'node_modules');
        if (!existsSync(wtNm)) {
          try { cpSync(join(this.#repo, 'node_modules'), wtNm, { recursive: true }); } catch {}
        }
      }
      const ac = new AbortController();
      let hb: ReturnType<typeof setInterval> | undefined;
      try {
        this.#log(`T${task.taskNumber} action: starting agent because metric is ${metric}`);
        /* c8 ignore start */
        hb = setInterval(() => {
          task.heartbeat();
          if (existsSync(this.#stopFile)) {
            ac.abort();
          }
        }, 30_000);
        /* c8 ignore stop */
        const spawnResult = await this.#spawn(spawnTask, wt?.path, ac.signal);
        this.#log(
          `T${task.taskNumber} agent ${spawnResult.success ? 'finished' : 'stopped without finishing'} ` +
          `(${this.#experimentLabel(spawnResult.iterations)}` +
          `${spawnResult.tokenUsage ? `; tokens: ${this.#tokenUsageLabel(spawnResult.tokenUsage)}` : ''}` +
          `${spawnResult.error ? `; reason: ${this.#singleLine(spawnResult.error)}` : ''}` +
          `${spawnResult.logPath ? `; details: ${spawnResult.logPath}` : ''})`,
        );
        if (spawnResult.authFailure) {
          return this.#handleEnvironmentalFailure(task, metric, spawnResult.error ?? 'coding agent authentication failed');
        }
        metric = await this.#run(task, wt?.path);
        this.#log(`T${task.taskNumber} check after agent: metric=${metric}${metric === 0 ? ' (done)' : ' (still needs work)'}`);
        if (metric === 0) return await this.#handleZero(task, metric, wt);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('conflict')) {
          task.status = Status.FAILED;
          this.#retryCooldowns.set(task.taskNumber, Date.now());
          console.error(`  ⚠️  T${task.taskNumber}: merge conflict — task FAILED, worktree kept for inspection`);
        }
      } finally {
        if (hb) clearInterval(hb);
      }
    }

    return this.#handleFailure(task, metric);
  }

  // ── Loop ────────────────────────────────────────────────────────────

  async loop(opts: EngineOptions = {}): Promise<number> {
    let total = 0;
    const keepAlive = opts.keepAlive ?? this.#keepAlive;
    const infinite = opts.infinite ?? this.#infinite;
    const idleSleepMs = opts.idleSleepMs ?? this.#idleSleepMs;
    const sleepFn = opts.sleep ?? this.#sleep;
    let announcedIdle = false;
    while (true) {
      const result = await this.tick();
      if (result.stopped) break;
      if (!result.task) {
        if (infinite) {
          if (!announcedIdle) {
            this.#log('idle: waiting for new tasks or for blocked/failed tasks to be addressed (infinite mode; --stop to exit)');
            announcedIdle = true;
          }
          await sleepFn(idleSleepMs);
          continue;
        }
        if (!keepAlive || await this.#isRunComplete()) break;
        await sleepFn(idleSleepMs);
        continue;
      }
      announcedIdle = false;
      total++;
      if (opts.onTick) await opts.onTick(result, total);
    }
    return total;
  }

  // ── Private ──────────────────────────────────────────────────────────

  async #handleZero(task: TaskState, metric: number, wt: Worktree | null = null): Promise<TickResult> {
    task.incrementConvergence();
    if (task.hasConverged) {
      // Use passed worktree or look up from map (for subsequent ticks after spawn)
      const tree = wt ?? this.#worktrees.get(task.taskNumber) ?? null;
      if (tree) {
        try {
          await this.#mergeAndRemove(task, tree);
        } catch (e: unknown) {
          if (e instanceof MergeConflictError) {
            // Park the task as-is: keep its branch, do not rerun. The fleet keeps
            // going; the branch can be merged once the block is released.
            task.markBlocked();
            this.#log(`T${task.taskNumber} merge conflict; task BLOCKED; branch ${tree.branch} kept to merge after release`, 'transition');
            return { task: task.info, metric, converged: false };
          }
          const recovered = await this.#recoverMergeFailure(task, tree, e);
          if (!recovered) return { task: task.info, metric, converged: false };
        }
      }
      task.status = Status.CONVERGED;
      this.#log(`T${task.taskNumber} CONVERGED`, 'transition');
      return { task: task.info, metric, converged: true };
    }
    return { task: task.info, metric, converged: false };
  }

  async #mergeAndRemove(task: TaskState, wt: Worktree): Promise<void> {
    if (this.#autoStashBeforeMerge) {
      const stashed = await wt.stashParentChanges(`orchestrator ${task.taskName} pre-merge`);
      if (stashed) this.#log(`T${task.taskNumber} stashed parent repo changes before merge`);
    }
    await wt.merge();
    await wt.remove();
    this.#worktrees.delete(task.taskNumber);
  }

  async #recoverMergeFailure(task: TaskState, wt: Worktree, e: unknown): Promise<boolean> {
    const detail = this.#singleLine(e instanceof Error ? e.message : String(e));
    let action: MergeRecoveryAction;
    try {
      action = this.#mergeRecovery
        ? await this.#mergeRecovery({
          task: task.info,
          worktreePath: wt.path,
          branch: wt.branch,
          error: detail,
        })
        : MergeRecoveryAction.Stop;
    } catch (recoveryError: unknown) {
      this.#handleMergeFailure(task, recoveryError, 'merge recovery failed');
      return false;
    }

    if (action === MergeRecoveryAction.StashAndRetry) {
      try {
        const stashed = await wt.stashParentChanges(`orchestrator ${task.taskName} merge recovery`);
        this.#log(`T${task.taskNumber} ${stashed ? 'stashed parent repo changes' : 'found no parent repo changes to stash'}; retrying merge`);
        await this.#mergeAndRemove(task, wt);
        return true;
      } catch (retryError: unknown) {
        this.#handleMergeFailure(task, retryError, 'after auto-stash');
        return false;
      }
    }

    this.#handleMergeFailure(task, e);
    return false;
  }

  #handleMergeFailure(task: TaskState, e: unknown, context = ''): void {
    const detail = this.#singleLine(e instanceof Error ? e.message : String(e));
    const reason = context ? `${context}: ${detail}` : detail;
    task.markBlocked();
    this.#retryCooldowns.set(task.taskNumber, Date.now());
    this.#log(`T${task.taskNumber} merge failed: ${reason}; task BLOCKED; worktree kept for inspection`, 'transition');
  }

  async #isRunComplete(): Promise<boolean> {
    const all = await TaskState.scan(this.#dir);
    for (const task of all.values()) {
      if (!task.isConverged && !task.isBlocked) return false;
    }
    return true;
  }

  #taskDirectoryInWorktree(task: TaskState, worktreePath: string): string {
    return resolve(worktreePath, relative(this.#repo, task.directory));
  }

  #handleFailure(task: TaskState, metric: number): TickResult {
    const failures = task.incrementFailures();
    const limit = task.maxFailures;
    const limitLabel = retryLimitLabel(limit);
    this.#retryCooldowns.set(task.taskNumber, Date.now());
    if (failures >= limit) {
      task.markBlocked();
      this.#log(`T${task.taskNumber} stopping: metric is still ${metric} after ${failures}/${limitLabel} failed attempts; no retries left`, 'transition');
    } else {
      task.release(Status.FAILED);
      this.#log(`T${task.taskNumber} retrying: metric is still ${metric} (failed attempt ${failures}/${limitLabel})`);
    }
    return { task: task.info, metric, converged: false };
  }

  #blockTasksWithBlockedDependencies(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const shard of ['pending', 'failed'] as const) {
        let entries: string[];
        try { entries = readdirSync(resolve(this.#dir, shard)); } catch { continue; }
        for (const e of entries) {
          if (!e.startsWith('T')) continue;
          const task = new TaskState(resolve(this.#dir, shard, e));
          if (task.isConverged || task.isBlocked || task.isInProgress) continue;
          if (!task.hasBlockedDependency(this.#dir)) continue;
          task.markBlocked();
          this.#log(`T${task.taskNumber} BLOCKED — dependency is blocked; cannot converge`, 'transition');
          changed = true;
        }
      }
    }
  }

  /**
   * Task-agnostic / environment failure (e.g. a missing API key). The task is
   * fine, so do NOT consume a retry. The same problem would hit every task, so
   * stop the whole run immediately (fail fast) instead of churning the rest of
   * the queue into FAILED. The detecting task is left FAILED so a rerun resumes
   * it once the environment is fixed.
   */
  #handleEnvironmentalFailure(task: TaskState, _metric: number, reason: string): TickNull {
    const detail = this.#singleLine(reason);
    this.#environmentError = detail;
    task.release(Status.FAILED);
    this.#log(`T${task.taskNumber} environment issue: ${detail} — stopping run (fail fast); not counted against retries; fix and rerun`, 'transition');
    return { task: null, metric: 0, converged: false, stopped: true, environmentError: detail };
  }

  #experimentLabel(count: number): string {
    return count === 1 ? '1 progress record' : `${count} progress records`;
  }

  #tokenUsageLabel(usage: TokenUsage): string {
    return `total=${usage.totalTokens} input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`;
  }

  #singleLine(value: string): string {
    return value.replace(/\s+/g, ' ').slice(0, 200);
  }

  async #run(task: TaskState, worktreePath?: string): Promise<number> {
    try {
      const info = worktreePath
        ? { ...task.info, directory: this.#taskDirectoryInWorktree(task, worktreePath), cwd: worktreePath }
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
      const pid = this.#ownerPid(task);
      if (pid !== null && this.#alive(pid)) {
        // Process alive — respect heartbeat timeout
        const age = this.#heartbeatAge(task);
        if (age !== null && age < HEARTBEAT_MAX_MS) continue;
        // Stale heartbeat but alive PID — skip (long-running op)
        continue;
      }
      // Owner dead or unknown — release immediately, preserve convergence
      task.release(Status.FAILED);
      this.#log(`STALE: ${task.taskName} claim released (convergence=${task.convergenceCount})`);
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
