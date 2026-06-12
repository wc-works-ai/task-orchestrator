import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { TaskState, Status } from '../src/TaskState.js';
import { CopilotCliAgent } from '../src/CopilotCliAgent.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '' })),
}));

const { spawn } = await vi.importMock<typeof import('node:child_process')>('node:child_process');

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function mockChild(): ChildProcess {
  return new MockChild() as unknown as ChildProcess;
}

function setup(): string {
  const dir = mkdtempSync(resolve(tmpdir(), '.test-copilot-'));
  mkdirSync(resolve(dir, 'pending'), { recursive: true });
  return dir;
}

function make(dir: string, content = '## Goal\nTest'): TaskState {
  const taskDir = resolve(dir, 'pending', 'T01-copilot');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(resolve(taskDir, 'autoresearch.md'), content);
  const task = new TaskState(taskDir);
  task.status = Status.PENDING;
  return task;
}

describe('CopilotCliAgent', () => {
  let dir = '';

  beforeEach(() => {
    dir = setup();
    vi.clearAllMocks();
    delete process.env.ORCH_MODEL;
    delete process.env.ORCH_REASONING;
    delete process.env.ORCH_AGENT_LOG_MAX_BYTES;
  });

  afterEach(async () => {
    delete process.env.ORCH_MODEL;
    delete process.env.ORCH_REASONING;
    delete process.env.ORCH_AGENT_LOG_MAX_BYTES;
    await rm(dir, { recursive: true, force: true });
  });

  it('builds the copilot command with model and reasoning', async () => {
    const task = make(dir);
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent({ model: 'gpt-5.4', reasoning: 'high' }).spawn(task, join(dir, 'worktree'));
    setTimeout(() => child.emit('close', 0), 5);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith('copilot', expect.arrayContaining([
      '-p',
      '-s',
      '--allow-all-tools',
      '--no-ask-user',
      '--model',
      'gpt-5.4',
      '--reasoning-effort',
      'high',
    ]), expect.objectContaining({ cwd: join(dir, 'worktree') }));
  });

  it('uses the configured work directory when no worktree is passed', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent({ workDir: 'Q:\\work-dir' }).spawn(make(dir));
    setTimeout(() => child.emit('close', 0), 5);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith('copilot', expect.any(Array), expect.objectContaining({ cwd: 'Q:\\work-dir' }));
  });

  it('omits model and reasoning args when unset', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent().spawn(make(dir), dir);
    setTimeout(() => child.emit('close', 0), 5);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--reasoning-effort');
  });

  it('uses task metadata before constructor defaults', async () => {
    const task = make(dir, '**Model:** task-model\n**Reasoning:** medium\n## Goal\nTest');
    const agent = new CopilotCliAgent({ model: 'default-model', reasoning: 'high' });
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = agent.spawn(task, dir);
    setTimeout(() => child.emit('close', 0), 5);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).toEqual(expect.arrayContaining(['--model', 'task-model', '--reasoning-effort', 'medium']));
  });

  it('returns failure on non-zero exit', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent().spawn(make(dir), dir);
    setTimeout(() => child.emit('close', 2), 5);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('copilot exited with code 2');
  });

  it('detects auth failures from stdout', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent().spawn(make(dir), dir);
    setTimeout(() => {
      child.stdout!.emit('data', Buffer.from('not logged in: set COPILOT_GITHUB_TOKEN\n'));
      child.emit('close', 1);
    }, 5);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.authFailure).toBe(true);
    expect(result.error).toContain('Copilot CLI authentication failed');
  });

  it('writes agent.log and counts metric iterations', async () => {
    const task = make(dir);
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent().spawn(task, dir);
    setTimeout(() => {
      child.stdout!.emit('data', Buffer.from('METRIC failures=1\n'));
      child.stderr!.emit('data', Buffer.from('METRIC failures=0\n'));
      child.emit('close', 0);
    }, 5);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.tokenUsage).toBeUndefined();
    const log = readFileSync(join(task.directory, 'agent.log'), 'utf-8');
    expect(log).toContain('token usage unavailable');
    expect(log).toContain('METRIC failures=1');
    expect(log).toContain('METRIC failures=0');
  });

  it('honors abort signals', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);
    const ac = new AbortController();

    const promise = new CopilotCliAgent().spawn(make(dir), dir, ac.signal);
    ac.abort();
    setTimeout(() => child.emit('close', null), 5);
    const result = await promise;

    expect(child.kill).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe('copilot spawn aborted');
  });

  it('returns the spawn error message', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent().spawn(make(dir), dir);
    setTimeout(() => child.emit('error', new Error('spawn blew up')), 5);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('spawn blew up');
  });

  it('ignores a late close after an error', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent().spawn(make(dir), dir);
    setTimeout(() => {
      child.emit('error', new Error('spawn blew up'));
      child.emit('close', 0);
    }, 5);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('spawn blew up');
  });

  it('falls back to the default agent log size when configured bytes are invalid', async () => {
    const child = mockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const promise = new CopilotCliAgent({ agentLogMaxBytes: 0 }).spawn(make(dir), dir);
    setTimeout(() => child.emit('close', 0), 5);
    const result = await promise;

    expect(result.success).toBe(true);
  });

});
