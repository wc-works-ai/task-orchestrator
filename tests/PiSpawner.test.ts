import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { TaskState, Status } from '../src/TaskState.js';
import { PiSpawner } from '../src/PiSpawner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const { spawn } = await vi.importMock<typeof import('node:child_process')>('node:child_process');

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function mockChild(): ChildProcess {
  return new MockChild() as unknown as ChildProcess;
}

function setup() {
  const dir = mkdtempSync(resolve('/tmp', 'pi-spawn-'));
  for (const s of ['pending', 'in_progress']) mkdirSync(resolve(dir, s), { recursive: true });
  return dir;
}

function make(dir: string, n: number, name: string, goal?: string): TaskState {
  const d = resolve(dir, 'pending', `T${String(n).padStart(2, '0')}-${name}`);
  mkdirSync(d, { recursive: true });
  const t = new TaskState(d);
  t.status = Status.PENDING;
  if (goal) writeFileSync(resolve(d, 'autoresearch.md'), goal);
  return t;
}

describe('PiSpawner', () => {
  let dir = '';
  beforeEach(() => { dir = setup(); vi.clearAllMocks(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('uses model from task metadata', () => {
    const t = make(dir, 1, 'a', '- **Model:** custom-model\n## Goal\nTest');
    expect(new PiSpawner().modelFor(t)).toBe('custom-model');
  });

  it('falls back to constructor default', () => {
    const t = make(dir, 1, 'a');
    expect(new PiSpawner({ model: 'fallback' }).modelFor(t)).toBe('fallback');
  });

  it('falls back to ORCH_MODEL env var', () => {
    process.env.ORCH_MODEL = 'env-model';
    const t = make(dir, 1, 'a');
    expect(new PiSpawner().modelFor(t)).toBe('env-model');
    delete process.env.ORCH_MODEL;
  });

  it('hardcoded default is owl-alpha', () => {
    expect(new PiSpawner().modelFor(make(dir, 1, 'a'))).toBe('openrouter/owl-alpha');
  });

  it('spawn calls pi with correct model', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, '/tmp/worktree');
    setTimeout(() => mock.emit('close', 0), 5);
    const r = await p;
    expect(r.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith('pi', expect.arrayContaining(['--model', 'test-model']),
      expect.objectContaining({ cwd: '/tmp/worktree' }));
  });

  it('returns failure on non-zero exit', async () => {
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const p = new PiSpawner().spawn(make(dir, 1, 'a'));
    setTimeout(() => mock.emit('close', 1), 5);
    expect((await p).success).toBe(false);
  });

  it('captures stderr output', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      mock.stderr!.emit('data', Buffer.from('warning: something bad\n'));
      mock.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.success).toBe(true);
    // Agent log should contain stderr output
    const log = readFileSync(join(t.directory, 'agent.log'), 'utf-8');
    expect(log).toContain('warning: something bad');
  });

  it('captures stdout and counts iterations', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, '/tmp/worktree');
    // Emit data before close — each log_experiment = 1 iteration
    setTimeout(() => {
      mock.stdout!.emit('data', Buffer.from('Running...\n'));
      mock.stdout!.emit('data', Buffer.from('log_experiment\n'));
      mock.stdout!.emit('data', Buffer.from('log_experiment\n'));
      mock.stdout!.emit('data', Buffer.from('log_experiment\n'));
      mock.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.iterations).toBe(3);
  });

  it('handles spawn error gracefully', async () => {
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const p = new PiSpawner().spawn(make(dir, 1, 'a'));
    setTimeout(() => mock.emit('error', new Error('spawn failed')), 5);
    expect((await p).success).toBe(false);
  });

  it('error handler ignores late close', async () => {
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const p = new PiSpawner().spawn(make(dir, 1, 'a'));
    setTimeout(() => {
      mock.emit('error', new Error('crash'));
      mock.emit('close', 0); // should be ignored — already settled
    }, 5);
    expect((await p).success).toBe(false);
  });

  it('catches appendFileSync failure on close handler', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    // Delete task directory before close fires so appendFileSync throws
    setTimeout(() => {
      rmSync(t.directory, { recursive: true, force: true });
      mock.emit('close', 0);
    }, 5);
    const r = await p;
    // Should still succeed — catch handles appendFileSync error silently
    expect(r.success).toBe(true);
  });

  it('uses relative path when task is under worktree', async () => {
    // When cwd is a parent of the task directory, #prompt uses a relative path
    // This triggers the startsWith(cwd) true branch (line 79)
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    // Use dir as cwd — task is at dir/pending/T01-a, so startsWith is true
    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => mock.emit('close', 0), 5);
    const r = await p;
    expect(r.success).toBe(true);
  });
});
