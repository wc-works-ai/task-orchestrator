import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskState } from './TaskState.js';
import { env } from './env.js';
import { piCommand } from './PiCommand.js';
import type { SpawnResult } from './Engine.js';



// ── File names ──────────────────────────────────────────────────────────────
const F_AGENT_LOG = 'agent.log';
const AUTH_FAILURE_RE = /No API key found for ([^\s.]+)\./g;
const SUMMARY_MAX = 120;
const PROGRESS_STATUS_INTERVAL = 30_000;

export interface PiSpawnerOptions {
  /** Optional model override when task doesn't specify one */
  readonly model?: string;
  /** Optional fallback model if primary fails */
  readonly fallbackModel?: string;
  /** Working directory for the agent */
  readonly workDir?: string;
  /** Max ms with no output before killing the agent (default: 120_000 / 2 min) */
  readonly progressTimeout?: number;
  /** Interval (ms) for progress checks (default: 10_000). Only overridden in tests. */
  readonly progressCheckInterval?: number;
  /** Min silent time (ms) before quiet running status lines (default: 30_000). Only overridden in tests. */
  readonly progressStatusInterval?: number;
}

export class PiSpawner {
  readonly #model: string | undefined;
  readonly #fallback: string | undefined;
  readonly #workDir: string;
  readonly #progressTimeout: number;
  readonly #progressCheckInterval: number;
  readonly #progressStatusInterval: number;

  constructor(opts: PiSpawnerOptions = {}) {
    this.#model = opts.model || env.model;
    this.#fallback = opts.fallbackModel || undefined;
    this.#workDir = opts.workDir ?? process.cwd();
    this.#progressTimeout = opts.progressTimeout ?? env.progressTimeoutMs;
    this.#progressCheckInterval = opts.progressCheckInterval ?? 10_000;
    this.#progressStatusInterval = opts.progressStatusInterval ?? PROGRESS_STATUS_INTERVAL;
  }

  /** Resolve the model for a task: metadata → constructor → env → pi default */
  modelFor(task: TaskState): string | undefined {
    return task.model || this.#model;
  }

  async spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult> {
    const cwd = worktreePath ?? this.#workDir;
    const primaryModel = this.modelFor(task);
    const models = this.#fallback && this.#fallback !== primaryModel
      ? [primaryModel, this.#fallback]
      : [primaryModel];
    const logPath = join(task.directory, F_AGENT_LOG);

    console.log(`T${task.taskNumber} using ${models.map(PiSpawner.#modelLabel).join(', ')}`);
    console.log(`  task: ${PiSpawner.#shortText(task.goal)}`);
    console.log(`  worktree: ${cwd}`);
    console.log(`  log: ${logPath}`);
    console.log('  status: agent running; details in agent.log');
    const authErrors: string[] = [];
    let lastResult: SpawnResult | undefined;
    let sawNonAuthFailure = false;
    for (const model of models) {
      /* c8 ignore next 1 */
      if (signal?.aborted) return { success: false, iterations: 0 };
      const result = await this.#run(task, model, cwd, signal);
      lastResult = result;
      if (result.success) return result;
      if (result.authFailure) {
        if (result.error) {
          authErrors.push(result.error);
          console.error(`  ❌ ${result.error}`);
        }
      } else {
        sawNonAuthFailure = true;
      }
    }
    if (authErrors.length > 0 && !sawNonAuthFailure) {
      return {
        success: false,
        iterations: lastResult?.iterations ?? 0,
        authFailure: true,
        error: authErrors.join('; '),
        ...(lastResult?.logPath ? { logPath: lastResult.logPath } : {}),
      };
    }
    return lastResult ?? { success: false, iterations: 0 };
  }

  #run(task: TaskState, model: string | undefined, cwd: string, signal?: AbortSignal): Promise<SpawnResult> {
    /* c8 ignore next 1 */
    if (signal?.aborted) return Promise.resolve({ success: false, iterations: 0 });

    return new Promise(resolve => {
      let settled = false;
      const done = (r: SpawnResult) => { if (!settled) { settled = true; resolve(r); } };

      const args = ['--mode', 'json', '--no-session'];
      if (model) args.push('--model', model);
      args.push('-p', this.#prompt(task, cwd));
      const command = piCommand(args);
      const child: ChildProcess = spawn(command.command, command.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600_000, // 10 min
      });

      // Kill child if stop signal fires mid-spawn
      // Use an aborted flag instead of calling done() from both abort and close
      // handlers to eliminate the race on platforms where kill() synchronously
      // emits 'close' (which previously called done() after done()).
      let aborted = false;
      /* c8 ignore next 1 */
      signal?.addEventListener('abort', () => { aborted = true; child.kill(); }, { once: true });

      let output = '';
      let lastProgress = Date.now();
      let lastStatus = Date.now();

      const logPath = join(task.directory, F_AGENT_LOG);
      // Append header with separator (don't truncate — preserve history across spawns)
      try { appendFileSync(logPath, `\n=== agent session started at ${new Date().toISOString()} ===\n`); } catch {}

      // Auto-generate autoresearch.sh — overwrites agent-modified versions on every spawn
      // Must NOT cd to another dir; runs from worktree root where node_modules lives
      try {
        writeFileSync(join(task.directory, 'autoresearch.sh'), [
          '#!/bin/bash',
          '# Auto-generated by orchestrator — do not cd to another directory',
          'DIR="$(cd "$(dirname "$0")" \&\& pwd)"',
          'node "$DIR/benchmark.js"',
        ].join('\n') + '\n');
      } catch {}

      const handleData = (txt: string) => {
        output += txt;
        try { appendFileSync(logPath, txt); } catch {}
      };

      child.stdout?.on('data', (d: Buffer) => { lastProgress = Date.now(); handleData(d.toString()); });
      child.stderr?.on('data', (d: Buffer) => { lastProgress = Date.now(); handleData(d.toString()); });

      // Progress check: kill child if no output for progressTimeout ms
      let progressStale = false;
      const progressTimer = setInterval(() => {
        if (progressStale) return;
        const now = Date.now();
        const quietFor = now - lastProgress;
        if (quietFor >= this.#progressTimeout) {
          progressStale = true;
          const error = `No agent output for ${PiSpawner.#formatDuration(quietFor)}; stopped pi`;
          console.error(`  ❌ ${error}. See ${logPath}`);
          child.kill();
          done({ success: false, iterations: 0, error, logPath });
          return;
        }
        if (quietFor < this.#progressStatusInterval) return;
        if (now - lastStatus < this.#progressStatusInterval) return;
        lastStatus = now;
        console.log(
          `  still running: no agent output for ${PiSpawner.#formatDuration(quietFor)} ` +
          `(auto-stop at ${PiSpawner.#formatDuration(this.#progressTimeout)})`,
        );
      }, this.#progressCheckInterval);

      child.on('close', (code: number | null) => {
        clearInterval(progressTimer);
        const iterations = (output.match(/log_experiment/g) || []).length;
        // Append footer and close — previous chunks already streamed
        try {
          appendFileSync(logPath, `=== agent session ended (exit ${code}) ===
`);
        /* c8 ignore start */
        } catch (e: unknown) {
          console.error(`[PiSpawner] failed to finalize ${F_AGENT_LOG}: ${e instanceof Error ? e.message : String(e)}`);
        }
        /* c8 ignore stop */
        // If the signal was aborted, the kill may have triggered this close;
        // report as a failure regardless of exit code.
        const authError = PiSpawner.#authError(output);
        if (!aborted && code !== 0 && authError) {
          done({ success: false, iterations, authFailure: true, error: authError, logPath });
        } else if (aborted) {
          done({ success: false, iterations, error: 'pi spawn aborted', logPath });
        } else if (code === 0) {
          done({ success: true, iterations, logPath });
        } else {
          done({ success: false, iterations, error: `pi exited with code ${code ?? 'unknown'}`, logPath });
        }
      });

      child.on('error', (e: Error) => {
        clearInterval(progressTimer);
        done({ success: false, iterations: 0, error: e.message, logPath });
      });
    });
  }

  /** Extract provider auth failures from pi output. */
  static #authError(output: string): string {
    const providers: string[] = [];
    for (const match of output.matchAll(AUTH_FAILURE_RE)) {
      const provider = match[1];
      if (provider && !providers.includes(provider)) providers.push(provider);
    }
    return providers.length > 0 ? `No API key found for ${providers.join(', ')}` : '';
  }

  static #modelLabel(model: string | undefined): string {
    return model || 'pi default';
  }

  static #shortText(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > SUMMARY_MAX
      ? `${normalized.slice(0, SUMMARY_MAX - 3)}...`
      : normalized;
  }

  static #formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
  }

  #prompt(task: TaskState, cwd: string): string {
    // Use relative paths — agent works in cwd, worktree mirrors main repo structure
    const arPath = task.directory.startsWith(cwd)
      ? task.directory.slice(cwd.length + 1) // relative from worktree root
      : task.directory;
    return [
      `You are an autonomous task agent. Working directory: ${cwd}.`,
      '',
      `Task: read ${arPath}/autoresearch.md, then run the experiment loop.`,
      `Use init_experiment, run_experiment (with ${arPath}/autoresearch.sh),`,
      `and log_experiment. Edit only files listed in the task's scope.`,
      'Iterate until metric=0 for 3 consecutive keep runs.',
      '',
      'NOTE: autoresearch.sh must NOT cd to another directory — it runs from the worktree',
      'root where node_modules and all source files are available.',
    ].join('\n');
  }
}
