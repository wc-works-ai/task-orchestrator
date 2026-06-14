import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine } from '../src/Engine.js';
import { memStateDb, seed, setupTestDir, type StateDb } from './helpers.js';

describe('Engine logging', () => {
  const originalLogLevel = process.env.ORCH_LOG_LEVEL;
  let dir = '';
  let s: StateDb;

  beforeEach(() => {
    dir = setupTestDir('.test-engine-logging-');
    s = memStateDb();
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.ORCH_LOG_LEVEL;
    else process.env.ORCH_LOG_LEVEL = originalLogLevel;
    vi.restoreAllMocks();
    s.db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('quiet mode suppresses routine console lines but keeps full orchestrator.log history', async () => {
    seed(s.db, dir, 1, 'quiet', { maxFailures: 1 });
    process.env.ORCH_LOG_LEVEL = 'quiet';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await new Engine(dir, { benchmark: () => 1, taskDb: s.tdb }).tick();

    const consoleText = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(consoleText).not.toContain('check: metric=');
    expect(consoleText).toContain('stopping: metric is still 1 after 1/1 failed attempts; no retries left');

    const fileText = readFileSync(resolve(dir, 'orchestrator.log'), 'utf-8');
    expect(fileText).toContain('check: metric=');
    expect(fileText).toContain('stopping: metric is still 1 after 1/1 failed attempts; no retries left');
  });
});
