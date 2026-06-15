import { readFileSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync, appendFileSync, cpSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { TaskState, Status, type BenchmarkFn, type TaskInfo, type TickResult, type TickNull } from '../state/TaskState.js';
import { TaskDb } from '../state/TaskDb.js';
import { migrateShards } from '../state/migrate.js';
import { Worktree, MergeConflictError } from './Worktree.js';
import { env } from '../shared/env.js';
import type { BenchmarkOutcome } from '../shared/metrics.js';
import { handleOrchestratorError, type Logger } from '../shared/errors.js';
import type { SpawnFn, TokenUsage } from '../agent/CodingAgent.js';

// Re-export contract types so external importers keep working
export type { SpawnResult, SpawnFn, TokenUsage } from '../agent/CodingAgent.js';

const MAX_CONSECUTIVE_TICK_ERRORS = 10;

const retryLimitLabel = (limit: number): string => Number.isFinite(limit) ? String(limit) : 'infinite';

type LogCategory = 'routine' | 'transition' | 'always';
type SleepFn = (ms: number) => Promise<void>;

/** Why loop() returned. 'signal' = --stop/.stop (intentional); 'environment' =
 *  fatal, run-wide failure (e.g. auth, repeated tick errors); 'complete' = all
 *  tasks reached a terminal state (non-infinite/keep-alive). */
export type StopReason = 'signal' | 'environment' | 'complete';

/** Result of attempting to merge a converged task back to its base branch.
 *  'blocked' = the post-sync benchmark was a defect (crash/no_metrics); the task
 *  is BLOCKED rather than merged on an unreliable result. */
type MergeOutcome = 'merged' | 'locked' | 'rework' | 'blocked';

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
  readonly verifyCmd?: string; // shell command run in worktree before merge (e.g. 'npm run tc')
  readonly instanceId?: string;
  readonly repoDir?: string;     // for worktree creation
  readonly worktreesDir?: string; // override default .worktrees/ location
  readonly noWorktree?: boolean; // skip worktree/git — agent works directly in main repo
  readonly retryCooldownMs?: number; // min ms between spawn retries (0 = no cooldown, default 30000)
  readonly keepAlive?: boolean;
  readonly infinite?: boolean;
  readonly idleSleepMs?: number;
  readonly parallel?: number;
  readonly sleep?: SleepFn;
  readonly onTick?: (result: TickResult | TickNull, total: number) => void | Promise<void>;
  readonly keepConverged?: number;
  /** Inject a shared state DB (tests). When provided, the Engine does not own
   *  it and will not close it; otherwise it opens `<tasksDir>/state.db`. */
  readonly taskDb?: TaskDb;
}

export class Engine {
  readonly #dir: string;
  readonly #repo: string;
  readonly #worktreesDir: string | undefined;
  readonly #noWorktree: boolean;
  readonly #bench: BenchmarkFn;
  readonly #spawn: SpawnFn | null;
  readonly #mergeRecovery: MergeRecoveryFn | undefined;
  readonly #autoStashBeforeMerge: boolean;
  readonly #verifyCmd: string | undefined;
  readonly #id: string;
  readonly #retryCooldownMs: number;
  readonly #keepAlive: boolean;
  readonly #infinite: boolean;
  readonly #idleSleepMs: number;
  readonly #parallel: number;
  readonly #keepConverged: number;
  readonly #sleep: SleepFn;
  readonly #baseBranch: string;
  readonly #tdb: TaskDb;
  readonly #ownsTdb: boolean;
  readonly #logger: Logger;
  #disposed = false;
  #reconciled = false;
  #environmentError?: string;
  #stopReason?: StopReason;
  /** Track active worktrees by task number */
  readonly #worktrees = new Map<number, Worktree>();
  /** Track last failure time per task for retry cooldown */
  readonly #retryCooldowns = new Map<number, number>();
  /** In-process guard: task numbers currently being processed by a worker.
   *  Ensures one process never runs the same task's lifecycle twice at once.
   *  Not a lock — a busy task is simply skipped this cycle. */
  readonly #owned = new Set<number>();
  #currentLockToken: string | null = null;

  constructor(tasksDir: string, opts: EngineOptions = {}) {
    this.#dir = tasksDir;
    this.#repo = opts.repoDir ?? dirname(tasksDir);
    this.#worktreesDir = opts.worktreesDir ?? env.worktreesDir;
    this.#noWorktree = opts.noWorktree ?? env.noWorktree;
    this.#bench = opts.benchmark ?? (() => 1);
    this.#spawn = opts.spawn ?? null;
    this.#mergeRecovery = opts.mergeRecovery;
    this.#autoStashBeforeMerge = opts.autoStashBeforeMerge ?? env.autoStash;
    this.#verifyCmd = opts.verifyCmd ?? env.verifyCmd;
    this.#id = opts.instanceId ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
    this.#retryCooldownMs = opts.retryCooldownMs ?? 0; // default: no cooldown
    this.#keepAlive = opts.keepAlive ?? env.keepAlive;
    this.#infinite = opts.infinite ?? env.infinite;
    this.#idleSleepMs = opts.idleSleepMs ?? env.idleSleepMs;
    this.#parallel = opts.parallel ?? env.parallelTasks;
    this.#keepConverged = opts.keepConverged ?? env.keepConverged;
    this.#sleep = opts.sleep ?? sleep;
    this.#ownsTdb = opts.taskDb === undefined;
    this.#tdb = opts.taskDb ?? TaskDb.open(resolve(tasksDir, 'state.db'));
    this.#logger = {
      warn: (msg: string) => this.#log(msg, 'always'),
      error: (msg: string) => this.#log(msg, 'always'),
    };
    this.#baseBranch = this.#detectBaseBranch();
  }

  get instanceId(): string { return this.#id; }
  get environmentError(): string | undefined { return this.#environmentError; }
  get stopReason(): StopReason | undefined { return this.#stopReason; }
  get baseBranch(): string { return this.#baseBranch; }
  get taskDb(): TaskDb { return this.#tdb; }

  /** Release the owned state DB handle (no-op when the DB was injected). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ownsTdb) this.#tdb.close();
  }

  #detectBaseBranch(): string {
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.#repo, encoding: 'utf-8' }).trim();
      if (!branch || branch === 'HEAD') return 'master';
      return branch;
    } catch {
      return 'master';
    }
  }

  #log(msg: string, category: LogCategory = 'routine'): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (env.logLevel !== 'quiet' || category !== 'routine') console.log(`[${ts}] ${msg}`);
    try {
      appendFileSync(resolve(this.#dir, 'orchestrator.log'), `[${ts}] ${msg}\n`);
    }
    /* v8 ignore start -- append failures depend on filesystem faults */
    catch (e: unknown) {
      console.error(`[${ts}] failed to append orchestrator.log: ${this.#errorDetail(e)}`);
    }
    /* v8 ignore stop */
  }

  get #stopFile(): string { return resolve(this.#dir, '.stop'); }

  // ── Single tick ─────────────────────────────────────────────────────


  pickByNumber(num: number): TaskState | null {
    return TaskState.pickByNumber(this.#tdb, this.#dir, num);
  }
  async tick(): Promise<TickResult | TickNull> {
    if (existsSync(this.#stopFile)) {
      try {
        rmSync(this.#stopFile);
      }
      /* v8 ignore start -- stop-file cleanup failures depend on filesystem faults */
      catch (e: unknown) {
        this.#bestEffortFailure(`failed to remove stop file ${this.#stopFile}`, e);
      }
      /* v8 ignore stop */
      return { task: null, metric: 0, converged: false, stopped: true };
    }
    this.#reconcileOnce();
    // Recover stale claims (dead/crashed workers), then block tasks that have
    // exhausted their retries and cascade blocks to their dependents — all
    // before picking, so the queue reflects reality this tick.
    this.#tdb.recoverStale(Date.now() - env.heartbeatMs);
    this.#blockExhausted();
    this.#tdb.cascadeBlock();

    // Prefer finishing our own in-progress tasks (pick() never returns them) so
    // convergence completes before new work starts, minimizing merge conflicts.
    const task = this.#continueOwned() ?? TaskState.pick(this.#tdb, this.#dir, this.#id);
    if (!task) {
      this.#logIdle();
      return { task: null, metric: 0, converged: false };
    }

    this.#owned.add(task.taskNumber);
    try {
      this.#log(`T${task.taskNumber} | picked up | ${this.#singleLine(task.goal)}`, 'transition');

      // Check retry cooldown — if this task failed recently, skip it
      const lastFail = this.#retryCooldowns.get(task.taskNumber);
      if (this.#retryCooldownMs > 0 && lastFail && Date.now() - lastFail < this.#retryCooldownMs) {
        task.release(Status.FAILED);
        this.#log(`T${task.taskNumber}: cooldown (${Date.now() - lastFail}ms < ${this.#retryCooldownMs}ms)`);
        return { task: null, metric: 0, converged: false };
      }

      const ac = new AbortController();
      /* c8 ignore start */
      const hb = setInterval(() => {
        task.heartbeat();
        if (existsSync(this.#stopFile)) {
          ac.abort();
        }
      }, 30_000);
      /* c8 ignore stop */
      try {
        // Reconnect to worktree from a previous process if needed (B2 fix).
        // Only attempt reconnection when there's evidence a worktree should
        // exist: convergence > 0 means the agent already achieved metric=0
        // in a prior tick, so a worktree was created. Without this gate,
        // fresh tasks would prematurely create worktrees via #tryReconnectWorktree.
        if (!this.#noWorktree && !this.#worktrees.has(task.taskNumber) && this.#spawn
            && existsSync(resolve(this.#repo, '.git'))
            && task.convergenceCount > 0) {
          const reconnected = this.#tryReconnectWorktree(task);
          if (reconnected) {
            this.#log(`T${task.taskNumber} reconnected to worktree from previous process`);
          } else {
            task.resetConvergence();
            this.#log(`T${task.taskNumber} worktree not found, convergence reset`, 'transition');
          }
        }

        // Use the existing worktree (from this tick or reconnected) so
        // convergence checks measure the agent's work — not the main repo.
        const existingWt = this.#worktrees.get(task.taskNumber);
        const checkCwd = existingWt?.path ?? this.#repo;
        this.#log(`T${task.taskNumber} | checking | running benchmark in ${existingWt ? 'worktree' : 'repo'}`);
        const checkOutcome = await this.#run(task, checkCwd);
        if (checkOutcome.kind !== 'ok') {
          this.#handleBenchmarkDefect(task, checkOutcome);
          return { task: task.info, metric: checkOutcome.total, converged: false };
        }
        let metric = checkOutcome.total;
        this.#log(`T${task.taskNumber} check: metric=${metric}${metric === 0 ? ' (done)' : ' (needs work; target is 0)'}`);

        if (metric === 0) return await this.#handleZero(task, metric);

        // Non-zero: try spawner if available
        task.resetConvergence();

        if (this.#spawn) {
          try {
            const wt = await this.#prepareWorktree(task);
            const cycle = await this.#runSpawnCycle(task, wt, metric, ac.signal);
            if (cycle === null) return { task: null, metric: 0, converged: false, stopped: true, ...(this.#environmentError !== undefined && { environmentError: this.#environmentError }) };
            if (cycle.kind !== 'ok') {
              this.#handleBenchmarkDefect(task, cycle);
              return { task: task.info, metric: cycle.total, converged: false };
            }
            metric = cycle.total;
            if (metric === 0) return await this.#handleZero(task, metric, wt);
          } catch (e: unknown) {
            const msg = this.#errorDetail(e);
            if (msg.includes('conflict')) {
              this.#retryCooldowns.set(task.taskNumber, Date.now());
              console.error(`  ⚠️  T${task.taskNumber}: merge conflict — task FAILED, worktree kept for inspection`);
            } else {
              this.#log(`T${task.taskNumber} unexpected error during spawn/worktree setup: ${this.#singleLine(msg)}; releasing task`, 'transition');
            }
          }
        }

        return this.#handleFailure(task, metric);
      } finally {
        clearInterval(hb);
      }
    } finally {
      // Release only after the lifecycle and any shard transition have fully
      // settled, so a later cycle cannot re-pick a half-moved task.
      this.#owned.delete(task.taskNumber);
    }
  }

  // ── Loop ────────────────────────────────────────────────────────────

  async loop(opts: EngineOptions = {}): Promise<number> {
    let total = 0;
    const keepAlive = opts.keepAlive ?? this.#keepAlive;
    const infinite = opts.infinite ?? this.#infinite;
    const idleSleepMs = opts.idleSleepMs ?? this.#idleSleepMs;
    const sleepFn = opts.sleep ?? this.#sleep;
    const parallel = opts.parallel ?? this.#parallel;
    let announcedIdle = false;
    let consecutiveErrors = 0;
    let lastErrorMsg = '';
    try {
      while (true) {
        try {
          // Determine how many concurrent ticks to spawn
          // If parallel=0 (unlimited), spawn at most 100 ticks to avoid file system thrashing
          // Otherwise spawn up to the parallel limit
          const tickCount = parallel === 0 ? 100 : parallel;

          // Run up to `tickCount` ticks concurrently
          const tickPromises: Promise<TickResult | TickNull>[] = [];
          for (let i = 0; i < tickCount; i++) {
            tickPromises.push(this.tick());
          }
          const results = await Promise.all(tickPromises);
          consecutiveErrors = 0;

          // Stop signal (.stop / --stop) or a fatal run-wide failure surfaced by a tick.
          if (results.some(r => r.stopped)) {
            this.#stopReason = this.#environmentError ? 'environment' : 'signal';
            break;
          }

          // Count tasks that completed and check if we're idle
          const tasksCompleted = results.filter(r => r.task !== null);
          const anyTaskCompleted = tasksCompleted.length > 0;

          if (!anyTaskCompleted) {
            if (infinite) {
              if (!announcedIdle) {
                this.#log(`idle: waiting for new tasks or for blocked/failed tasks to be addressed (infinite mode; polling every ${idleSleepMs}ms; --stop to exit)`);
                announcedIdle = true;
              }
              await sleepFn(idleSleepMs);
              continue;
            }
            if (!keepAlive || this.#isRunComplete()) { this.#stopReason = 'complete'; break; }
            await sleepFn(idleSleepMs);
            continue;
          }
          announcedIdle = false;

          // Report on completed tasks
          for (const result of tasksCompleted) {
            total++;
            if (opts.onTick) await opts.onTick(result as TickResult, total);
          }
        } catch (e: unknown) {
          // A FATAL DB error (corrupt/locked/schema) means state.db is unusable —
          // stop the run. Everything else is treated as a task-level hiccup: skip
          // and keep looping until repeated failures cross the ceiling.
          if (handleOrchestratorError(e, this.#logger) === 'stop') {
            this.#environmentError = this.#errorDetail(e);
            this.#stopReason = 'environment';
            break;
          }
          lastErrorMsg = this.#errorDetail(e);
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_TICK_ERRORS) {
            this.#environmentError = `repeated tick failures (${consecutiveErrors}x): ${this.#singleLine(lastErrorMsg)}`;
            this.#stopReason = 'environment';
            break;
          }
          await sleepFn(idleSleepMs);
          continue;
        }
      }
    } finally {
      this.dispose();
    }
    return total;
  }

  // ── Private ──────────────────────────────────────────────────────────

  async #handleZero(task: TaskState, metric: number, wt: Worktree | null = null): Promise<TickResult> {
    task.incrementConvergence();
    if (task.hasConverged) {
      // Use passed worktree or look up from map (for subsequent ticks after spawn)
      let tree = wt ?? this.#worktrees.get(task.taskNumber) ?? null;
      // If worktree not in memory (process restart) and repo has .git, try to reconnect.
      // Normally B2 reconnect at pickup handles this; this is defense-in-depth.
      /* v8 ignore next 3 -- safety net; B2 reconnect at pickup prevents this path */
      if (!tree && this.#spawn && existsSync(resolve(this.#repo, '.git'))) {
        tree = this.#tryReconnectWorktree(task);
      }
      if (tree) {
        try {
          const outcome = await this.#mergeAndRemove(task, tree);
          if (outcome === 'locked') {
            this.#log(`T${task.taskNumber} merge deferred: another orchestrator holds the merge lock; retrying next tick`);
            return { task: task.info, metric, converged: false };
          }
          if (outcome === 'rework') {
            this.#log(`T${task.taskNumber} base advanced and broke acceptance after sync; re-running agent against the updated base`, 'transition');
            return { task: task.info, metric, converged: false };
          }
          if (outcome === 'blocked') {
            // #mergeAndRemove already BLOCKED the task (post-sync benchmark defect).
            return { task: task.info, metric, converged: false };
          }
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
      /* v8 ignore start -- safety net; B2 reconnect at pickup prevents this path */
      else if (this.#spawn && existsSync(resolve(this.#repo, '.git'))) {
        task.resetConvergence();
        this.#log(`T${task.taskNumber} convergence reached but worktree not found — resetting (process restart?)`, 'transition');
        return { task: task.info, metric, converged: false };
      }
      /* v8 ignore stop */
      // No-spawn mode: tree===null is legitimate — converge without merge
      task.release(Status.CONVERGED);
      TaskState.pruneConverged(this.#tdb, this.#dir, this.#keepConverged);
      this.#log(`T${task.taskNumber} CONVERGED`, 'transition');
      return { task: task.info, metric, converged: true };
    }
    return { task: task.info, metric, converged: false };
  }

  async #mergeAndRemove(task: TaskState, wt: Worktree): Promise<MergeOutcome> {
    // Serialize merges across orchestrators sharing this repo: a merge mutates
    // the shared base checkout, so concurrent merges would corrupt it.
    if (!this.#acquireMergeLock()) return 'locked';
    let stashed = false;
    try {
      if (this.#autoStashBeforeMerge) {
        stashed = await wt.stashParentChanges(`orchestrator ${task.taskName} pre-merge`);
        if (stashed) this.#log(`T${task.taskNumber} stashed parent repo changes before merge`);
      }
      // Update the branch with the latest base first, so a base that advanced
      // while the agent worked does not block the merge. Then re-verify the
      // benchmark: if absorbing the base broke acceptance, send the task back
      // to the agent instead of merging broken work.
      await wt.syncWithBase();
      const postSync = await this.#run(task, wt.path);
      if (postSync.kind !== 'ok') {
        // Absorbing the base made the benchmark unreliable (infra regression):
        // block rather than merge or churn the agent against a broken check.
        this.#handleBenchmarkDefect(task, postSync);
        return 'blocked';
      }
      if (postSync.total !== 0) {
        task.resetConvergence();
        return 'rework';
      }
      if (this.#verifyCmd && !this.#runVerifyCmd(wt.path)) {
        this.#log(`T${task.taskNumber} verify command failed; sending back to agent`, 'transition');
        task.resetConvergence();
        return 'rework';
      }
      await wt.merge();
      await wt.remove();
      this.#worktrees.delete(task.taskNumber);
      return 'merged';
    } finally {
      if (stashed) {
        try {
          execFileSync('git', ['stash', 'pop'], { cwd: this.#repo, encoding: 'utf-8' });
        } catch {
          this.#log(`T${task.taskNumber} WARNING: stash pop failed — user changes may be stuck in stash. Recover with 'git stash pop'`, 'always');
        }
      }
      this.#releaseMergeLock();
    }
  }

  async #recoverMergeFailure(task: TaskState, wt: Worktree, e: unknown): Promise<boolean> {
    const detail = this.#errorDetail(e);
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
        await wt.stashParentChanges(`orchestrator ${task.taskName} merge recovery`);
        this.#log(`T${task.taskNumber} retrying merge after stashing parent repo changes`);
        return (await this.#mergeAndRemove(task, wt)) === 'merged';
      } catch (retryError: unknown) {
        this.#handleMergeFailure(task, retryError, 'after auto-stash');
        return false;
      }
    }

    this.#handleMergeFailure(task, e);
    return false;
  }

  #handleMergeFailure(task: TaskState, e: unknown, context = ''): void {
    const detail = this.#errorDetail(e);
    const reason = context ? `${context}: ${detail}` : detail;
    task.markBlocked();
    this.#retryCooldowns.set(task.taskNumber, Date.now());
    this.#log(`T${task.taskNumber} merge failed: ${reason}; task BLOCKED; worktree kept for inspection`, 'transition');
  }

  #isRunComplete(): boolean {
    // scan() excludes CONVERGED, so a run is complete once every remaining task
    // is terminally BLOCKED (nothing left that could still be worked).
    for (const task of TaskState.scan(this.#tdb, this.#dir).values()) {
      if (!task.isBlocked) return false;
    }
    return true;
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

  async #prepareWorktree(task: TaskState): Promise<Worktree | null> {
    if (this.#noWorktree) return null;
    let wt = this.#worktrees.get(task.taskNumber) ?? null;
    if (!wt && existsSync(resolve(this.#repo, '.git'))) {
      const base = task.targetBranch ?? this.#baseBranch;
      wt = new Worktree(this.#repo, { name: task.taskName, baseBranch: base, ...(this.#worktreesDir ? { worktreesDir: this.#worktreesDir } : {}) });
      await wt.create();
      this.#worktrees.set(task.taskNumber, wt);
    }
    if (!wt) {
      this.#log(`T${task.taskNumber} WARNING: no .git found — agent will work directly in ${this.#repo} (no isolation, no cleanup, no merge)`, 'always');
    }
    if (wt) {
      const base = task.targetBranch ?? this.#baseBranch;
      // Clean any uncommitted agent changes from a prior run, then sync with
      // the latest base so the agent always works on current, clean code.
      wt.cleanWorktree();
      try {
        await wt.syncWithBase();
        this.#log(`T${task.taskNumber} worktree synced with ${base}`);
      } catch {
        await wt.resetForRetry();
        this.#log(`T${task.taskNumber} worktree reset to ${base} (sync failed; agent starts fresh)`, 'transition');
      }
      // Copy node_modules for isolated npm commands (no symlink — avoids circular chain risk)
      const wtNm = join(wt.path, 'node_modules');
      try {
        cpSync(join(this.#repo, 'node_modules'), wtNm, { recursive: true });
      } catch (e: unknown) {
        this.#bestEffortFailure(`failed to copy node_modules into worktree ${wt.path}`, e);
      }
    }
    return wt;
  }

  /** Try to reconnect to a worktree from a previous process. Returns the
   *  Worktree if found/recreated, null otherwise. */
  #tryReconnectWorktree(task: TaskState): Worktree | null {
    const base = task.targetBranch ?? this.#baseBranch;
    const wt = new Worktree(this.#repo, {
      name: task.taskName,
      baseBranch: base,
      /* v8 ignore next -- same pattern as #prepareWorktree; worktreesDir tested there */
      ...(this.#worktreesDir ? { worktreesDir: this.#worktreesDir } : {}),
    });
    if (wt.exists) {
      this.#worktrees.set(task.taskNumber, wt);
      this.#log(`T${task.taskNumber} reconnected to existing worktree`);
      return wt;
    }
    // Worktree dir gone but branch may exist — try to recreate
    try {
      wt.create();
      this.#worktrees.set(task.taskNumber, wt);
      this.#log(`T${task.taskNumber} recreated worktree from existing branch`);
      return wt;
    } catch (e: unknown) {
      this.#log(`T${task.taskNumber} worktree reconnection failed: ${this.#errorDetail(e)}`);
      return null;
    }
  }

  /** Spawn the agent, then re-check. Returns the post-agent {@link BenchmarkOutcome},
   *  or `null` when the run was stopped (an auth failure, handled as environmental). */
  async #runSpawnCycle(task: TaskState, wt: Worktree | null, metric: number, signal: AbortSignal): Promise<BenchmarkOutcome | null> {
    this.#log(`T${task.taskNumber} action: starting agent because metric is ${metric}`);
    const spawnResult = await this.#spawn!(task, wt?.path, signal);
    this.#log(
      `T${task.taskNumber} agent ${spawnResult.success ? 'finished' : 'stopped without finishing'} ` +
      `(${this.#experimentLabel(spawnResult.iterations)}` +
      `${spawnResult.tokenUsage ? `; tokens: ${this.#tokenUsageLabel(spawnResult.tokenUsage)}` : ''}` +
      `${spawnResult.error ? `; reason: ${this.#singleLine(spawnResult.error)}` : ''}` +
      `${spawnResult.logPath ? `; details: ${spawnResult.logPath}` : ''})`,
    );
    if (spawnResult.authFailure) {
      this.#handleEnvironmentalFailure(task, metric, spawnResult.error ?? 'coding agent authentication failed');
      return null;
    }
    // Auto-commit any uncommitted agent work so merge captures everything
    // the benchmark validates (fixes B1: uncommitted changes lost at merge).
    if (wt?.autoCommit('agent work (auto-committed by orchestrator)')) {
      this.#log(`T${task.taskNumber} auto-committed uncommitted agent work`);
    }
    const outcome = await this.#run(task, wt?.path ?? this.#repo);
    const note = outcome.kind !== 'ok' ? ' (benchmark unreliable)'
      : outcome.total === 0 ? ' (done)' : ' (still needs work)';
    this.#log(`T${task.taskNumber} check after agent (${wt ? 'worktree' : 'repo'}): metric=${outcome.total}${note}`);
    return outcome;
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

  /**
   * A benchmark defect (crash, timeout, or no METRIC line) makes the result
   * unreliable. The agent cannot fix a broken benchmark, so spawning it would
   * only burn retries. Block this one task with a structured reason and let the
   * fleet keep running — the benchmark.js must be fixed, then `--unblock`.
   */
  #handleBenchmarkDefect(task: TaskState, outcome: BenchmarkOutcome): void {
    const reason = outcome.kind === 'crash'
      ? 'benchmark crashed or timed out — result unreliable'
      : 'benchmark emitted no METRIC line — it measures nothing';
    task.markBlocked();
    this.#log(
      `T${task.taskNumber} benchmark defect: ${reason}; task BLOCKED ` +
      `(not the agent's fault, no retry consumed) — fix benchmark.js (see benchmark.log) then --unblock`,
      'transition',
    );
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

  #errorDetail(e: unknown): string {
    return this.#singleLine(e instanceof Error ? e.message : String(e));
  }

  #bestEffortFailure(context: string, e: unknown): void {
    this.#log(`${context}: ${this.#errorDetail(e)}`, 'always');
  }

  async #run(task: TaskState, cwd: string): Promise<BenchmarkOutcome> {
    try {
      const info = { ...task.info, cwd };
      const result = await this.#bench(info);
      // A bare number is shorthand for a clean run; an outcome passes through.
      return typeof result === 'number'
        ? { kind: 'ok', total: result, criteria: [] }
        : result;
    }
    catch (e: unknown) {
      this.#log(`T${task.taskNumber} benchmark error: ${this.#errorDetail(e)}`);
      return { kind: 'crash', total: 1, criteria: [] };
    }
  }

  /** Run the configured verify command in the given cwd. Returns true on success. */
  #runVerifyCmd(cwd: string): boolean {
    try {
      /* v8 ignore next 4 */
      const [shell, ...args] = process.platform === 'win32'
        ? ['cmd', '/c', this.#verifyCmd!]
        : ['sh', '-c', this.#verifyCmd!];
      execFileSync(shell, args, { cwd, stdio: 'pipe', timeout: 300_000 });
      return true;
    } catch {
      return false;
    }
  }

  // ── Merge lock (cross-orchestrator) ─────────────────────────────────

  get #mergeLockDir(): string { return resolve(this.#repo, '.orchestrator-merge-lock'); }

  /** Atomic mkdir lock so only one orchestrator merges into the shared base at
   *  a time. A stale lock (older than ORCH_MERGE_LOCK_MS — a crashed merger) is
   *  broken and re-acquired; the atomic mkdir still arbitrates the retry. */
  #acquireMergeLock(): boolean {
    if (this.#tryMakeMergeLock()) return true;
    if (this.#mergeLockAgeMs() < env.mergeLockMs) return false;
    try {
      rmSync(this.#mergeLockDir, { recursive: true, force: true });
    }
    /* v8 ignore start -- stale-lock cleanup failures are best-effort */
    catch (e: unknown) {
      this.#bestEffortFailure(`failed to clear stale merge lock ${this.#mergeLockDir}`, e);
      return false;
    }
    /* v8 ignore stop */
    if (!this.#tryMakeMergeLock()) return false;
    if (this.#mergeLockToken() === this.#currentLockToken) return true;
    this.#currentLockToken = null;
    return false;
  }

  #tryMakeMergeLock(): boolean {
    try { mkdirSync(this.#mergeLockDir); } catch { return false; }
    const token = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.#currentLockToken = token;
    try {
      writeFileSync(join(this.#mergeLockDir, 'owner'), `pid:${process.pid}\nhost:${hostname()}\nstarted:${Date.now()}\ntoken:${token}\n`);
    }
    /* v8 ignore start -- owner-file failures depend on filesystem faults */
    catch (e: unknown) {
      this.#bestEffortFailure(`failed to write merge lock owner file in ${this.#mergeLockDir}`, e);
      this.#currentLockToken = null;
      try {
        rmSync(this.#mergeLockDir, { recursive: true, force: true });
      } catch (cleanupError: unknown) {
        this.#bestEffortFailure(`failed to clean up incomplete merge lock ${this.#mergeLockDir}`, cleanupError);
      }
      return false;
    }
    /* v8 ignore stop */
    return true;
  }

  #mergeLockAgeMs(): number {
    try {
      const started = parseInt(readFileSync(join(this.#mergeLockDir, 'owner'), 'utf-8').match(/started:(\d+)/)?.[1] ?? '0', 10);
      if (started > 0) return Date.now() - started;
    } catch { /* missing/unreadable owner → treat as stale */ }
    return Infinity;
  }

  #mergeLockToken(): string | null {
    try {
      return readFileSync(join(this.#mergeLockDir, 'owner'), 'utf-8').match(/token:(.+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  #releaseMergeLock(): void {
    try {
      if (this.#currentLockToken !== null && this.#mergeLockToken() === this.#currentLockToken) {
        rmSync(this.#mergeLockDir, { recursive: true, force: true });
      }
    }
    /* v8 ignore start -- release failures depend on filesystem faults */
    catch (e: unknown) {
      this.#bestEffortFailure(`failed to release merge lock ${this.#mergeLockDir}`, e);
    }
    /* v8 ignore stop */
    finally {
      this.#currentLockToken = null;
    }
  }

  // ── State reconciliation (DB-backed) ────────────────────────────────

  /** Re-acquire our own in-progress tasks across ticks: pick() never returns
   *  IN_PROGRESS rows, so without this a task we already claimed would stall.
   *  Returns the lowest-numbered one we are not already processing, or null.
   *  The scan-built view carries the claim token from the row, so gated
   *  mutators keep working. */
  #continueOwned(): TaskState | null {
    const mine = [...TaskState.scan(this.#tdb, this.#dir).values()]
      .filter(t => t.isInProgress && t.claimOwnerId === this.#id && !this.#owned.has(t.taskNumber))
      .sort((a, b) => a.taskNumber - b.taskNumber);
    return mine[0] ?? null;
  }

  /** Block FAILED tasks that have exhausted their retry budget. recoverStale()
   *  can push a task to its limit without going through #handleFailure, so this
   *  enforces the ceiling each tick before picking. */
  #blockExhausted(): void {
    for (const t of TaskState.scan(this.#tdb, this.#dir).values()) {
      if (t.isFailed && t.failureCount >= t.maxFailures) t.markBlocked();
    }
  }

  /** Explain why nothing was picked (blocked, claimed elsewhere, unmet deps). */
  #logIdle(): void {
    for (const t of TaskState.scan(this.#tdb, this.#dir).values()) {
      const tn = `T${t.taskNumber}`;
      if (t.isBlocked) {
        this.#log(`${tn}: skipped — blocked (${t.failureCount} failures)`);
      } else if (t.isInProgress) {
        const owner = t.claimOwnerId;
        const byUs = owner === this.#id;
        this.#log(`${tn}: skipped — ${byUs ? 'our claim (convergence check)' : `claim held by ${owner.slice(0, 12)}...`}`);
      } else {
        // PENDING/FAILED yet unpicked ⇒ deps unmet: an actionable task would
        // have been claimed this tick (scan yields no other states here).
        this.#log(`${tn}: skipped — unmet deps [${t.dependencies.join(',')}]`);
      }
    }
    this.#log('No actionable tasks');
  }

  /** One-time startup reconciliation between the DB and the content tree:
   *   - stale CREATING rows: promote if content landed (benchmark.js present),
   *     else drop the row and its abandoned staging dir(s);
   *   - actionable rows whose content dir vanished: BLOCK (cannot be worked).
   *  Non-task entries (state.db*, .staging*) are never treated as tasks. */
  #reconcileOnce(): void {
    if (this.#reconciled) return;
    this.#reconciled = true;

    // Import any pre-existing file-shard tasks first (idempotent), so their
    // content dirs are present in the DB before the checks below run.
    const imported = migrateShards(this.#tdb, this.#dir);
    if (imported > 0) this.#log(`reconcile: imported ${imported} task(s) from file shards`, 'transition');

    for (const row of this.#tdb.byStatus(['CREATING'])) {
      if (existsSync(resolve(this.#dir, row.dir, 'benchmark.js'))) {
        this.#tdb.promote(row.id);
        this.#log(`reconcile: T${row.task_number} promoted (content found)`, 'transition');
      } else {
        this.#tdb.remove(row.id);
        this.#removeStaging(row.dir);
        this.#log(`reconcile: T${row.task_number} dropped (incomplete create)`, 'transition');
      }
    }

    for (const row of this.#tdb.byStatus(['PENDING', 'IN_PROGRESS', 'FAILED'])) {
      if (!existsSync(resolve(this.#dir, row.dir))) {
        this.#tdb.block(row.id);
        this.#log(`reconcile: T${row.task_number} blocked (content dir missing)`, 'transition');
      }
    }
  }

  #removeStaging(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(this.#dir); }
    /* v8 ignore next -- tasks dir is always readable here; defensive */
    catch (e: unknown) { this.#bestEffortFailure(`failed to read ${this.#dir} for staging cleanup`, e); return; }
    for (const entry of entries) {
      if (entry.startsWith(`.staging-${dir}-`)) {
        rmSync(resolve(this.#dir, entry), { recursive: true, force: true });
      }
    }
  }
}
