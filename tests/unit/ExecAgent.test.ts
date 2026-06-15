import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ExecAgent } from '../../src/agent/ExecAgent.js';
import { memStateDb, seedState, type StateDb } from '../shared/helpers.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const { spawn } = await vi.importMock<typeof import('node:child_process')>('node:child_process');

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

function mockChild(): ChildProcess {
  return new MockChild() as unknown as ChildProcess;
}

let s: StateDb;

function make(dir: string, content = '## Goal\nTest') {
  return seedState(s, dir, 1, 'exec', { autoresearch: content });
}

describe('ExecAgent', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), '.test-exec-'));
    s = memStateDb();
    vi.clearAllMocks();
    delete process.env.ORCH_AGENT_CMD;
    delete process.env.ORCH_AGENT_LOG_MAX_BYTES;
  });

  afterEach(async () => {
    s.db.close();
    delete process.env.ORCH_AGENT_CMD;
    delete process.env.ORCH_AGENT_LOG_MAX_BYTES;
    await rm(dir, { recursive: true, force: true });
  });

  it('exposes the exec name', () => {
    expect(new ExecAgent().name).toBe('exec');
  });

  it('checkPrerequisites is ok when ORCH_AGENT_CMD is set', () => {
    process.env.ORCH_AGENT_CMD = 'node build-agent.js';
    const result = new ExecAgent().checkPrerequisites();

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('command');
    expect(result[0]!.ok).toBe(true);
    expect(result[0]!.message).toContain('node build-agent.js');
  });

  it('checkPrerequisites is not ok when ORCH_AGENT_CMD is unset', () => {
    delete process.env.ORCH_AGENT_CMD;
    const result = new ExecAgent().checkPrerequisites();

    expect(result).toHaveLength(1);
    expect(result[0]!.ok).toBe(false);
    expect(result[0]!.message).toBe('set ORCH_AGENT_CMD to the command to run as the agent');
  });

  it('runs the configured command via the shell and resolves success on exit 0', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const worktree = join(dir, 'worktree');
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent().spawn(make(dir), worktree);
    setTimeout(() => child.emit('close', 0), 5);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.logPath).toBeDefined();
    expect(spawn).toHaveBeenCalledWith('run-agent', expect.objectContaining({
      cwd: worktree,
      shell: true,
    }));
  });

  it('passes orchestrator context as environment variables', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const worktree = join(dir, 'worktree');
    const task = make(dir);
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent().spawn(task, worktree);
    setTimeout(() => child.emit('close', 0), 5);
    await promise;

    expect(spawn).toHaveBeenCalledWith('run-agent', expect.objectContaining({
      env: expect.objectContaining({
        ORCH_TASK_NUMBER: '1',
        ORCH_TASK_DIR: task.directory,
        ORCH_WORKTREE: worktree,
        ORCH_GOAL: 'Test',
      }),
    }));
  });

  it('defaults cwd to the task directory when no worktree is given', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const task = make(dir);
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent().spawn(task);
    setTimeout(() => child.emit('close', 0), 5);
    await promise;

    expect(spawn).toHaveBeenCalledWith('run-agent', expect.objectContaining({
      cwd: task.directory,
      env: expect.objectContaining({ ORCH_WORKTREE: task.directory }),
    }));
  });

  it('resolves failure with an error on non-zero exit', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent().spawn(make(dir), dir);
    setTimeout(() => child.emit('close', 3), 5);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.iterations).toBe(1);
    expect(result.error).toBe('agent command exited with code 3');
  });

  it('resolves failure with the spawn error message', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent().spawn(make(dir), dir);
    setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 5);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.iterations).toBe(1);
    expect(result.error).toBe('spawn ENOENT');
  });

  it('kills the child and fails when aborted', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);
    const ac = new AbortController();

    const promise = new ExecAgent().spawn(make(dir), dir, ac.signal);
    ac.abort();
    setTimeout(() => child.emit('close', null), 5);
    const result = await promise;

    expect(child.kill).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe('exec agent aborted');
  });

  it('ignores a late close after an error', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent().spawn(make(dir), dir);
    setTimeout(() => {
      child.emit('error', new Error('boom'));
      child.emit('close', 0);
    }, 5);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('writes the session header and child output to the agent log', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const task = make(dir);
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent().spawn(task, dir);
    setTimeout(() => {
      child.stdout!.emit('data', Buffer.from('hello stdout\n'));
      child.stderr!.emit('data', Buffer.from('oops stderr\n'));
      child.emit('close', 0);
    }, 5);
    const result = await promise;

    expect(result.success).toBe(true);
    const logName = readdirSync(task.directory).find(f => /^agent-.*\.log$/.test(f))!;
    const log = readFileSync(join(task.directory, logName), 'utf-8');
    expect(log).toContain('=== exec agent started');
    expect(log).toContain('=== command: run-agent ===');
    expect(log).toContain('hello stdout');
    expect(log).toContain('oops stderr');
    expect(log).toContain('=== exec agent ended (exit 0) ===');
  });

  it('falls back to the default agent log size when configured bytes are invalid', async () => {
    process.env.ORCH_AGENT_CMD = 'run-agent';
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new ExecAgent({ agentLogMaxBytes: 0 }).spawn(make(dir), dir);
    setTimeout(() => child.emit('close', 0), 5);
    const result = await promise;

    expect(result.success).toBe(true);
  });
});
