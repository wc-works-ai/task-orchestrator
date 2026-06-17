import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, readdirSync, cpSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, basename, join, dirname } from 'node:path';
import { Status, inProgress, isInProgress, isActionable, CONVERGENCE_THRESHOLD, MAX_FAILURES, statusToShard, SHARDS, } from './Status.js';
export { Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD, MAX_FAILURES };
// ── File names ──────────────────────────────────────────────────────────────
const F_STATUS = '.status';
const F_COUNTER = '.convergence_count';
const F_FAILURES = '.failure_count';
const F_DEPS = '.dependencies';
const D_CLAIM = '.claim';
const F_OWNER = 'owner';
const F_BEAT = 'heartbeat';
// ── TaskState ───────────────────────────────────────────────────────────────
export class TaskState {
    static #cache = new Map();
    #dir;
    constructor(dir) {
        this.#dir = resolve(dir);
    }
    get directory() {
        return this.#dir;
    }
    // ── Identity ────────────────────────────────────────────────────────
    get taskNumber() {
        return parseInt(basename(this.#dir).match(/^T(\d+)-/)?.[1] ?? '', 10) || 0;
    }
    get taskName() {
        return basename(this.#dir);
    }
    get info() {
        return this;
    }
    /** Default cwd — overridden by Engine with actual worktree/repo root */
    get cwd() { return this.#dir; }
    get number() {
        return this.taskNumber;
    }
    get name() {
        return this.taskName;
    }
    // ── Status ──────────────────────────────────────────────────────────
    get status() {
        try {
            const raw = readFileSync(join(this.#dir, F_STATUS), 'utf-8').trim();
            return (raw || Status.PENDING);
        }
        catch {
            return Status.PENDING;
        }
    }
    set status(v) {
        // Cache stores the base status (PENDING/FAILED/BLOCKED/CONVERGED)
        const cacheBase = isInProgress(v) ? Status.PENDING : v;
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
            try {
                renameSync(this.#dir, dest);
                this.#dir = dest;
            }
            catch {
                /* v8 ignore start: cross-device rename fallback — requires different filesystem mounts */
                // If rename fails (e.g., cross-device), fall back to copy + delete
                cpSync(this.#dir, dest, { recursive: true });
                rmSync(this.#dir, { recursive: true, force: true });
                this.#dir = dest;
                /* v8 ignore stop */
            }
        }
        TaskState.#cache.set(String(this.taskNumber), cacheBase);
    }
    get isPending() { return this.status === Status.PENDING; }
    get isConverged() { return this.status === Status.CONVERGED; }
    get isFailed() { return this.status === Status.FAILED; }
    get isBlocked() { return this.status === Status.BLOCKED; }
    get isInProgress() { return isInProgress(this.status); }
    get isActionable() { return isActionable(this.status); }
    // ── Convergence ─────────────────────────────────────────────────────
    get convergenceCount() {
        try {
            return parseInt(readFileSync(join(this.#dir, F_COUNTER), 'utf-8').trim(), 10) || 0;
        }
        catch {
            return 0;
        }
    }
    incrementConvergence() {
        const n = this.convergenceCount + 1;
        writeFileSync(join(this.#dir, F_COUNTER), `${n}\n`);
        return n;
    }
    resetConvergence() { try {
        rmSync(join(this.#dir, F_COUNTER));
    }
    catch { } }
    get hasConverged() {
        return this.convergenceCount >= CONVERGENCE_THRESHOLD;
    }
    // ── Failures ────────────────────────────────────────────────────────
    get failureCount() {
        try {
            return parseInt(readFileSync(join(this.#dir, F_FAILURES), 'utf-8').trim(), 10) || 0;
        }
        catch {
            return 0;
        }
    }
    incrementFailures() {
        const n = this.failureCount + 1;
        writeFileSync(join(this.#dir, F_FAILURES), `${n}\n`);
        return n;
    }
    // ── Dependencies ────────────────────────────────────────────────────
    get dependencies() {
        try {
            return readFileSync(join(this.#dir, F_DEPS), 'utf-8')
                .trim().split('\n').filter(Boolean).map(Number);
        }
        catch {
            return [];
        }
    }
    set dependencies(nums) {
        writeFileSync(join(this.#dir, F_DEPS), nums.join('\n') + '\n');
    }
    dependenciesMet(tasksDir) {
        for (const d of this.dependencies) {
            // Read from disk — cache is per-process, another process may have changed status
            const depTask = TaskState.#findByNumber(tasksDir, d);
            if (!depTask || depTask.status !== Status.CONVERGED)
                return false;
        }
        return true;
    }
    static #findByNumber(tasksDir, num) {
        for (const shard of SHARDS) {
            const shardDir = resolve(tasksDir, shard);
            let entries;
            try {
                entries = readdirSync(shardDir);
            }
            catch {
                continue;
            }
            const match = entries.find(e => new RegExp(`^T0*${num}-`).test(e));
            if (match)
                return new TaskState(resolve(shardDir, match));
        }
        return null;
    }
    // ── Claim ───────────────────────────────────────────────────────────
    claim(instanceId) {
        const p = join(this.#dir, D_CLAIM);
        try {
            mkdirSync(p);
        }
        catch {
            return false;
        }
        writeFileSync(join(p, F_OWNER), `pid:${process.pid}\nstarted:${Date.now()}\ninstance:${instanceId}\n`);
        writeFileSync(join(p, F_BEAT), '');
        this.status = inProgress(instanceId);
        return true;
    }
    get isClaimed() { return existsSync(join(this.#dir, D_CLAIM)); }
    get claimOwner() {
        try {
            const raw = readFileSync(join(this.#dir, D_CLAIM, F_OWNER), 'utf-8');
            return {
                pid: parseInt(raw.match(/pid:(\d+)/)?.[1] ?? '0', 10),
                startedAt: parseInt(raw.match(/started:(\d+)/)?.[1] ?? '0', 10),
                instanceId: raw.match(/instance:(.+)/)?.[1] ?? '',
            };
        }
        catch {
            return null;
        }
    }
    get claimOwnerId() { return this.claimOwner?.instanceId ?? ''; }
    heartbeat() {
        try {
            writeFileSync(join(this.#dir, D_CLAIM, F_BEAT), '');
        }
        catch { }
    }
    release(newStatus = Status.PENDING) {
        try {
            rmSync(join(this.#dir, D_CLAIM), { recursive: true, force: true });
        }
        catch { }
        this.status = newStatus;
    }
    markBlocked() {
        this.release(Status.BLOCKED);
        this.resetConvergence();
    }
    // ── Metadata ────────────────────────────────────────────────────────
    get scope() {
        try {
            const c = readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8');
            const m = c.match(/^## Scope([\s\S]*?)(?=## |$)/s);
            const raw = m?.[1]?.trim() ?? '';
            return raw ? raw.split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean) : [];
        }
        catch {
            return [];
        }
    }
    get goal() {
        try {
            const c = readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8');
            return (c.match(/^## Goal:?\s*(.+)/m)
                || c.match(/^## Goal\s*\n(.+)/m)
                || [])[1]?.trim() ?? this.taskName;
        }
        catch {
            return this.taskName;
        }
    }
    get model() {
        try {
            return readFileSync(join(this.#dir, 'autoresearch.md'), 'utf-8')
                .match(/\*\*Model:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
        }
        catch {
            return '';
        }
    }
    // ── Static ──────────────────────────────────────────────────────────
    /** Scan all shards and return a Map of task number → TaskState */
    static async scan(tasksDir) {
        TaskState.#cache.clear();
        const all = new Map();
        for (const shard of SHARDS) {
            try {
                for (const entry of await readdir(resolve(tasksDir, shard))) {
                    const m = entry.match(/^T(\d+)-/);
                    if (!m?.[1])
                        continue;
                    const dir = resolve(tasksDir, shard, entry);
                    try {
                        await readdir(dir);
                    }
                    catch {
                        continue;
                    } // not a dir
                    const t = new TaskState(dir);
                    all.set(String(parseInt(m[1], 10)), t);
                    TaskState.#cache.set(String(parseInt(m[1], 10)), t.status);
                }
            }
            catch { /* shard doesn't exist */ }
        }
        return all;
    }
    /** Pick the highest-priority actionable task. Returns null if none. */
    static async pick(tasksDir, instanceId) {
        for (const shard of ['pending', 'failed', 'in_progress']) {
            let entries;
            try {
                entries = await readdir(resolve(tasksDir, shard));
            }
            catch {
                continue;
            }
            const nums = entries
                .map(e => { const m = e.match(/^T(\d+)-/); return m?.[1] ? parseInt(m[1], 10) : 0; })
                .filter(Boolean)
                .sort((a, b) => a - b);
            for (const tn of nums) {
                const dirName = entries.find(e => new RegExp(`^T0*${tn}-`).test(e));
                const t = new TaskState(resolve(tasksDir, shard, dirName));
                if (t.isConverged || t.isBlocked)
                    continue;
                if (t.isFailed && t.failureCount >= MAX_FAILURES) {
                    t.markBlocked();
                    continue;
                }
                if (t.isInProgress) {
                    if (!t.isClaimed) {
                        t.release(Status.FAILED);
                        continue;
                    }
                    if (t.claimOwnerId !== instanceId)
                        continue;
                    return t;
                }
                if (!t.isActionable || !t.dependenciesMet(tasksDir))
                    continue;
                if (!t.claim(instanceId))
                    continue;
                return t;
            }
        }
        return null;
    }
    static get statusCache() {
        return TaskState.#cache;
    }
}
//# sourceMappingURL=TaskState.js.map