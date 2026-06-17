/**
 * Provenance of a generated `benchmark.js`, stored beside it in the task content
 * dir as `benchmark.meta.json`. State (status/convergence/…) lives in SQLite; this
 * sidecar records only what the benchmark artifact was generated from, so the
 * regeneration predicate stays a pure function of small, co-located inputs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const META_FILE = 'benchmark.meta.json';
/** Stable hex digest used for both the criteria fingerprint and the content hash. */
export function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}
/** Read the benchmark provenance sidecar. Returns null when it is missing or
 *  unparseable — callers treat that as "regenerate", which is always safe. */
export function readMeta(dir) {
    try {
        return JSON.parse(readFileSync(join(dir, META_FILE), 'utf-8'));
    }
    catch {
        return null;
    }
}
export function writeMeta(dir, meta) {
    writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2) + '\n');
}
/**
 * Decide whether benchmark.js must be (re)generated before an agent-work cycle.
 * Frozen during a convergence streak; otherwise regenerate when the benchmark is
 * missing, has no provenance, or its inputs (criteria fingerprint or base SHA)
 * have changed. Invariant: regenerated exactly when its inputs change, and never
 * mid-streak.
 */
export function shouldRegenerate(input) {
    if (input.convergenceCount > 0)
        return false;
    if (!input.benchmarkExists || input.meta === null)
        return true;
    if (input.meta.fingerprint !== input.fingerprint)
        return true;
    return input.meta.base !== input.baseSha;
}
//# sourceMappingURL=BenchmarkMeta.js.map