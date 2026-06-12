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
