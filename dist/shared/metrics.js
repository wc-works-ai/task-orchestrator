export function parseMetrics(stdout, fallback = 1, only = []) {
    const all = Array.from(stdout.matchAll(/METRIC\s+(\w+)=(\d+)/g), m => ({
        name: m[1],
        value: parseInt(m[2], 10),
    }));
    // When the task declares its metric name(s), read only those — taking the LAST
    // value emitted for each. A benchmark prints its real metric last, so this
    // ignores foreign metric-shaped lines leaked from echoed subprocess output
    // (e.g. a `METRIC branch_gap=42.5` fixture printed while running a test suite).
    const criteria = only.length > 0
        ? only.flatMap(name => {
            const hits = all.filter(c => c.name === name);
            return hits.length > 0 ? [hits[hits.length - 1]] : [];
        })
        : all;
    if (criteria.length === 0)
        return { total: fallback, criteria: [] };
    return {
        total: criteria.reduce((sum, c) => sum + c.value, 0),
        criteria,
    };
}
export function unmetSummary(result) {
    return result.criteria
        .filter(c => c.value !== 0)
        .map(c => `${c.name}=${c.value}`)
        .join(', ');
}
/**
 * Classify a benchmark run so a crash or a no-op benchmark is never mistaken for
 * ordinary "work remaining". `crashed` (non-zero exit, timeout, spawn error) wins
 * regardless of any metrics printed before the failure, because the run is
 * unreliable. Otherwise an empty (filtered) criteria set means the benchmark
 * measured nothing; a non-empty set is a real metric reading.
 */
export function classifyBenchmark(stdout, crashed, only = [], fallback = 1) {
    const result = parseMetrics(stdout, fallback, only);
    const kind = crashed
        ? 'crash'
        : result.criteria.length === 0
            ? 'no_metrics'
            : 'ok';
    return { kind, total: result.total, criteria: result.criteria };
}
//# sourceMappingURL=metrics.js.map