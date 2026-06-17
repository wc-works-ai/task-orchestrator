/** One task in the dependency graph. `deps` are the task numbers this task
 *  depends on (they must converge first). */
export interface GraphNode {
  readonly number: number;
  readonly status: string;
  readonly goal: string;
  readonly deps: readonly number[];
}

const GOAL_MAX = 50;

/**
 * Render the task dependency DAG as text. Tasks are listed in topological order
 * (dependencies before dependents) and indented by depth so the structure is
 * visible. `→` lists each task's direct dependencies. Missing dependencies are
 * flagged, and any tasks caught in a cycle are reported separately.
 */
export function formatTaskGraph(nodes: readonly GraphNode[]): string[] {
  if (nodes.length === 0) return ['No tasks.'];

  const byNum = new Map(nodes.map(n => [n.number, n]));
  const presentDeps = (n: GraphNode): number[] => n.deps.filter(d => byNum.has(d));

  // Kahn topological sort, assigning each node a level = longest dependency depth.
  const indeg = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const n of nodes) {
    indeg.set(n.number, presentDeps(n).length);
    for (const d of presentDeps(n)) {
      const arr = dependents.get(d) ?? [];
      arr.push(n.number);
      dependents.set(d, arr);
    }
  }

  const level = new Map<number, number>();
  const emitted: number[] = [];
  let ready = nodes.filter(n => indeg.get(n.number) === 0).map(n => n.number).sort((a, b) => a - b);
  while (ready.length > 0) {
    const cur = ready.shift()!;
    const deps = presentDeps(byNum.get(cur)!);
    level.set(cur, deps.length > 0 ? Math.max(...deps.map(d => level.get(d)!)) + 1 : 0);
    emitted.push(cur);
    const next: number[] = [];
    for (const m of dependents.get(cur) ?? []) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) next.push(m);
    }
    ready = [...ready, ...next].sort((a, b) => a - b);
  }

  const emittedSet = new Set(emitted);
  const cyclic = nodes.filter(n => !emittedSet.has(n.number)).map(n => n.number).sort((a, b) => a - b);

  const fmt = (num: number): string => {
    const n = byNum.get(num)!;
    const indent = '  '.repeat(level.get(num) ?? 0);
    const deps = n.deps.length > 0
      ? '  → ' + n.deps.map(d => byNum.has(d) ? `T${d}` : `T${d}(missing)`).join(', ')
      : '';
    const goal = n.goal.length > GOAL_MAX ? n.goal.slice(0, GOAL_MAX - 3) + '...' : n.goal;
    return `${indent}T${num} [${n.status}]${goal ? ' ' + goal : ''}${deps}`;
  };

  const lines = ['Task dependency graph (→ depends on):', ''];
  for (const num of emitted) lines.push(fmt(num));
  if (cyclic.length > 0) {
    lines.push('', `cycle detected among: ${cyclic.map(n => `T${n}`).join(', ')}`);
    for (const num of cyclic) lines.push(fmt(num));
  }
  return lines;
}
