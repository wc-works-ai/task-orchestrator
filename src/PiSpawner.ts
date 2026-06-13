import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskState } from './TaskState.js';
import { env } from './env.js';
import { piCommand } from './PiCommand.js';
import { appendAgentLog, openAgentLog, runLogName, type AgentLog } from './AgentLog.js';
import type { SpawnResult, TokenUsage, PrerequisiteResult, CodingAgentOptions } from './CodingAgent.js';
import type { CodingAgent } from './CodingAgent.js';



// ── File names ──────────────────────────────────────────────────────────────
const F_AGENT_LOG = 'agent.log';
const AUTH_FAILURE_RE = /No API key found for ([^\s.]+)\./g;
const SUMMARY_MAX = 120;
const PROGRESS_STATUS_INTERVAL = 30_000;
const KILL_GRACE_MS = 5_000;
const DEFAULT_AGENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const MAX_JSON_LINE_BUFFER = 1_000_000;
const AUTH_SCAN_TAIL = 512;
const ITERATION_MARKER = 'log_experiment';
type MutableTokenUsage = { -readonly [K in keyof TokenUsage]: TokenUsage[K] };

interface RunState {
  rawBytes: number;
  iterations: number;
  iterationTail: string;
  authTail: string;
  readonly authProviders: Set<string>;
  readonly tokenUsage: MutableTokenUsage;
  lineBuf: string;
  lastProgress: number;
  lastStatus: number;
  lastHeartbeat: number;
  readonly startedAt: number;
  progressStale: boolean;
}

export interface PiSpawnerOptions extends CodingAgentOptions {
  /** Optional fallback model if primary fails */
  readonly fallbackModel?: string;
  /** Max ms with no output before killing the agent (default: 120_000 / 2 min) */
  readonly progressTimeout?: number;
  /** Interval (ms) for progress checks (default: 10_000). Only overridden in tests. */
  readonly progressCheckInterval?: number;
  /** Min silent time (ms) before quiet running status lines (default: 30_000). Only overridden in tests. */
  readonly progressStatusInterval?: number;
  /** Write raw spawned-agent stdout/stderr to agent.log (default: false). */
  readonly agentLogRaw?: boolean;
}

export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    /* v8 ignore next 4 -- non-Windows path is not exercised in this Windows repo */
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGKILL');
      return;
    }
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

export class PiSpawner implements CodingAgent {
  readonly name = 'pi';
  readonly #model: string | undefined;
  readonly #reasoning: string | undefined;
  readonly #fallback: string | undefined;
  readonly #workDir: string;
  readonly #progressTimeout: number;
  readonly #progressCheckInterval: number;
  readonly #progressStatusInterval: number;
  readonly #agentLogMaxBytes: number;
  readonly #agentLogRaw: boolean;

  constructor(opts: PiSpawnerOptions = {}) {
    this.#model = opts.model || env.model;
    this.#reasoning = opts.reasoning || env.reasoning;
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

  resolveModel(task: TaskState): string | undefined {
    return this.modelFor(task);
  }

  resolveReasoning(task: TaskState): string | undefined {
    return task.reasoning || this.#reasoning;
  }

  checkPrerequisites(): PrerequisiteResult[] {
    return [PiSpawner.#checkBinary(), PiSpawner.#checkAuth()];
  }

  /** Local timestamp 'YYYY-MM-DD HH:MM:SS' (matches Engine log format). */
  static #now(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  static #checkBinary(): PrerequisiteResult {
    const command = piCommand(['--version']);
    const r = spawnSync(command.command, command.args, { timeout: 5000, encoding: 'utf-8' });
    return {
      name: 'pi',
      ok: r.status === 0,
      /* v8 ignore next -- stdout vs stderr text source is incidental */
      message: r.status === 0
        ? (r.stdout?.trim() || r.stderr?.trim() || 'installed')
        : 'pi CLI not found — install with: npm install -g @earendil-works/pi-coding-agent',
    };
  }

  static #checkAuth(): PrerequisiteResult {
    const key = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    return {
      name: 'auth',
      ok: true,
      message: key.length > 0
        ? 'API key found'
        : 'No API key env found; continuing (pi may use local/session auth)',
    };
  }

  async spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult> {
    const cwd = worktreePath ?? this.#workDir;
    const primaryModel = this.modelFor(task);
    const models = this.#fallback && this.#fallback !== primaryModel
      ? [primaryModel, this.#fallback]
      : [primaryModel];
    const logPath = join(task.directory, runLogName());

    console.log(`[${PiSpawner.#now()}] T${task.taskNumber} agent: ${models.map(PiSpawner.#modelLabel).join(', ')} | task: ${PiSpawner.#shortText(task.goal)}`);
    console.log(`[${PiSpawner.#now()}] T${task.taskNumber} worktree: ${cwd}`);
    console.log(`[${PiSpawner.#now()}] T${task.taskNumber} log: ${logPath}`);
    const authErrors: string[] = [];
    const tokenUsage = PiSpawner.#emptyTokenUsage();
    let lastResult: SpawnResult | undefined;
    let sawNonAuthFailure = false;
    for (const model of models) {
      /* c8 ignore next 1 */
      if (signal?.aborted) return { success: false, iterations: 0 };
      const result = await this.#run(task, model, cwd, logPath, signal);
      lastResult = result;
      if (result.tokenUsage) PiSpawner.#addTokenUsage(tokenUsage, result.tokenUsage);
      if (result.success) return PiSpawner.#withTokenUsage(result, tokenUsage);
      if (result.authFailure) {
        /* v8 ignore next -- #run always supplies an auth error string when authFailure is true */
        const error = result.error ?? 'coding agent authentication failed';
        authErrors.push(error);
        console.error(`[${PiSpawner.#now()}] T${task.taskNumber} ERROR auth: ${error}`);
      } else {
        sawNonAuthFailure = true;
      }
    }
    if (authErrors.length > 0 && !sawNonAuthFailure) {
      /* v8 ignore next -- covered by auth-failure integration tests; line-only artifact */
      return {
        success: false,
        iterations: lastResult!.iterations,
        authFailure: true,
        error: authErrors.join('; '),
        ...(PiSpawner.#hasTokenUsage(tokenUsage) ? { tokenUsage: { ...tokenUsage } } : {}),
        logPath: lastResult!.logPath!,
      };
    }
    return PiSpawner.#withTokenUsage(lastResult!, tokenUsage);
  }

  #run(task: TaskState, model: string | undefined, cwd: string, logPath: string, signal?: AbortSignal): Promise<SpawnResult> {
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
        env: process.env,
        /* v8 ignore next 1 -- non-Windows only */
        ...(process.platform !== 'win32' ? { detached: true } : {}),
      });

      let aborted = false;
      const now = Date.now();
      const state: RunState = {
        rawBytes: 0,
        iterations: 0,
        iterationTail: '',
        authTail: '',
        authProviders: new Set<string>(),
        tokenUsage: PiSpawner.#emptyTokenUsage(),
        lineBuf: '',
        lastProgress: now,
        lastStatus: now,
        lastHeartbeat: now,
        startedAt: now,
        progressStale: false,
      };
      let terminationError = '';
      let progressTimer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceResolveTimer: NodeJS.Timeout | undefined;
      const result = (r: Omit<SpawnResult, 'tokenUsage'>): SpawnResult =>
        PiSpawner.#hasTokenUsage(state.tokenUsage)
          ? { ...r, tokenUsage: { ...state.tokenUsage } }
          : r;
      const clearKillTimers = () => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (forceResolveTimer) clearTimeout(forceResolveTimer);
        forceKillTimer = undefined;
        forceResolveTimer = undefined;
      };
      const cleanup = () => {
        /* v8 ignore next -- progressTimer is always initialized before cleanup runs */
        if (progressTimer) clearInterval(progressTimer);
        clearKillTimers();
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const forceResolve = (error: string) => {
        cleanup();
        done(result({ success: false, iterations: state.iterations, error, logPath }));
      };
      const escalateTermination = (error: string) => {
        terminationError = error;
        clearKillTimers();
        child.kill();
        forceKillTimer = setTimeout(() => {
          /* v8 ignore next -- mock children usually expose a numeric pid */
          if (typeof child.pid === 'number') {
            killTree(child.pid);
          }
          forceResolveTimer = setTimeout(() => {
            forceResolve(error);
          }, KILL_GRACE_MS);
        }, KILL_GRACE_MS);
      };
      const onAbort = () => {
        aborted = true;
        escalateTermination('pi spawn aborted');
      };
      /* c8 ignore next 1 */
      signal?.addEventListener('abort', onAbort, { once: true });

      const agentLog = openAgentLog(logPath, this.#agentLogMaxBytes);
      try {
        appendAgentLog(agentLog, [
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

      child.stdout?.on('data', (d: Buffer) => { state.lastProgress = Date.now(); this.#handleData(d.toString(), state, agentLog); });
      child.stderr?.on('data', (d: Buffer) => { state.lastProgress = Date.now(); this.#handleData(d.toString(), state, agentLog); });

      // Progress check: kill child if no output for progressTimeout ms
      progressTimer = setInterval(() => this.#checkProgress(state, logPath, escalateTermination), this.#progressCheckInterval);

      child.on('close', (code: number | null) => {
        cleanup();
        const authError = PiSpawner.#authError(state.authProviders);
        const failure = state.progressStale
          ? terminationError
          : aborted
          ? 'pi spawn aborted'
          : code !== 0 && !authError
            ? `pi exited with code ${code ?? 'unknown'}`
            : '';
        // Append footer and close — previous chunks already streamed
        try {
          appendAgentLog(agentLog, [
            `=== agent session ended (exit ${code}) ===`,
            `=== raw output bytes=${state.rawBytes} ${this.#agentLogRaw ? 'logged' : 'omitted'} ===`,
            `=== iterations=${state.iterations} ===`,
            authError ? `=== auth failure ${authError} ===` : '',
            failure ? `=== failure ${failure} ===` : '',
            PiSpawner.#hasTokenUsage(state.tokenUsage) ? `=== token usage ${PiSpawner.#formatTokenUsage(state.tokenUsage)} ===` : '',
            '',
          ].filter(Boolean).join('\n'));
        /* c8 ignore start */
        } catch (e: unknown) {
          console.error(`[PiSpawner] failed to finalize ${F_AGENT_LOG}: ${e instanceof Error ? e.message : String(e)}`);
        }
        /* c8 ignore stop */
        if (state.progressStale) {
          done(result({ success: false, iterations: state.iterations, error: terminationError, logPath }));
        } else if (!aborted && code !== 0 && authError) {
          done(result({ success: false, iterations: state.iterations, authFailure: true, error: authError, logPath }));
        } else if (aborted) {
          done(result({ success: false, iterations: state.iterations, error: 'pi spawn aborted', logPath }));
        } else if (code === 0) {
          done(result({ success: true, iterations: state.iterations, logPath }));
        } else {
          done(result({ success: false, iterations: state.iterations, error: `pi exited with code ${code ?? 'unknown'}`, logPath }));
        }
      });

      child.on('error', (e: Error) => {
        cleanup();
        done(result({ success: false, iterations: 0, error: e.message, logPath }));
      });
    });
  }

  #handleData(txt: string, state: RunState, agentLog: AgentLog): void {
    state.rawBytes += Buffer.byteLength(txt);
    if (this.#agentLogRaw) {
      try { appendAgentLog(agentLog, txt); } catch {}
    }
    const iterationScan = `${state.iterationTail}${txt}`;
    state.iterations += PiSpawner.#countOccurrences(iterationScan, ITERATION_MARKER);
    state.iterationTail = PiSpawner.#tail(iterationScan, ITERATION_MARKER.length - 1);
    // Only scan for auth errors while the agent has not produced any iterations.
    // Once the agent is actively working (iterations > 0), any auth-error-shaped
    // text in the stream is test fixture / subprocess output, not a real failure.
    if (state.iterations === 0) {
      const authScan = `${state.authTail}${txt}`;
      PiSpawner.#collectAuthProviders(authScan, state.authProviders);
      state.authTail = PiSpawner.#tail(authScan, AUTH_SCAN_TAIL);
    }
    state.lineBuf = PiSpawner.#processJsonLines(txt, state.lineBuf, state.tokenUsage);
  }

  #checkProgress(state: RunState, logPath: string, escalateTermination: (error: string) => void): void {
    if (state.progressStale) return;
    const now = Date.now();
    const ts = PiSpawner.#now();
    const quietFor = now - state.lastProgress;
    if (quietFor >= this.#progressTimeout) {
      state.progressStale = true;
      const error = `No agent output for ${PiSpawner.#formatDuration(quietFor)}; stopped pi`;
      console.error(`[${ts}] ERROR ${error}. See ${logPath}`);
      escalateTermination(error);
      return;
    }
    // Silence-based warning (agent not producing any output)
    if (quietFor >= this.#progressStatusInterval && now - state.lastStatus >= this.#progressStatusInterval) {
      state.lastStatus = now;
      console.log(
        `[${ts}] WARN still running: no output for ${PiSpawner.#formatDuration(quietFor)} ` +
        `(auto-stop at ${PiSpawner.#formatDuration(this.#progressTimeout)})`,
      );
      return;
    }
    // Activity heartbeat (agent IS producing output but user sees nothing)
    if (now - state.lastHeartbeat >= this.#progressStatusInterval) {
      state.lastHeartbeat = now;
      const elapsed = PiSpawner.#formatDuration(now - state.startedAt);
      const t = state.tokenUsage;
      const tokens = PiSpawner.#hasTokenUsage(t)
        ? `tokens: ${t.totalTokens} (input=${t.input} output=${t.output} cached=${t.cacheRead})`
        : 'waiting for first LLM response';
      console.log(`[${ts}] agent working: ${elapsed} elapsed, ${tokens}`);
    }
  }

  /** Extract provider auth failures from pi output. */
  static #authError(providers: ReadonlySet<string>): string {
    return providers.size > 0 ? `No API key found for ${[...providers].join(', ')}` : '';
  }

  static #collectAuthProviders(output: string, providers: Set<string>): void {
    for (const match of output.matchAll(AUTH_FAILURE_RE)) {
      const provider = match[1];
      // Only accept real provider names (alphanumeric + hyphens). The regex can
      // match test fixture text echoed through vitest (e.g. the PiSpawner test
      // contains 'No API key found for azure-openai-responses.'), producing
      // garbage provider names with JSON fragments. Reject those.
      /* v8 ignore next -- the regex always captures a provider when it matches */
      if (provider && /^[a-zA-Z0-9-]+$/.test(provider)) providers.add(provider);
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
    /* v8 ignore next -- helper is exercised via scanners; exact overflow branch is incidental */
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
    // The task directory may live outside the worktree (independent state-root
    // layout); when it does, fall back to its absolute path. The agent works in
    // `cwd` (the worktree), so benchmark.js it runs from here measures the worktree.
    const arPath = task.directory.startsWith(cwd)
      ? task.directory.slice(cwd.length + 1) // relative when the task dir is under the worktree
      : task.directory;
    return [
      `You are an autonomous task agent. Working directory: ${cwd}.`,
      '',
      `Step 1: Read ${arPath}/autoresearch.md.`,
      'Step 2: From the current worktree/repo root, read AGENTS.md if present.',
      'Step 3: Read docs/DEVELOP.md and docs/TESTING.md if present.',
      'Step 4: Follow the above guidance files strictly for implementation and tests.',
      'Step 5: Respect local worktree environment/configuration (package scripts, Node/toolchain version, and existing environment variables).',
      '',
      `Task: read ${arPath}/autoresearch.md, then run the experiment loop.`,
      `Use init_experiment, run_experiment (with ${arPath}/autoresearch.sh),`,
      `and log_experiment. Edit only files listed in the task's scope.`,
      'Iterate until metric=0 for 3 consecutive keep runs.',
      '',
      `IMPORTANT: Do NOT modify, delete, or move any files inside ${arPath}/ except autoresearch.md.`,
      'The orchestrator manages benchmark.js, autoresearch.sh, and agent logs there.',
      'Your edits belong in the working directory (the worktree/repo), not the task directory.',
      '',
      'NOTE: autoresearch.sh must NOT cd to another directory — it runs from the worktree',
      'root where node_modules and all source files are available.',
    ].join('\n');
  }
}
