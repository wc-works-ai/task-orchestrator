/**
 * One-time import of pre-existing file-shard tasks into the SQLite state DB.
 *
 * Old tasks live under shard dirs (`pending/`, `in_progress/`, `converged/`,
 * `failed/`, `blocked/`) as `T<number>-<name>` directories holding `.status`,
 * `.convergence_count`, `.failure_count`, `.dependencies`, and `.target_branch`
 * metadata files alongside the task content. This reads that metadata and
 * inserts one DB row per task, leaving the content directory in place — the
 * `dir` column records its shard-relative location so the Engine resolves it
 * without any renames.
 *
 * Idempotent: a task whose number already exists is skipped, so a partial or
 * repeated run is safe. IN_PROGRESS claims are not migrated — those tasks land
 * as FAILED to be cleanly re-picked once the loop restarts.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../shared/env.js';
const SHARDS = ['pending', 'in_progress', 'converged', 'failed', 'blocked'];
const TASK_DIR = /^T(\d+)-(.+)$/;
const PASSTHROUGH = new Set(['PENDING', 'FAILED', 'BLOCKED', 'CONVERGED']);
/** Scan the old shard dirs under `tasksRoot` and import each task into `tdb`.
 *  Returns the number of tasks imported (already-present ones are skipped). */
export function migrateShards(tdb, tasksRoot) {
    // Freeze the retry limit once, like addTask: Infinity (unlimited) → NULL.
    const maxFailures = Number.isFinite(env.maxFailures) ? env.maxFailures : null;
    let imported = 0;
    for (const shard of SHARDS) {
        const shardDir = join(tasksRoot, shard);
        if (!existsSync(shardDir))
            continue;
        for (const entry of readdirSync(shardDir)) {
            const m = TASK_DIR.exec(entry);
            if (!m)
                continue; // not a task dir (ignores state.db*, .staging*, etc.)
            try {
                if (importOne(tdb, tasksRoot, shard, entry, Number(m[1]), m[2], maxFailures))
                    imported++;
            }
            catch (error) {
                // One unreadable/corrupt task dir must not abort the whole import.
                console.error(`[migrate] skipped ${join(shard, entry)}; left in place`, error);
            }
        }
    }
    return imported;
}
function importOne(tdb, tasksRoot, shard, entry, taskNumber, name, maxFailures) {
    if (tdb.getByNumber(taskNumber) !== undefined)
        return false; // already imported
    const dir = join(shard, entry);
    const base = join(tasksRoot, dir);
    return tdb.importTask({
        taskNumber,
        name,
        dir,
        status: mapStatus(readText(join(base, '.status'))),
        convergence: readNonNegInt(join(base, '.convergence_count')),
        failures: readNonNegInt(join(base, '.failure_count')),
        maxFailures,
        targetBranch: readBranch(join(base, '.target_branch')),
        dependsOn: readDeps(join(base, '.dependencies')),
    });
}
/** Read a metadata file, or null when it is absent. An unreadable (corrupt)
 *  path throws, surfacing to the per-task boundary in {@link migrateShards}. */
function readText(path) {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}
function mapStatus(raw) {
    const s = (raw ?? '').trim();
    if (s.startsWith('IN_PROGRESS'))
        return 'FAILED'; // claim is not migrated
    if (PASSTHROUGH.has(s))
        return s;
    return 'PENDING';
}
function readNonNegInt(path) {
    const raw = readText(path);
    if (raw === null)
        return 0;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
}
function readDeps(path) {
    const raw = readText(path);
    if (raw === null)
        return [];
    const deps = [];
    for (const line of raw.split('\n')) {
        const n = Number(line.trim());
        if (Number.isInteger(n) && n > 0)
            deps.push(n);
    }
    return deps;
}
function readBranch(path) {
    const raw = readText(path);
    if (raw === null)
        return null;
    const t = raw.trim();
    return t === '' ? null : t;
}
//# sourceMappingURL=migrate.js.map