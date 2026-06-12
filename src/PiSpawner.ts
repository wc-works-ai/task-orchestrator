import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskState } from './TaskState.js';
import { env } from './env.js';
import { piCommand } from './PiCommand.js';
import type { SpawnResult, TokenUsage } from './Engine.js';



// ── File names ──────────────────────────────────────────────────────────────
const F_AGENT_LOG = 'agent.log';
const AUTH_FAILURE_RE = /No API key found for ([^\s.]+)\./g;
const SUMMARY_MAX = 120;
const PROGRESS_STATUS_INTERVAL = 30_000;
const DEFAULT_AGENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const MAX_JSON_LINE_BUFFER = 1_000_000;
const AUTH_SCAN_TAIL = 512;
const ITERATION_MARKER = 'log_experiment';
const LOG_TRUNCATED_MARKER = '\n=== agent.log truncated; keeping latest output only ===\n';
type MutableTokenUsage = { -readonly [K in keyof TokenUsage]: TokenUsage[K] };
interface AgentLog {
  readonly path: string;
  readonly maxBytes: number;
  bytes: number;
}

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
  /** Max agent.log size in bytes (default: 10 MiB). */
  readonly agentLogMaxBytes?: number;
  /** Write raw spawned-agent stdout/stderr to agent.log (default: false). */
  readonly agentLogRaw?: boolean;
}

export class PiSpawner {
  readonly #model: string | undefined;
  readonly #fallback: string | undefined;
  readonly #workDir: string;
  readonly #progressTimeout: number;
  readonly #progressCheckInterval: number;
  readonly #progressStatusInterval: number;
  readonly #agentLogMaxBytes: number;
  readonly #agentLogRaw: boolean;

  constructor(opts: PiSpawnerOptions = {}) {
    this.#model = opts.model || env.model;
    this.#fallback = opts.fallbackModel || undefined;
    this.#workDir = opts.workDir ?? process.cwd();
    this.#progressTimeout = opts.progressTimeout ?? env.progressTimeoutMs;
    this.#progressCheckInterval = opts.progressCheckInterval ?? 10_000;
    this.#progressStatusInterval = opts.progressStatusInterval ?? PROGRESS_STATUS_INTERVAL;
    this.#agentLogMaxBytes = PiSpawner.#positiveInt(opts.agentLogMaxBytes ?? env.agentLogMaxBytes, DEFAULT_AGENT_LOG_MAX_BYTES);
    this.#agentLogRaw = opts.agentLogRaw ?? env.agentLogRaw;
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
    const tokenUsage = PiSpawner.#emptyTokenUsage();
    let lastResult: SpawnResult | undefined;
    let sawNonAuthFailure = false;
    for (const model of models) {
      /* c8 ignore next 1 */
      if (signal?.aborted) return { success: false, iterations: 0 };
      const result = await this.#run(task, model, cwd, signal);
      lastResult = result;
      if (result.tokenUsage) PiSpawner.#addTokenUsage(tokenUsage, result.tokenUsage);
      if (result.success) return PiSpawner.#withTokenUsage(result, tokenUsage);
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
        ...(PiSpawner.#hasTokenUsage(tokenUsage) ? { tokenUsage: { ...tokenUsage } } : {}),
        ...(lastResult?.logPath ? { logPath: lastResult.logPath } : {}),
      };
    }
    return lastResult ? PiSpawner.#withTokenUsage(lastResult, tokenUsage) : { success: false, iterations: 0 };
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

      let iterations = 0;
      let lineBuf = '';
      let iterationTail = '';
      let authTail = '';
      const authProviders = new Set<string>();
      const tokenUsage = PiSpawner.#emptyTokenUsage();
      let lastProgress = Date.now();
      let lastStatus = Date.now();
      let rawBytes = 0;
      const result = (r: Omit<SpawnResult, 'tokenUsage'>): SpawnResult =>
        PiSpawner.#hasTokenUsage(tokenUsage)
          ? { ...r, tokenUsage: { ...tokenUsage } }
          : r;

      const logPath = join(task.directory, F_AGENT_LOG);
      const agentLog = PiSpawner.#openAgentLog(logPath, this.#agentLogMaxBytes);
      try {
        PiSpawner.#appendAgentLog(agentLog, [
          `=== agent session started at ${new Date().toISOString()} ===`,
          `=== agent log mode: ${this.#agentLogRaw ? 'raw' : 'summary'}${this.#agentLogRaw ? '' : ' (set ORCH_AGENT_LOG_RAW=1 for raw pi stream)'} ===`,
          '',
        ].join('\n'));
      } catch {}

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
        rawBytes += Buffer.byteLength(txt);
        if (this.#agentLogRaw) {
          try { PiSpawner.#appendAgentLog(agentLog, txt); } catch {}
        }

        const iterationScan = `${iterationTail}${txt}`;
        iterations += PiSpawner.#countOccurrences(iterationScan, ITERATION_MARKER);
        iterationTail = PiSpawner.#tail(iterationScan, ITERATION_MARKER.length - 1);

        const authScan = `${authTail}${txt}`;
        PiSpawner.#collectAuthProviders(authScan, authProviders);
        authTail = PiSpawner.#tail(authScan, AUTH_SCAN_TAIL);

        lineBuf = PiSpawner.#processJsonLines(txt, lineBuf, tokenUsage);
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
          done(result({ success: false, iterations: 0, error, logPath }));
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
        const authError = PiSpawner.#authError(authProviders);
        const failure = aborted
          ? 'pi spawn aborted'
          : code !== 0 && !authError
            ? `pi exited with code ${code ?? 'unknown'}`
            : '';
        // Append footer and close — previous chunks already streamed
        try {
          PiSpawner.#appendAgentLog(agentLog, [
            `=== agent session ended (exit ${code}) ===`,
            `=== raw output bytes=${rawBytes} ${this.#agentLogRaw ? 'logged' : 'omitted'} ===`,
            `=== iterations=${iterations} ===`,
            authError ? `=== auth failure ${authError} ===` : '',
            failure ? `=== failure ${failure} ===` : '',
            PiSpawner.#hasTokenUsage(tokenUsage) ? `=== token usage ${PiSpawner.#formatTokenUsage(tokenUsage)} ===` : '',
            '',
          ].filter(Boolean).join('\n'));
        /* c8 ignore start */
        } catch (e: unknown) {
          console.error(`[PiSpawner] failed to finalize ${F_AGENT_LOG}: ${e instanceof Error ? e.message : String(e)}`);
        }
        /* c8 ignore stop */
        // If the signal was aborted, the kill may have triggered this close;
        // report as a failure regardless of exit code.
        if (!aborted && code !== 0 && authError) {
          done(result({ success: false, iterations, authFailure: true, error: authError, logPath }));
        } else if (aborted) {
          done(result({ success: false, iterations, error: 'pi spawn aborted', logPath }));
        } else if (code === 0) {
          done(result({ success: true, iterations, logPath }));
        } else {
          done(result({ success: false, iterations, error: `pi exited with code ${code ?? 'unknown'}`, logPath }));
        }
      });

      child.on('error', (e: Error) => {
        clearInterval(progressTimer);
        done(result({ success: false, iterations: 0, error: e.message, logPath }));
      });
    });
  }

  /** Extract provider auth failures from pi output. */
  static #authError(providers: ReadonlySet<string>): string {
    return providers.size > 0 ? `No API key found for ${[...providers].join(', ')}` : '';
  }

  static #collectAuthProviders(output: string, providers: Set<string>): void {
    for (const match of output.matchAll(AUTH_FAILURE_RE)) {
      const provider = match[1];
      if (provider) providers.add(provider);
    }
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

  static #positiveInt(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  static #openAgentLog(path: string, maxBytes: number): AgentLog {
    try { writeFileSync(path, ''); } catch {}
    return { path, maxBytes, bytes: 0 };
  }

  static #appendAgentLog(log: AgentLog, text: string): void {
    const chunk = Buffer.from(text);
    if (log.bytes + chunk.length <= log.maxBytes) {
      appendFileSync(log.path, chunk);
      log.bytes += chunk.length;
      return;
    }

    const marker = Buffer.from(LOG_TRUNCATED_MARKER);
    const available = log.maxBytes - marker.length;
    if (available <= 0) {
      const next = marker.subarray(0, log.maxBytes);
      writeFileSync(log.path, next);
      log.bytes = next.length;
      return;
    }

    const chunkBytes = Math.min(chunk.length, available);
    const existingBytes = available - chunkBytes;
    const existing = existingBytes > 0
      ? readFileSync(log.path).subarray(Math.max(0, log.bytes - existingBytes))
      : Buffer.alloc(0);
    const next = Buffer.concat([
      marker,
      existing,
      chunk.subarray(chunk.length - chunkBytes),
    ]);
    writeFileSync(log.path, next);
    log.bytes = next.length;
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

  static #processJsonLines(txt: string, lineBuf: string, tokenUsage: MutableTokenUsage): string {
    let start = 0;
    while (true) {
      const newline = txt.indexOf('\n', start);
      if (newline === -1) break;
      const segment = txt.slice(start, newline);
      if (lineBuf.length + segment.length <= MAX_JSON_LINE_BUFFER) {
        PiSpawner.#parseJsonLine(`${lineBuf}${segment}`, tokenUsage);
      }
      lineBuf = '';
      start = newline + 1;
    }

    const remainder = txt.slice(start);
    return remainder ? PiSpawner.#appendBounded(lineBuf, remainder, MAX_JSON_LINE_BUFFER) : lineBuf;
  }

  static #appendBounded(current: string, next: string, maxLength: number): string {
    if (next.length >= maxLength) return next.slice(-maxLength);
    const overflow = current.length + next.length - maxLength;
    return overflow > 0 ? `${current.slice(overflow)}${next}` : `${current}${next}`;
  }

  static #parseJsonLine(raw: string, tokenUsage: MutableTokenUsage): void {
    if (!raw.trim()) return;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const usage = PiSpawner.#usageFromEvent(obj);
      if (usage) PiSpawner.#addTokenUsage(tokenUsage, usage);
    } catch {}
  }

  static #emptyTokenUsage(): MutableTokenUsage {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  }

  static #addTokenUsage(total: MutableTokenUsage, usage: TokenUsage): void {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
  }

  static #withTokenUsage(result: SpawnResult, usage: TokenUsage): SpawnResult {
    return PiSpawner.#hasTokenUsage(usage) ? { ...result, tokenUsage: { ...usage } } : result;
  }

  static #hasTokenUsage(usage: TokenUsage): boolean {
    return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
  }

  static #usageFromEvent(obj: Record<string, unknown>): TokenUsage | null {
    if (obj.type !== 'message_end') return null;
    const message = PiSpawner.#record(obj.message);
    if (!message || message.role !== 'assistant') return null;
    const usage = PiSpawner.#record(message.usage);
    if (!usage) return null;
    const parsed = PiSpawner.#parseUsage(usage);
    return PiSpawner.#hasTokenUsage(parsed) ? parsed : null;
  }

  static #parseUsage(usage: Record<string, unknown>): TokenUsage {
    const input = PiSpawner.#numberFrom(usage, ['input', 'input_tokens', 'prompt_tokens']);
    const output = PiSpawner.#numberFrom(usage, ['output', 'output_tokens', 'completion_tokens']);
    const cacheRead = PiSpawner.#numberFrom(usage, ['cacheRead', 'cache_read', 'cache_read_tokens', 'cached_tokens']);
    const cacheWrite = PiSpawner.#numberFrom(usage, ['cacheWrite', 'cache_write', 'cache_write_tokens']);
    const totalTokens = PiSpawner.#numberFrom(usage, ['totalTokens', 'total_tokens']) || input + output + cacheRead + cacheWrite;
    return { input, output, cacheRead, cacheWrite, totalTokens };
  }

  static #record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  static #numberFrom(record: Record<string, unknown>, keys: readonly string[]): number {
    for (const key of keys) {
      const value = record[key];
      const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  static #formatTokenUsage(usage: TokenUsage): string {
    return `total=${usage.totalTokens} input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`;
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
