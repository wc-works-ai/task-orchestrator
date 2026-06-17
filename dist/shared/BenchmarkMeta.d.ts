export interface BenchmarkMeta {
    /** Hash of the `## Acceptance criteria` section it was generated from. */
    readonly fingerprint: string;
    /** Base commit SHA it was generated against. */
    readonly base: string;
    /** Content hash of the generated benchmark.js (anti-tamper guard). */
    readonly hash: string;
    /** Generation attempts since the last input change (bounds crash loops). */
    readonly genAttempts: number;
}
/** Stable hex digest used for both the criteria fingerprint and the content hash. */
export declare function sha256(text: string): string;
/** Read the benchmark provenance sidecar. Returns null when it is missing or
 *  unparseable — callers treat that as "regenerate", which is always safe. */
export declare function readMeta(dir: string): BenchmarkMeta | null;
export declare function writeMeta(dir: string, meta: BenchmarkMeta): void;
export interface RegenInput {
    readonly convergenceCount: number;
    readonly benchmarkExists: boolean;
    readonly meta: BenchmarkMeta | null;
    readonly fingerprint: string;
    readonly baseSha: string;
}
/**
 * Decide whether benchmark.js must be (re)generated before an agent-work cycle.
 * Frozen during a convergence streak; otherwise regenerate when the benchmark is
 * missing, has no provenance, or its inputs (criteria fingerprint or base SHA)
 * have changed. Invariant: regenerated exactly when its inputs change, and never
 * mid-streak.
 */
export declare function shouldRegenerate(input: RegenInput): boolean;
