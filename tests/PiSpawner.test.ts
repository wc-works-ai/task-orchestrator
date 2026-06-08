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
  kill = vi.fn();
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

  // ── #printEvent branch coverage ──────────────────────────────────────────

  it('prints tool_execution_start with path arg', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_start', toolName: 'read', arguments: { path: '/foo.ts' } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('prints tool_execution_start with command arg', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', arguments: { command: 'npm test' } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('prints tool_execution_start with no path or command', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_start', toolName: 'init_experiment', arguments: {} });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('prints tool_execution_end with METRIC line', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'run_experiment', result: { content: [{ type: 'text', text: 'METRIC branch_gap=42.5\nsome output' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('prints tool_execution_end with log_experiment keep', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'log_experiment', result: { content: [{ type: 'text', text: 'Logged #1: keep — description here\nmore' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('prints tool_execution_end with log_experiment crash', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'log_experiment', result: { content: [{ type: 'text', text: 'crash detected\nmore' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('prints tool_execution_end with log_experiment discard (no keep/crash)', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'log_experiment', result: { content: [{ type: 'text', text: 'discarded run\nmore' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('prints tool_execution_end with isError', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'read', isError: true, result: { content: [{ type: 'text', text: 'error output' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles tool_execution_end with non-text content', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'image', data: 'abc' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles tool_execution_end with no content array', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'read', result: {} });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles unknown event type', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      var ev = JSON.stringify({ type: 'message_start', message: { role: 'user' } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles tool_execution_start with name fallback', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      // No toolName, only name — tests the fallback: obj.toolName ?? obj.name
      var ev = JSON.stringify({ type: 'tool_execution_start', name: 'write', arguments: { path: '/bar.ts' } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('skips whitespace lines in NDJSON stream', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      // Emit a whitespace-only line to hit !raw.trim() continue
      mock.stdout!.emit('data', Buffer.from('  \n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles event with no type field', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      // No type field — tests obj.type ?? '' fallback (line 124)
      var ev = JSON.stringify({ notType: 'something' });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles tool_execution_start with no name and no arguments', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      // No toolName, no name, no arguments — tests all ?? fallbacks
      var ev = JSON.stringify({ type: 'tool_execution_start' });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles tool_execution_end with no toolName', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      // No toolName — tests obj.toolName ?? '' fallback in tool_execution_end
      var ev = JSON.stringify({ type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'some output' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  it('handles log_experiment with empty text content', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      // Empty text content — tests if (line) else branch
      var ev = JSON.stringify({ type: 'tool_execution_end', toolName: 'log_experiment', result: { content: [{ type: 'text', text: '' }] } });
      mock.stdout!.emit('data', Buffer.from(ev + '\n'));
      mock.emit('close', 0);
    }, 5);
    var r = await p;
    expect(r.success).toBe(true);
  });

  // ── Progress timeout ───────────────────────────────────────────────

  it('progress timeout kills child when no output within timeout', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    // Use check interval > timeout so only ONE check fires past the timeout
    // First check at ~100ms: diff=100ms >= 50ms → kill once, clearInterval, done
    const p = new PiSpawner({ progressTimeout: 50, progressCheckInterval: 100 }).spawn(t, dir);

    const result = await p;
    expect(result.success).toBe(false);
    expect(mock.kill).toHaveBeenCalled();
  });

  it('progress timeout does not kill when output continues', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    t.status = Status.PENDING;
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    // Emit data before the first progress check fires to keep progress alive
    const p = new PiSpawner({ progressTimeout: 500, progressCheckInterval: 50 }).spawn(t, dir);

    // Emit data to keep progress alive
    await new Promise(r => setTimeout(r, 30));
    mock.stdout!.emit('data', Buffer.from('working...\n'));

    // Wait past the first check (at 50ms), progress was updated at ~30ms, diff=50ms < 500
    await new Promise(r => setTimeout(r, 100));
    expect(mock.kill).not.toHaveBeenCalled();

    // Close successfully
    mock.emit('close', 0);
    const result = await p;
    expect(result.success).toBe(true);
    expect(mock.kill).not.toHaveBeenCalled();
  });

  it('allows configuring progress timeout', async () => {
    // Just verify we can construct with different values without error
    expect(() => new PiSpawner({ progressTimeout: 5000 })).not.toThrow();
    expect(() => new PiSpawner({ progressTimeout: 0 })).not.toThrow();
    expect(() => new PiSpawner({})).not.toThrow();
  });
});
