import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { TaskState } from './TaskState.js';
import { env } from './env.js';
import { resolveCliCommand } from './PiCommand.js';
import { appendAgentLog, openAgentLog } from './AgentLog.js';
import type { SpawnResult } from './Engine.js';
import type { CodingAgent } from './CodingAgent.js';

const F_AGENT_LOG = 'agent.log';
const DEFAULT_AGENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const METRIC_MARKER = 'METRIC ';
const AUTH_SCAN_TAIL = 256;
const AUTH_FAILURE_RE = /(not logged in|authentication|COPILOT_GITHUB_TOKEN)/i;

export interface CopilotCliAgentOptions {
  /** Optional model override when task doesn't specify one */
  readonly model?: string;
  /** Optional reasoning-effort override when task doesn't specify one */
  readonly reasoning?: string;
  /** Working directory for the agent */
  readonly workDir?: string;
  /** Max agent.log size in bytes (default: 10 MiB). */
  readonly agentLogMaxBytes?: number;
}

export class CopilotCliAgent implements CodingAgent {
  readonly name = 'copilot';
  readonly #model: string | undefined;
  readonly #reasoning: string | undefined;
  readonly #workDir: string;
  readonly #agentLogMaxBytes: number;

  constructor(opts: CopilotCliAgentOptions = {}) {
    this.#model = opts.model || env.model;
    this.#reasoning = opts.reasoning || env.reasoning;
    this.#workDir = opts.workDir ?? process.cwd();
    this.#agentLogMaxBytes = CopilotCliAgent.#positiveInt(
      opts.agentLogMaxBytes ?? env.agentLogMaxBytes,
      DEFAULT_AGENT_LOG_MAX_BYTES,
    );
  }

  resolveModel(task: TaskState): string | undefined {
    return task.model || this.#model;
  }

  resolveReasoning(task: TaskState): string | undefined {
    return task.reasoning || this.#reasoning;
  }

  spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult> {
    /* c8 ignore next 1 */
    if (signal?.aborted) return Promise.resolve({ success: false, iterations: 0 });

    const cwd = worktreePath ?? this.#workDir;
    const logPath = join(task.directory, F_AGENT_LOG);
    const agentLog = openAgentLog(logPath, this.#agentLogMaxBytes);
    const model = this.resolveModel(task);
    const reasoning = this.resolveReasoning(task);
    const args = ['-p', this.#prompt(task, cwd), '-s', '--allow-all-tools', '--no-ask-user'];
    if (model) args.push('--model', model);
    if (reasoning) args.push('--reasoning-effort', reasoning);
    const command = resolveCliCommand('copilot', args);

    try {
      appendAgentLog(agentLog, [
        `=== agent session started at ${new Date().toISOString()} ===`,
        '=== token usage unavailable: copilot -p -s does not report token usage ===',
        '',
      ].join('\n'));
    } catch {}

    return new Promise(resolve => {
      let settled = false;
      const done = (result: SpawnResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const child: ChildProcess = spawn(command.command, command.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600_000,
      });

      let aborted = false;
      /* c8 ignore next 1 */
      signal?.addEventListener('abort', () => { aborted = true; child.kill(); }, { once: true });

      let iterations = 0;
      let metricTail = '';
      let authTail = '';
      let authFailure = false;

      const handleData = (txt: string) => {
        try { appendAgentLog(agentLog, txt); } catch {}

        const metricScan = `${metricTail}${txt}`;
        iterations += CopilotCliAgent.#countOccurrences(metricScan, METRIC_MARKER);
        metricTail = CopilotCliAgent.#tail(metricScan, METRIC_MARKER.length - 1);

        const authScan = `${authTail}${txt}`;
        authFailure = authFailure || AUTH_FAILURE_RE.test(authScan);
        authTail = CopilotCliAgent.#tail(authScan, AUTH_SCAN_TAIL);
      };

      child.stdout?.on('data', (d: Buffer) => handleData(d.toString()));
      child.stderr?.on('data', (d: Buffer) => handleData(d.toString()));

      child.on('close', (code: number | null) => {
        const abortedError = 'copilot spawn aborted';
        const authError = 'Copilot CLI authentication failed; sign in or set COPILOT_GITHUB_TOKEN/GITHUB_TOKEN.';
        const exitError = `copilot exited with code ${code ?? 'unknown'}`;
        const error = aborted ? abortedError : authFailure ? authError : code === 0 ? '' : exitError;
        try {
          appendAgentLog(agentLog, [
            `=== agent session ended (exit ${code}) ===`,
            `=== iterations=${iterations} ===`,
            error ? `=== failure ${error} ===` : '',
            '',
          ].filter(Boolean).join('\n'));
        } catch {}

        if (aborted) {
          done({ success: false, iterations, error: abortedError, logPath });
        } else if (authFailure) {
          done({ success: false, iterations, authFailure: true, error: authError, logPath });
        } else if (code === 0) {
          done({ success: true, iterations, logPath });
        } else {
          done({ success: false, iterations, error: exitError, logPath });
        }
      });

      child.on('error', (e: Error) => {
        done({ success: false, iterations: 0, error: e.message, logPath });
      });
    });
  }

  #prompt(task: TaskState, cwd: string): string {
    const taskDir = task.directory.startsWith(cwd)
      ? task.directory.slice(cwd.length + 1)
      : task.directory;
    // Copilot CLI exposes shell/file tools, not pi's experiment tools, so this prompt
    // spells out the benchmark loop explicitly instead of naming pi-only tools.
    return [
      `You are an autonomous coding agent. Working directory: ${cwd}.`,
      '',
      `Read ${taskDir}/autoresearch.md.`,
      `Run the benchmark with: node ${taskDir}/benchmark.js`,
      'Read the printed "METRIC <name>=<value>" line.',
      'Edit only files listed in the task scope.',
      'Iterate until the metric reaches its target value of 0.',
    ].join('\n');
  }

  static #positiveInt(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  static #countOccurrences(text: string, needle: string): number {
    let count = 0;
    let index = text.indexOf(needle);
    while (index !== -1) {
      count++;
      index = text.indexOf(needle, index + needle.length);
    }
    return count;
  }

  static #tail(text: string, length: number): string {
    return length > 0 && text.length > length ? text.slice(-length) : text;
  }
}
