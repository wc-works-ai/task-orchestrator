import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PiSpawner, killTree } from '../src/PiSpawner.js';
import { memStateDb, seedState, type StateDb } from './helpers.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '' })),
}));

const { execFileSync, spawn } = await vi.importMock<typeof import('node:child_process')>('node:child_process');

/** Read the single per-run agent log file produced in a task directory. */
function readRunLog(taskDir: string): string {
  const name = readdirSync(taskDir).find(f => /^agent-.*\.log$/.test(f));
  if (!name) throw new Error(`no agent run log found in ${taskDir}`);
  return readFileSync(join(taskDir, name), 'utf-8');
}

/** Pattern for the per-run log path printed in the spawn summary. */
const RUN_LOG_LINE = /log: .*[\\/]agent-\d{8}-\d{6}-\d{3}\.log/;

class MockChild extends EventEmitter {
  pid = 4321;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

function mockChild(): ChildProcess {
  return new MockChild() as unknown as ChildProcess;
}

function setup() {
  return mkdtempSync(resolve(tmpdir(), 'pi-spawn-'));
}

function makeWorktree(dir: string): string {
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  return worktree;
}

let s: StateDb;

function make(dir: string, n: number, name: string, goal?: string) {
  return seedState(s, dir, n, name, goal !== undefined ? { autoresearch: goal } : {});
}

function joinedCalls(spy: { mock: { calls: readonly (readonly unknown[])[] } }): string {
  return spy.mock.calls.map((call: readonly unknown[]) => call.map(String).join(' ')).join('\n');
}

describe('PiSpawner', () => {
  let dir = '';
  beforeEach(() => {
    dir = setup();
    s = memStateDb();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete process.env.ORCH_MODEL;
    delete process.env.ORCH_AGENT_LOG_MAX_BYTES;
    delete process.env.ORCH_AGENT_LOG_RAW;
  });
  afterEach(async () => {
    s.db.close();
    vi.useRealTimers();
    delete process.env.ORCH_MODEL;
    delete process.env.ORCH_AGENT_LOG_MAX_BYTES;
    delete process.env.ORCH_AGENT_LOG_RAW;
    await rm(dir, { recursive: true, force: true });
  });

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
  });

  it('uses pi default when no model is configured', () => {
    expect(new PiSpawner().modelFor(make(dir, 1, 'a'))).toBeUndefined();
  });

  it('resolves reasoning from task metadata before defaults', () => {
    const t = make(dir, 1, 'a', '- **Reasoning:** high\n## Goal\nTest');
    expect(new PiSpawner({ reasoning: 'medium' }).resolveReasoning(t)).toBe('high');
  });

  it('falls back to configured reasoning without changing pi args', async () => {
    const t = make(dir, 1, 'a');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner({ reasoning: 'high' }).spawn(t, dir);
    setTimeout(() => mock.emit('close', 0), 5);
    expect((await p).success).toBe(true);
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).not.toContain('--reasoning');
    expect(args).not.toContain('--reasoning-effort');
  });

  it('returns undefined reasoning when neither task nor defaults configure it', () => {
    expect(new PiSpawner().resolveReasoning(make(dir, 1, 'a'))).toBeUndefined();
  });

  it('spawn calls pi with correct model', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const worktree = makeWorktree(dir);

    const p = new PiSpawner().spawn(t, worktree);
    setTimeout(() => mock.emit('close', 0), 5);
    const r = await p;
    expect(r.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith('pi', expect.arrayContaining(['--model', 'test-model']),
      expect.objectContaining({ cwd: worktree }));
  });

  it('omits --model so pi can use its default when no model is configured', async () => {
    const t = make(dir, 1, 'a');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const worktree = makeWorktree(dir);

    const p = new PiSpawner().spawn(t, worktree);
    setTimeout(() => mock.emit('close', 0), 5);
    const r = await p;
    expect(r.success).toBe(true);
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).not.toContain('--model');
  });

  it('prints spawn context without internal agent events', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nReview Azure DevOps PR 981660 for FabricSparkCST and write a concise report');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p = new PiSpawner().spawn(t, dir);
      setTimeout(() => {
        mock.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', arguments: { command: 'npm run t' } }) + '\n'));
        mock.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'tool_execution_end', toolName: 'bash', result: { content: [{ type: 'text', text: 'METRIC branch_gap=42.5\nnested test output' }] } }) + '\n'));
        mock.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'tool_execution_end', toolName: 'log_experiment', result: { content: [{ type: 'text', text: 'Logged #1: keep\nmore' }] } }) + '\n'));
        mock.emit('close', 0);
      }, 5);
      const r = await p;
      expect(r.success).toBe(true);
      const output = joinedCalls(logSpy);
      expect(output).toContain('T1 agent: test-model');
      expect(output).toContain('task: Review Azure DevOps PR 981660 for FabricSparkCST and write a concise report');
      expect(output).toContain(`worktree: ${dir}`);
      expect(output).toMatch(RUN_LOG_LINE);
      expect(output).not.toContain('status: agent running');
      expect(output).not.toContain('npm run t');
      expect(output).not.toContain('METRIC branch_gap=42.5');
      expect(output).not.toContain('Logged #1: keep');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns a combined auth failure when every model fails authentication', async () => {
    const primary = mockChild();
    const fallback = mockChild();
    vi.mocked(spawn).mockReturnValueOnce(primary).mockReturnValueOnce(fallback);

    const p = new PiSpawner({ model: 'gpt-5.5', fallbackModel: 'backup-model' }).spawn(make(dir, 1, 'a'));
    setTimeout(() => {
      primary.stderr!.emit('data', Buffer.from('No API key found for azure-openai-responses.\n'));
      primary.emit('close', 1);
    }, 5);
    setTimeout(() => {
      fallback.stderr!.emit('data', Buffer.from('No API key found for backup-provider.\n'));
      fallback.emit('close', 1);
    }, 10);

    const r = await p;
    expect(r.success).toBe(false);
    expect(r.authFailure).toBe(true);
    expect(r.error).toContain('azure-openai-responses');
    expect(r.error).toContain('backup-provider');
  });

  it('truncates long task descriptions in the spawn summary', async () => {
    const t = make(dir, 1, 'a', `## Goal\n${'long '.repeat(80)}`);
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p = new PiSpawner().spawn(t, dir);
      setTimeout(() => mock.emit('close', 0), 5);
      const r = await p;
      expect(r.success).toBe(true);
      expect(joinedCalls(logSpy)).toContain('...');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('suppresses duplicate quiet-status lines until the interval elapses again', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p = new PiSpawner({
        progressTimeout: 500,
        progressCheckInterval: 10,
        progressStatusInterval: 40,
      }).spawn(t, dir);

      // Wait 55ms: safely within one interval [40, 80) so exactly 1 status line fires
      await new Promise(r => setTimeout(r, 55));
      const statusLines = joinedCalls(logSpy).split('\n').filter(line => line.includes('WARN still running:'));
      expect(statusLines.length).toBe(1);

      mock.emit('close', 0);
      await p;
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints periodic running status without internal agent output', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p = new PiSpawner({
        progressTimeout: 500,
        progressCheckInterval: 20,
        progressStatusInterval: 40,
      }).spawn(t, dir);

      await new Promise(r => setTimeout(r, 90));
      const output = joinedCalls(logSpy);
      expect(output).toContain('WARN still running: no output for');
      expect(output).toContain('(auto-stop at 500ms)');
      expect(output).not.toContain('running: last agent output');
      expect(output).toMatch(RUN_LOG_LINE);

      mock.emit('close', 0);
      const r = await p;
      expect(r.success).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('formats second-based timeouts in quiet status output', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p = new PiSpawner({
        progressTimeout: 1500,
        progressCheckInterval: 20,
        progressStatusInterval: 20,
      }).spawn(t, dir);

      await new Promise(r => setTimeout(r, 50));
      expect(joinedCalls(logSpy)).toContain('(auto-stop at 2s)');

      mock.emit('close', 0);
      await p;
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns failure on non-zero exit', async () => {
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const p = new PiSpawner().spawn(make(dir, 1, 'a'));
    setTimeout(() => mock.emit('close', 1), 5);
    expect((await p).success).toBe(false);
  });

  it('reports unknown when pi exits without a code', async () => {
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const p = new PiSpawner().spawn(make(dir, 1, 'a'));
    setTimeout(() => mock.emit('close', null), 5);
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.error).toBe('pi exited with code unknown');
  });

  it('returns auth failure when pi reports missing provider key', async () => {
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const p = new PiSpawner({ model: 'gpt-5.5' }).spawn(make(dir, 1, 'a'));
      setTimeout(() => {
        mock.stderr!.emit('data', Buffer.from('No API key found for azure-openai-responses.\n'));
        mock.emit('close', 1);
      }, 5);
      const r = await p;
      expect(r.success).toBe(false);
      expect(r.authFailure).toBe(true);
      expect(r.error).toBe('No API key found for azure-openai-responses');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR auth: No API key found for azure-openai-responses'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('tries fallback model after primary auth failure', async () => {
    const primary = mockChild();
    const fallback = mockChild();
    vi.mocked(spawn).mockReturnValueOnce(primary).mockReturnValueOnce(fallback);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const p = new PiSpawner({ model: 'gpt-5.5', fallbackModel: 'backup-model' }).spawn(make(dir, 1, 'a'));
      setTimeout(() => {
        primary.stderr!.emit('data', Buffer.from('No API key found for azure-openai-responses.\n'));
        primary.emit('close', 1);
      }, 5);
      setTimeout(() => fallback.emit('close', 0), 10);
      const r = await p;
      expect(r.success).toBe(true);
      expect(r.authFailure).toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('omits raw stderr output from agent log by default', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      mock.stderr!.emit('data', Buffer.from('warning: something bad\n'));
      mock.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.success).toBe(true);
    const log = readRunLog(t.directory);
    expect(log).toContain('agent log mode: summary');
    expect(log).toContain('raw output bytes=23 omitted');
    expect(log).not.toContain('warning: something bad');
  });

  it('captures raw stderr output when raw agent logging is enabled', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner({ agentLogRaw: true }).spawn(t, dir);
    setTimeout(() => {
      mock.stderr!.emit('data', Buffer.from('warning: something bad\n'));
      mock.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.success).toBe(true);
    const log = readRunLog(t.directory);
    expect(log).toContain('agent log mode: raw');
    expect(log).toContain('warning: something bad');
    expect(log).toContain('raw output bytes=23 logged');
  });

  it('returns no token usage when assistant usage is missing', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      mock.stdout!.emit('data', Buffer.from(JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: null },
      }) + '\n'));
      mock.emit('close', 0);
    }, 5);

    const r = await p;
    expect(r.success).toBe(true);
    expect(r.tokenUsage).toBeUndefined();
  });

  it('treats non-numeric usage fields as zero', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      mock.stdout!.emit('data', Buffer.from(JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 'oops', output: 'nope' } },
      }) + '\n'));
      mock.emit('close', 0);
    }, 5);

    const r = await p;
    expect(r.success).toBe(true);
    expect(r.tokenUsage).toBeUndefined();
  });

  it('captures stdout and counts iterations', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const worktree = makeWorktree(dir);

    const p = new PiSpawner().spawn(t, worktree);
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

  it('totals assistant message_end token usage and writes it to agent log', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => {
      mock.stdout!.emit('data', Buffer.from(JSON.stringify({
        type: 'message_update',
        message: {
          role: 'assistant',
          usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, totalTokens: 999 },
        },
      }) + '\n'));
      mock.stdout!.emit('data', Buffer.from(JSON.stringify({
        type: 'message_end',
        message: {
          role: 'user',
          usage: { input: 50, output: 50, cacheRead: 50, cacheWrite: 50, totalTokens: 200 },
        },
      }) + '\n'));
      mock.stdout!.emit('data', Buffer.from(JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 0, totalTokens: 112 },
        },
      }) + '\n'));
      mock.stdout!.emit('data', Buffer.from(JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 18 },
        },
      }) + '\n'));
      mock.emit('close', 0);
    }, 5);

    const r = await p;
    expect(r.success).toBe(true);
    expect(r.tokenUsage).toEqual({
      input: 13,
      output: 6,
      cacheRead: 105,
      cacheWrite: 6,
      totalTokens: 130,
    });
    const log = readRunLog(t.directory);
    expect(log).toContain('=== token usage total=130 input=13 output=6 cacheRead=105 cacheWrite=6 ===');
  });

  it('caps large agent output in the log without breaking scanners', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const p = new PiSpawner({ agentLogMaxBytes: 4096, agentLogRaw: true }).spawn(t, dir);
      setTimeout(() => {
        mock.stdout!.emit('data', Buffer.from('x'.repeat(1_100_000)));
        mock.stdout!.emit('data', Buffer.from('log_'));
        mock.stdout!.emit('data', Buffer.from('experiment\n'));
        mock.stdout!.emit('data', Buffer.from(JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
          },
        }) + '\n'));
        mock.stderr!.emit('data', Buffer.from('No API key found for azure-openai-responses.\n'));
        mock.emit('close', 1);
      }, 5);

      const r = await p;
      expect(r.success).toBe(false);
      // Auth error appears AFTER iterations — so it's not treated as an auth
      // failure (real auth failures prevent any iterations from starting).
      expect(r.authFailure).toBeUndefined();
      expect(r.error).toBe('pi exited with code 1');
      expect(r.iterations).toBe(1);
      expect(r.tokenUsage).toEqual({
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
      });
      const log = readRunLog(t.directory);
      expect(Buffer.byteLength(log)).toBeLessThanOrEqual(4096);
      expect(log).toContain('agent.log truncated; keeping latest output only');
      expect(log).toContain('=== token usage total=10 input=1 output=2 cacheRead=3 cacheWrite=4 ===');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('falls back to the default agent log size when configured bytes are invalid', async () => {
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    const p = new PiSpawner({ agentLogMaxBytes: 0 }).spawn(make(dir, 1, 'a'));
    setTimeout(() => mock.emit('close', 0), 5);

    expect((await p).success).toBe(true);
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
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);

    // Use dir as cwd — task is at dir/pending/T01-a, so startsWith is true
    const p = new PiSpawner().spawn(t, dir);
    setTimeout(() => mock.emit('close', 0), 5);
    const r = await p;
    expect(r.success).toBe(true);
  });

  it('uses the absolute task path when cwd is outside the task directory', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const worktree = makeWorktree(dir);

    const p = new PiSpawner().spawn(t, worktree);
    setTimeout(() => mock.emit('close', 0), 5);

    const r = await p;
    expect(r.success).toBe(true);
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1];
    const prompt = args?.[args.indexOf('-p') + 1];
    expect(String(prompt)).toContain(`Step 1: Read ${t.directory}/autoresearch.md.`);
    expect(String(prompt)).toContain('Step 2: From the current worktree/repo root, read AGENTS.md if present.');
    expect(String(prompt)).toContain('Step 3: Read docs/DEVELOP.md and docs/TESTING.md if present.');
    expect(String(prompt)).toContain('Step 5: Respect local worktree environment/configuration');
  });

  it('ignores invalid pids when killing a tree', () => {
    killTree(0);

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('swallows taskkill failures while stopping a process tree', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('taskkill failed');
    });

    expect(() => killTree(1234)).not.toThrow();
  });

  // ── Internal NDJSON output remains quiet on the main terminal ─────────────

  it('handles internal tool_execution_start with path arg', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('handles internal tool_execution_start with command arg', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('handles internal tool_execution_start with no path or command', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('handles internal tool_execution_end with METRIC line', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('handles internal tool_execution_end with log_experiment keep', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('handles internal tool_execution_end with log_experiment crash', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('handles internal tool_execution_end with log_experiment discard', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('handles internal tool_execution_end with isError', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('progress timeout waits for close before resolving', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = new PiSpawner({ progressTimeout: 50, progressCheckInterval: 25 }).spawn(t, dir);
      let resolved = false;
      void p.then(() => { resolved = true; });

      await vi.advanceTimersByTimeAsync(50);
      expect(mock.kill).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(resolved).toBe(false);

      mock.emit('close', 1);
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toContain('No agent output for');
      expect(result.error).not.toContain('pi exited with code');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stopped pi'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('abort resolves after force-kill escalation when child ignores kill', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    vi.mocked(execFileSync).mockImplementation(() => {
      mock.emit('close', null);
      return Buffer.alloc(0);
    });
    vi.useFakeTimers();
    const controller = new AbortController();

    const p = new PiSpawner().spawn(t, dir, controller.signal);
    let resolved = false;
    void p.then(() => { resolved = true; });

    controller.abort();
    expect(mock.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toBe('pi spawn aborted');
    expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/pid', String(mock.pid), '/T', '/F'], { stdio: 'ignore' });
  });

  it('progress timeout force-resolves when close never arrives', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const p = new PiSpawner({ progressTimeout: 50, progressCheckInterval: 25 }).spawn(t, dir);
      await vi.advanceTimersByTimeAsync(10_050);
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toContain('No agent output for');
      expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/pid', String(mock.pid), '/T', '/F'], { stdio: 'ignore' });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('progress timeout does not kill when output continues', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
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

  it('prints activity heartbeat when agent is actively producing output', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p = new PiSpawner({
        progressTimeout: 2000,
        progressCheckInterval: 15,
        progressStatusInterval: 40,
      }).spawn(t, dir);

      // Emit enough data to exercise KB formatting in heartbeat
      const chunk = Buffer.from('x'.repeat(2048) + '\n');
      const interval = setInterval(() => {
        mock.stdout!.emit('data', chunk);
      }, 10);

      // Wait long enough for 1-2 heartbeat intervals to fire
      await new Promise(r => setTimeout(r, 100));
      clearInterval(interval);
      mock.emit('close', 0);
      await p;

      const output = joinedCalls(logSpy);
      expect(output).toContain('agent working:');
      expect(output).toContain('elapsed');
      expect(output).toContain('waiting for first LLM response');
      // Should NOT show the silence warning (agent was active)
      expect(output).not.toContain('WARN still running');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('activity heartbeat shows token usage when LLM has responded', async () => {
    const t = make(dir, 1, 'a', '- **Model:** test-model\n## Goal\nTest');
    const mock = mockChild();
    vi.mocked(spawn).mockReturnValue(mock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p = new PiSpawner({
        progressTimeout: 2000,
        progressCheckInterval: 10,
        progressStatusInterval: 30,
      }).spawn(t, dir);

      // Emit a message_end with token usage so heartbeat shows real counts
      mock.stdout!.emit('data', Buffer.from(JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, totalTokens: 350 } },
      }) + '\n'));
      await new Promise(r => setTimeout(r, 60));
      mock.emit('close', 0);
      await p;

      const output = joinedCalls(logSpy);
      expect(output).toContain('tokens: 350');
      expect(output).toContain('input=100');
      expect(output).toContain('output=50');
      expect(output).toContain('cached=200');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('allows configuring progress timeout', async () => {
    // Just verify we can construct with different values without error
    expect(() => new PiSpawner({ progressTimeout: 5000 })).not.toThrow();
    expect(() => new PiSpawner({ progressTimeout: 0 })).not.toThrow();
    expect(() => new PiSpawner({})).not.toThrow();
  });

  it('killTree does not throw for a missing pid', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('missing process');
    });

    expect(() => killTree(999_999)).not.toThrow();
  });
});
