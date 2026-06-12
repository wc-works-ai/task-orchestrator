import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
      expect(task.metric).toBe('good_metric');
      expect(existsSync(join(task.directory, 'benchmark.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
