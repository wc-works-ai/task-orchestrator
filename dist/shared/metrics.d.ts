export interface Criterion {
    readonly name: string;
    readonly value: number;
}
export interface MetricResult {
    readonly total: number;
    readonly criteria: Criterion[];
}
export declare function parseMetrics(stdout: string, fallback?: number, only?: readonly string[]): MetricResult;
export declare function unmetSummary(result: MetricResult): string;
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
export declare function classifyBenchmark(stdout: string, crashed: boolean, only?: readonly string[], fallback?: number): BenchmarkOutcome;
