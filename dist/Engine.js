import { statSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync, cpSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { TaskState, Status } from './TaskState.js';
import { Worktree } from './Worktree.js';
import { env } from './env.js';
const HEARTBEAT_MAX_MS = env.heartbeatMs;
export class Engine {
    #dir;
    #repo;
    #worktreesDir;
    #bench;
    #spawn;
    #id;
    #retryCooldownMs;
    /** Track active worktrees by task number */
    #worktrees = new Map();
    /** Track last failure time per task for retry cooldown */
    #retryCooldowns = new Map();
    constructor(tasksDir, opts = {}) {
        this.#dir = tasksDir;
        this.#repo = opts.repoDir ?? dirname(tasksDir);
        this.#worktreesDir = opts.worktreesDir ?? env.worktreesDir;
        this.#bench = opts.benchmark ?? (() => 1);
        this.#spawn = opts.spawn ?? null;
        this.#id = opts.instanceId ?? `${process.pid}_${Date.now()}`;
        this.#retryCooldownMs = opts.retryCooldownMs ?? 0; // default: no cooldown
    }
    get instanceId() { return this.#id; }
    #log(msg) {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[${ts}] ${msg}`);
        try {
            appendFileSync(resolve(this.#dir, 'orchestrator.log'), `[${ts}] ${msg}\n`);
        }
        catch { }
    }
    get #stopFile() { return resolve(this.#dir, '.stop'); }
    // ── Single tick ─────────────────────────────────────────────────────
    async pickByNumber(num) {
        await TaskState.scan(this.#dir);
        for (const shard of ["pending", "in_progress", "failed", "converged", "blocked"]) {
            try {
                for (const e of readdirSync(resolve(this.#dir, shard))) {
                    if (new RegExp(`^T0*${num}-`).test(e))
                        return new TaskState(resolve(this.#dir, shard, e));
                }
            }
            catch { }
        }
        return null;
    }
    async tick() {
        if (existsSync(this.#stopFile)) {
            try {
                rmSync(this.#stopFile);
            }
            catch { }
            return { task: null, metric: 0, converged: false };
        }
        this.#recover();
        await TaskState.scan(this.#dir);
        const task = await TaskState.pick(this.#dir, this.#id);
        if (!task) {
            // Diagnostic: show why nothing was picked
            for (const shard of ['pending', 'in_progress', 'failed', 'blocked']) {
                let entries;
                try {
                    entries = readdirSync(resolve(this.#dir, shard));
                }
                catch {
                    continue;
                }
                for (const e of entries) {
                    if (!e.startsWith('T'))
                        continue;
                    const t = new TaskState(resolve(this.#dir, shard, e));
                    const tn = `T${t.taskNumber}`;
                    if (t.isConverged)
                        continue;
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
                    }
                    else if (!t.dependenciesMet(this.#dir)) {
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
            if (wt)
                await wt.resetForRetry();
        }
        let metric = await this.#run(task);
        this.#log(`T${task.taskNumber} metric=${metric}`);
        if (metric === 0)
            return this.#handleZero(task, metric);
        // Non-zero: try spawner if available
        task.resetConvergence();
        if (this.#spawn) {
            let wt = this.#worktrees.get(task.taskNumber) ?? null;
            if (!wt && existsSync(resolve(this.#repo, '.git'))) {
                wt = new Worktree(this.#repo, { name: task.taskName, ...(this.#worktreesDir ? { worktreesDir: this.#worktreesDir } : {}) });
                await wt.create();
                this.#worktrees.set(task.taskNumber, wt);
            }
            if (wt) {
                // Copy task directory into worktree (tasks/ not tracked in git)
                const taskRel = task.directory.replace(this.#repo, '').replace(/^\//, '');
                const wtTaskDir = join(wt.path, taskRel);
                try {
                    cpSync(task.directory, wtTaskDir, { recursive: true, filter: (f) => !f.endsWith('agent.log') });
                }
                catch { }
                // Copy node_modules for isolated npm commands (no symlink — avoids circular chain risk)
                const wtNm = join(wt.path, 'node_modules');
                if (!existsSync(wtNm)) {
                    try {
                        cpSync(join(this.#repo, 'node_modules'), wtNm, { recursive: true });
                    }
                    catch { }
                }
            }
            const ac = new AbortController();
            try {
                /* c8 ignore start */
                const hb = setInterval(() => {
                    task.heartbeat();
                    if (existsSync(this.#stopFile)) {
                        ac.abort();
                    }
                }, 30_000);
                /* c8 ignore stop */
                await this.#spawn(task, wt?.path, ac.signal);
                clearInterval(hb);
                metric = await this.#run(task, wt?.path);
                if (metric === 0)
                    return this.#handleZero(task, metric, wt);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes('conflict')) {
                    task.status = Status.FAILED;
                    this.#retryCooldowns.set(task.taskNumber, Date.now());
                    console.error(`  ⚠️  T${task.taskNumber}: merge conflict — task FAILED, worktree kept for inspection`);
                }
            }
        }
        this.#retryCooldowns.set(task.taskNumber, Date.now());
        task.release(Status.FAILED);
        this.#log(`T${task.taskNumber} FAILED (metric=${metric})`);
        return { task: task.info, metric, converged: false };
    }
    // ── Loop ────────────────────────────────────────────────────────────
    async loop(opts = {}) {
        let total = 0;
        while (true) {
            const result = await this.tick();
            if (!result.task)
                break;
            total++;
            if (opts.onTick)
                await opts.onTick(result, total);
        }
        return total;
    }
    // ── Private ──────────────────────────────────────────────────────────
    #handleZero(task, metric, wt = null) {
        task.incrementConvergence();
        if (task.hasConverged) {
            task.status = Status.CONVERGED;
            this.#log(`T${task.taskNumber} CONVERGED`);
            // Use passed worktree or look up from map (for subsequent ticks after spawn)
            const tree = wt ?? this.#worktrees.get(task.taskNumber) ?? null;
            if (tree) {
                this.#mergeAndRemove(task.taskNumber, tree, task.scope);
            }
            return { task: task.info, metric, converged: true };
        }
        return { task: task.info, metric, converged: false };
    }
    async #mergeAndRemove(tn, wt, scope) {
        try {
            await wt.merge(scope);
            await wt.remove();
        }
        catch { /* leave for inspection */ }
        this.#worktrees.delete(tn);
    }
    async #run(task, worktreePath) {
        try {
            const info = worktreePath
                ? { ...task.info, directory: resolve(worktreePath, task.directory.replace(this.#repo, '').replace(/^\//, '')), cwd: worktreePath }
                : task.info;
            return await this.#bench(info);
        }
        catch {
            return 1;
        }
    }
    #recover() {
        const dir = resolve(this.#dir, 'in_progress');
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (!e.startsWith('T'))
                continue;
            const task = new TaskState(resolve(dir, e));
            if (!task.isInProgress || !task.isClaimed)
                continue;
            const pid = this.#ownerPid(task);
            if (pid !== null && this.#alive(pid)) {
                // Process alive — respect heartbeat timeout
                const age = this.#heartbeatAge(task);
                if (age !== null && age < HEARTBEAT_MAX_MS)
                    continue;
                // Stale heartbeat but alive PID — skip (long-running op)
                continue;
            }
            // Owner dead or unknown — release immediately, preserve convergence
            task.release(Status.FAILED);
            this.#log(`STALE: ${task.taskName} claim released (convergence=${task.convergenceCount})`);
        }
    }
    #heartbeatAge(task) {
        try {
            return Date.now() - statSync(join(task.directory, '.claim', 'heartbeat')).mtimeMs;
        }
        catch {
            return null;
        }
    }
    #ownerPid(task) {
        try {
            const raw = readFileSync(join(task.directory, '.claim', 'owner'), 'utf-8');
            return parseInt(raw.match(/pid:(\d+)/)?.[1] ?? '', 10) || null;
        }
        catch {
            return null;
        }
    }
    #alive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=Engine.js.map