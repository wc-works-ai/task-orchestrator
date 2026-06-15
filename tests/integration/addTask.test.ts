import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addTask } from '../../src/addTask.js';
import { TaskDb } from '../../src/TaskDb.js';

const dirs: string[] = [];

function tasksDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'add-task-test-'));
  dirs.push(dir);
  return dir;
}

/** Read the persisted row for a task number. */
function row(dir: string, taskNumber: number) {
  const tdb = TaskDb.open(join(dir, 'state.db'));
  try {
    return tdb.getByNumber(taskNumber);
  } finally {
    tdb.close();
  }
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('addTask validation', () => {
  it('rejects names with forward slashes', () => {
    expect(() => addTask(tasksDir(), 'foo/bar', {})).toThrow(/Invalid task name/);
  });

  it('rejects names with backslashes', () => {
    expect(() => addTask(tasksDir(), 'foo\\bar', {})).toThrow(/Invalid task name/);
  });

  it('rejects invalid metric names', () => {
    expect(() => addTask(tasksDir(), 'valid-name', { metric: 'x;evil()' })).toThrow(/Invalid metric name/);
  });
});

describe('addTask creation', () => {
  it('numbers tasks sequentially and writes a flat content directory', () => {
    const dir = tasksDir();
    const a = addTask(dir, 'first');
    const b = addTask(dir, 'second');
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(a.directory).toBe(join(dir, 'T01-first'));
    expect(b.directory).toBe(join(dir, 'T02-second'));
  });

  it('publishes the task as PENDING in the database', () => {
    const dir = tasksDir();
    const task = addTask(dir, 'ready-task');
    expect(row(dir, task.number)!.status).toBe('PENDING');
  });

  it('freezes the default retry limit, and stores NULL when retries are unlimited', () => {
    const dir = tasksDir();
    expect(row(dir, addTask(dir, 'default-limit').number)!.max_failures).toBe(5);

    const prev = process.env.ORCH_MAX_FAILURES;
    process.env.ORCH_MAX_FAILURES = 'infinite';
    try {
      expect(row(dir, addTask(dir, 'unlimited').number)!.max_failures).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ORCH_MAX_FAILURES;
      else process.env.ORCH_MAX_FAILURES = prev;
    }
  });

  it('accepts valid metric names and scaffolds benchmark.js', () => {
    const dir = tasksDir();
    const task = addTask(dir, 'valid-name', { metric: 'good_metric' });
    const benchmark = readFileSync(join(task.directory, 'benchmark.js'), 'utf-8');
    expect(task.metric).toBe('good_metric');
    expect(existsSync(join(task.directory, 'benchmark.js'))).toBe(true);
    expect(benchmark).toContain("check('good_metric', 'node -e \"process.exit(1)\"');");
    // Gate separation: repo-wide build/test stay in ORCH_VERIFY_CMD, not the benchmark.
    expect(benchmark).not.toContain("check('build'");
    expect(benchmark).not.toContain("check('test'");
  });

  it('writes an explicit scope when provided', () => {
    const dir = tasksDir();
    const task = addTask(dir, 'scoped-task', { scope: ['src\\a.ts', 'src\\b.ts'] });
    expect(readFileSync(join(task.directory, 'autoresearch.md'), 'utf-8')).toContain('- src\\a.ts\n- src\\b.ts');
  });

  it('writes a benchmark scaffold and convergence guidance', () => {
    const dir = tasksDir();
    const task = addTask(dir, 'scaffolded-task');
    const benchmark = readFileSync(join(task.directory, 'benchmark.js'), 'utf-8');
    const autoresearch = readFileSync(join(task.directory, 'autoresearch.md'), 'utf-8');

    expect(benchmark).toContain("import { execSync } from 'node:child_process';");
    expect(benchmark).toContain('const check = (name, command) => {');
    expect(benchmark).toContain("check('goal', 'node -e \"process.exit(1)\"');");
    expect(benchmark).toContain('via ORCH_VERIFY_CMD');

    expect(autoresearch).toContain('## Acceptance criteria');
    expect(autoresearch).toContain('- `goal` —');
    expect(autoresearch).toContain('keep them out of benchmark.js');
    expect(autoresearch).toContain('- Convergence requires 3 consecutive zero runs');
  });
});

describe('addTask target branch', () => {
  it('persists an explicit targetBranch in the database', () => {
    const dir = tasksDir();
    const task = addTask(dir, 'branched-task', { targetBranch: 'develop' });
    expect(task.targetBranch).toBe('develop');
    expect(row(dir, task.number)!.target_branch).toBe('develop');
  });

  it('auto-detects targetBranch from git HEAD when repoDir is a git repo', () => {
    const dir = tasksDir();
    const task = addTask(dir, 'auto-branch-task', { repoDir: process.cwd() });
    expect(typeof task.targetBranch).toBe('string');
    expect(row(dir, task.number)!.target_branch).toBe(task.targetBranch);
  });

  it('stores NULL targetBranch when there is no git and no explicit branch', () => {
    const dir = tasksDir();
    const task = addTask(dir, 'no-git-task', { repoDir: dir });
    expect(task.targetBranch).toBeUndefined();
    expect(row(dir, task.number)!.target_branch).toBeNull();
  });
});
