import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskState } from './TaskState.js';
import type { SpawnResult } from './Engine.js';

// ── File names ──────────────────────────────────────────────────────────────
const F_AGENT_LOG = 'agent.log';

export interface PiSpawnerOptions {
  /** Default model when task doesn't specify one */
  readonly model?: string;
  /** Fallback model if primary fails */
  readonly fallbackModel?: string;
  /** Working directory for the agent */
  readonly workDir?: string;
}

export class PiSpawner {
  readonly #model: string;
  readonly #fallback: string;
  readonly #workDir: string;

  constructor(opts: PiSpawnerOptions = {}) {
    this.#model = opts.model
      ?? process.env.ORCH_MODEL
      ?? 'openrouter/owl-alpha';
    this.#fallback = opts.fallbackModel ?? 'openrouter/owl-alpha';
    this.#workDir = opts.workDir ?? process.cwd();
  }

  /** Resolve the model for a task: metadata → constructor → env → default */
  modelFor(task: TaskState): string {
    return task.model || this.#model;
  }

  async spawn(task: TaskState, worktreePath?: string): Promise<SpawnResult> {
    const cwd = worktreePath ?? this.#workDir;
    const models = [this.modelFor(task), this.#fallback]
      .filter((m, i, arr) => m && arr.indexOf(m) === i);

    console.log(`T${task.taskNumber} using ${models.join(', ')}`);
    for (const model of models) {
      const result = await this.#run(task, model, cwd);
      if (result.success) return result;
    }
    return { success: false, iterations: 0 };
  }

  #run(task: TaskState, model: string, cwd: string): Promise<SpawnResult> {
    return new Promise(resolve => {
      let settled = false;
      const done = (r: SpawnResult) => { if (!settled) { settled = true; resolve(r); } };

      const child: ChildProcess = spawn('pi', [
        '--mode', 'json',
        '--no-session',
        '--model', model,
        '-p', this.#prompt(task, cwd),
      ], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600_000, // 10 min
      });

      let output = '';

      const logPath = join(task.directory, F_AGENT_LOG);
      // Write header so a partial file is recognizable
      try { writeFileSync(logPath, `=== agent session started at ${new Date().toISOString()} ===
`); } catch {}

      child.stdout?.on('data', (d: Buffer) => {
        const txt = d.toString();
        output += txt;
        try { appendFileSync(logPath, txt); } catch {}
      });

      child.stderr?.on('data', (d: Buffer) => {
        const txt = d.toString();
        output += txt;
        try { appendFileSync(logPath, txt); } catch {}
      });

      child.on('close', (code: number | null) => {
        const iterations = (output.match(/log_experiment/g) || []).length;
        // Append footer and close — previous chunks already streamed
        try {
          appendFileSync(logPath, `=== agent session ended (exit ${code}) ===
`);
        } catch (e: unknown) {
          console.error(`[PiSpawner] failed to finalize ${F_AGENT_LOG}: ${e instanceof Error ? e.message : String(e)}`);
        }
        done({ success: code === 0, iterations });
      });

      child.on('error', () => {
        done({ success: false, iterations: 0 });
      });
    });
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
    ].join('\n');
  }
}
