import { describe, it, expect } from 'vitest';
import { formatTaskGraph, type GraphNode } from '../../src/TaskGraph.js';

function n(number: number, deps: number[] = [], status = 'pending', goal = ''): GraphNode {
  return { number, status, goal, deps };
}

describe('formatTaskGraph', () => {
  it('reports when there are no tasks', () => {
    expect(formatTaskGraph([])).toEqual(['No tasks.']);
  });

  it('lists independent tasks at level 0', () => {
    const out = formatTaskGraph([n(1, [], 'pending', 'A'), n(2, [], 'blocked', 'B')]);
    expect(out).toEqual([
      'Task dependency graph (→ depends on):',
      '',
      'T1 [pending] A',
      'T2 [blocked] B',
    ]);
  });

  it('orders dependencies before dependents and indents by depth', () => {
    // T3 depends on T2 depends on T1
    const out = formatTaskGraph([n(3, [2]), n(1, []), n(2, [1])]);
    expect(out).toEqual([
      'Task dependency graph (→ depends on):',
      '',
      'T1 [pending]',
      '  T2 [pending]  → T1',
      '    T3 [pending]  → T2',
    ]);
  });

  it('renders a diamond with correct levels', () => {
    // T4 depends on T2 and T3; both depend on T1
    const out = formatTaskGraph([n(1), n(2, [1]), n(3, [1]), n(4, [2, 3])]);
    expect(out).toContain('T1 [pending]');
    expect(out).toContain('  T2 [pending]  → T1');
    expect(out).toContain('  T3 [pending]  → T1');
    expect(out).toContain('    T4 [pending]  → T2, T3');
  });

  it('flags missing dependencies', () => {
    const out = formatTaskGraph([n(2, [9])]);
    expect(out).toContain('T2 [pending]  → T9(missing)');
  });

  it('detects and reports cycles', () => {
    // T1 → T2 → T1
    const out = formatTaskGraph([n(1, [2]), n(2, [1])]);
    expect(out.join('\n')).toContain('cycle detected among: T1, T2');
    expect(out).toContain('T1 [pending]  → T2');
    expect(out).toContain('T2 [pending]  → T1');
  });

  it('truncates long goals', () => {
    const longGoal = 'x'.repeat(80);
    const out = formatTaskGraph([n(1, [], 'pending', longGoal)]);
    const line = out.find(l => l.startsWith('T1'))!;
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(80);
  });
});
