export interface Criterion {
  readonly name: string;
  readonly value: number;
}

export interface MetricResult {
  readonly total: number;
  readonly criteria: Criterion[];
}

export function parseMetrics(stdout: string, fallback = 1): MetricResult {
  const matches = stdout.matchAll(/METRIC\s+(\w+)=(\d+)/g);
  const criteria = Array.from(matches, m => ({
    name: m[1]!,
    value: parseInt(m[2]!, 10),
  }));

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
