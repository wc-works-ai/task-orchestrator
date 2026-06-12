import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addTask } from '../src/addTask.js';

function setupTasksDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'add-task-test-'));
  for (const state of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    rmSync(join(dir, state), { recursive: true, force: true });
  }
  return dir;
}

describe('addTask', () => {
  it('rejects names with forward slashes', () => {
    const dir = setupTasksDir();
    try {
      expect(() => addTask(dir, 'foo/bar', {})).toThrow(/Invalid task name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects names with backslashes', () => {
    const dir = setupTasksDir();
    try {
      expect(() => addTask(dir, 'foo\\bar', {})).toThrow(/Invalid task name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid metric names', () => {
    const dir = setupTasksDir();
    try {
      expect(() => addTask(dir, 'valid-name', { metric: 'x;evil()' })).toThrow(/Invalid metric name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts valid metric names', () => {
    const dir = setupTasksDir();
    try {
      const task = addTask(dir, 'valid-name', { metric: 'good_metric' });
      const benchmark = readFileSync(join(task.directory, 'benchmark.js'), 'utf-8');
      expect(task.metric).toBe('good_metric');
      expect(existsSync(join(task.directory, 'benchmark.js'))).toBe(true);
      expect(benchmark).toContain("check('good_metric', 'node -e \"process.exit(1)\"');");
      expect(benchmark).toContain("check('build', 'npm run c');");
      expect(benchmark).toContain("check('test', 'npm run t');");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips non-task entries when choosing the next task number', () => {
    const dir = setupTasksDir();
    try {
      mkdirSync(join(dir, 'pending', 'random-dir'), { recursive: true });
      mkdirSync(join(dir, 'failed', 'T07-existing-task'), { recursive: true });

      const task = addTask(dir, 'next-task');

      expect(task.number).toBe(8);
      expect(task.directory).toBe(join(dir, 'pending', 'T08-next-task'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes an explicit scope when provided', () => {
    const dir = setupTasksDir();
    try {
      const task = addTask(dir, 'scoped-task', { scope: ['src\\a.ts', 'src\\b.ts'] });

      expect(readFileSync(join(task.directory, 'autoresearch.md'), 'utf-8')).toContain('- src\\a.ts\n- src\\b.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a multi-metric benchmark scaffold and convergence guidance', () => {
    const dir = setupTasksDir();
    try {
      const task = addTask(dir, 'scaffolded-task');
      const benchmark = readFileSync(join(task.directory, 'benchmark.js'), 'utf-8');
      const autoresearch = readFileSync(join(task.directory, 'autoresearch.md'), 'utf-8');

      expect(benchmark).toContain("import { execSync } from 'node:child_process';");
      expect(benchmark).toContain('const check = (name, command) => {');
      expect(benchmark).toContain("check('goal', 'node -e \"process.exit(1)\"');");
      expect(benchmark).toContain('Put repo-wide gates like coverage in ORCH_VERIFY_CMD');

      expect(autoresearch).toContain('## Metrics');
      expect(autoresearch).toContain('- Task benchmark: `benchmark.js` runs task-specific checks and emits `METRIC name=value` lines.');
      expect(autoresearch).toContain('- Global verify: `ORCH_VERIFY_CMD` runs repo-wide gates before merge (for example `npm run tc` for coverage).');
      expect(autoresearch).toContain('- ALL emitted metrics must be 0 for convergence.');
      expect(autoresearch).toContain('- Convergence requires 3 consecutive zero runs.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
