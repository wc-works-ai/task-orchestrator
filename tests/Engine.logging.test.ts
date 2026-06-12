import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine } from '../src/Engine.js';
import { Status, TaskState } from '../src/TaskState.js';

function setup(): string {
  const dir = mkdtempSync(resolve(tmpdir(), '.test-engine-logging-'));
  for (const shard of ['pending', 'in_progress', 'converged', 'failed', 'blocked']) {
    mkdirSync(resolve(dir, shard), { recursive: true });
  }
  return dir;
}

function make(dir: string): TaskState {
  const taskDir = resolve(dir, 'pending', 'T01-quiet');
  mkdirSync(taskDir, { recursive: true });
  const task = new TaskState(taskDir);
  task.status = Status.PENDING;
  writeFileSync(join(task.directory, 'autoresearch.md'), '- **Retry limit:** 1\n');
  return task;
}

describe('Engine logging', () => {
  const originalLogLevel = process.env.ORCH_LOG_LEVEL;
  let dir = '';

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.ORCH_LOG_LEVEL;
    else process.env.ORCH_LOG_LEVEL = originalLogLevel;
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('quiet mode suppresses routine console lines but keeps full orchestrator.log history', async () => {
    dir = setup();
    make(dir);
    process.env.ORCH_LOG_LEVEL = 'quiet';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await new Engine(dir, { benchmark: () => 1 }).tick();

    const consoleText = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(consoleText).not.toContain('check: metric=');
    expect(consoleText).toContain('stopping: metric is still 1 after 1/1 failed attempts; no retries left');

    const fileText = readFileSync(resolve(dir, 'orchestrator.log'), 'utf-8');
    expect(fileText).toContain('check: metric=');
    expect(fileText).toContain('stopping: metric is still 1 after 1/1 failed attempts; no retries left');
  });
});
