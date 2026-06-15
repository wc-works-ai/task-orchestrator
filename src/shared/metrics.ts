export interface Criterion {
  readonly name: string;
  readonly value: number;
}

export interface MetricResult {
  readonly total: number;
  readonly criteria: Criterion[];
}

export function parseMetrics(stdout: string, fallback = 1, only: readonly string[] = []): MetricResult {
  const all = Array.from(stdout.matchAll(/METRIC\s+(\w+)=(\d+)/g), m => ({
    name: m[1]!,
    value: parseInt(m[2]!, 10),
  }));

  // When the task declares its metric name(s), read only those — taking the LAST
  // value emitted for each. A benchmark prints its real metric last, so this
  // ignores foreign metric-shaped lines leaked from echoed subprocess output
  // (e.g. a `METRIC branch_gap=42.5` fixture printed while running a test suite).
  const criteria = only.length > 0
    ? only.flatMap(name => {
        const hits = all.filter(c => c.name === name);
        return hits.length > 0 ? [hits[hits.length - 1]!] : [];
      })
    : all;

  if (criteria.length === 0) return { total: fallback, criteria: [] };

  return {
    total: criteria.reduce((sum, c) => sum + c.value, 0),
    criteria,
  };
}

export function unmetSummary(result: MetricResult): string {
  return result.criteria
    .filter(c => c.value !== 0)
    .map(c => `${c.name}=${c.value}`)
    .join(', ');
}

/** How a benchmark run is classified once we know whether the process failed. */
export type BenchmarkKind = 'ok' | 'crash' | 'no_metrics';

export interface BenchmarkOutcome {
  /** `crash` = process failed/timed out (result unreliable); `no_metrics` = ran
   *  cleanly but emitted no declared METRIC line; `ok` = at least one metric. */
  readonly kind: BenchmarkKind;
  readonly total: number;
  readonly criteria: Criterion[];
}

/**
 * Classify a benchmark run so a crash or a no-op benchmark is never mistaken for
 * ordinary "work remaining". `crashed` (non-zero exit, timeout, spawn error) wins
 * regardless of any metrics printed before the failure, because the run is
 * unreliable. Otherwise an empty (filtered) criteria set means the benchmark
 * measured nothing; a non-empty set is a real metric reading.
 */
export function classifyBenchmark(
  stdout: string,
  crashed: boolean,
  only: readonly string[] = [],
  fallback = 1,
): BenchmarkOutcome {
  const result = parseMetrics(stdout, fallback, only);
  const kind: BenchmarkKind = crashed
    ? 'crash'
    : result.criteria.length === 0
      ? 'no_metrics'
      : 'ok';
  return { kind, total: result.total, criteria: result.criteria };
}
