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
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Read the benchmark provenance sidecar. Returns null when it is missing or
 *  unparseable — callers treat that as "regenerate", which is always safe. */
export function readMeta(dir: string): BenchmarkMeta | null {
  try {
    return JSON.parse(readFileSync(join(dir, META_FILE), 'utf-8')) as BenchmarkMeta;
  } catch {
    return null;
  }
}

export function writeMeta(dir: string, meta: BenchmarkMeta): void {
  writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2) + '\n');
}

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
export function shouldRegenerate(input: RegenInput): boolean {
  if (input.convergenceCount > 0) return false;
  if (!input.benchmarkExists || input.meta === null) return true;
  if (input.meta.fingerprint !== input.fingerprint) return true;
  return input.meta.base !== input.baseSha;
}
