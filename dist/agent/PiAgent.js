var _a;
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TaskState } from '../state/TaskState.js';
import { env } from '../shared/env.js';
import { resolveCliCommand } from './cliCommand.js';
import { appendAgentLog, openAgentLog, runLogName } from './AgentLog.js';
import { countOccurrences, positiveInt, resolveModel as resolveAgentModel, resolveReasoning as resolveAgentReasoning, tail, } from './CodingAgent.js';
import { consumeLines, formatPiEvent, formatRawLine } from './agentActivity.js';
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
function errorMessage(error) {
    /* v8 ignore next -- non-Error throws are incidental formatting cases */
    return error instanceof Error ? error.message : String(error);
}
export function killTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return;
    try {
        /* v8 ignore start -- platform branch; CI exercises the opposite path */
        if (process.platform !== 'win32') {
            process.kill(-pid, 'SIGKILL');
            return;
        }
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        /* v8 ignore stop */
    }
    catch (error) {
        console.error(`[PiAgent] failed to stop process tree ${pid}: ${errorMessage(error)}`);
    }
}
export class PiAgent {
    name = 'pi';
    #model;
    #reasoning;
    #envModel;
    #envReasoning;
    #fallback;
    #workDir;
    #progressTimeout;
    #progressCheckInterval;
    #progressStatusInterval;
    #agentLogMaxBytes;
    #agentLogRaw;
    constructor(opts = {}) {
        this.#model = opts.model;
        this.#reasoning = opts.reasoning;
        this.#envModel = env.model;
        this.#envReasoning = env.reasoning;
        this.#fallback = opts.fallbackModel || undefined;
        this.#workDir = opts.workDir ?? process.cwd();
        this.#progressTimeout = opts.progressTimeout ?? env.progressTimeoutMs;
        this.#progressCheckInterval = opts.progressCheckInterval ?? 10_000;
        this.#progressStatusInterval = opts.progressStatusInterval ?? PROGRESS_STATUS_INTERVAL;
        this.#agentLogMaxBytes = positiveInt(opts.agentLogMaxBytes ?? env.agentLogMaxBytes, DEFAULT_AGENT_LOG_MAX_BYTES);
        this.#agentLogRaw = opts.agentLogRaw ?? env.agentLogRaw;
    }
    /** Resolve the model for a task: metadata → constructor → env → pi default */
    modelFor(task) {
        return resolveAgentModel(task.model, this.#model, this.#envModel);
    }
    resolveModel(task) {
        return this.modelFor(task);
    }
    resolveReasoning(task) {
        return resolveAgentReasoning(task.reasoning, this.#reasoning, this.#envReasoning);
    }
    checkPrerequisites() {
        return [_a.#checkBinary(), _a.#checkAuth()];
    }
    /** Local timestamp 'YYYY-MM-DD HH:MM:SS' (matches Engine log format). */
    static #now() {
        return new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
    static #checkBinary() {
        const command = resolveCliCommand('pi', ['--version']);
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
    static #checkAuth() {
        const key = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
        return {
            name: 'auth',
            ok: true,
            message: key.length > 0
                ? 'API key found'
                : 'No API key env found; continuing (pi may use local/session auth)',
        };
    }
    async spawn(task, worktreePath, signal) {
        const cwd = worktreePath ?? this.#workDir;
        const primaryModel = this.modelFor(task);
        const models = this.#fallback && this.#fallback !== primaryModel
            ? [primaryModel, this.#fallback]
            : [primaryModel];
        const logPath = join(task.directory, runLogName());
        console.log(`[${_a.#now()}] T${task.taskNumber} agent: ${models.map(_a.#modelLabel).join(', ')} | task: ${_a.#shortText(task.goal)}`);
        console.log(`[${_a.#now()}] T${task.taskNumber} worktree: ${cwd}`);
        console.log(`[${_a.#now()}] T${task.taskNumber} log: ${logPath}`);
        const authErrors = [];
        const tokenUsage = _a.#emptyTokenUsage();
        let lastResult;
        let sawNonAuthFailure = false;
        for (const model of models) {
            /* c8 ignore next 1 */
            if (signal?.aborted)
                return { success: false, iterations: 0 };
            const result = await this.#run(task, model, cwd, logPath, signal);
            lastResult = result;
            if (result.tokenUsage)
                _a.#addTokenUsage(tokenUsage, result.tokenUsage);
            if (result.success)
                return _a.#withTokenUsage(result, tokenUsage);
            if (result.authFailure) {
                /* v8 ignore next -- #run always supplies an auth error string when authFailure is true */
                const error = result.error ?? 'coding agent authentication failed';
                authErrors.push(error);
                console.error(`[${_a.#now()}] T${task.taskNumber} ERROR auth: ${error}`);
            }
            else {
                sawNonAuthFailure = true;
            }
        }
        if (authErrors.length > 0 && !sawNonAuthFailure) {
            /* v8 ignore next -- covered by auth-failure integration tests; line-only artifact */
            return {
                success: false,
                iterations: lastResult.iterations,
                authFailure: true,
                error: authErrors.join('; '),
                ...(_a.#hasTokenUsage(tokenUsage) ? { tokenUsage: { ...tokenUsage } } : {}),
                logPath: lastResult.logPath,
            };
        }
        return _a.#withTokenUsage(lastResult, tokenUsage);
    }
    #run(task, model, cwd, logPath, signal) {
        /* c8 ignore next 1 */
        if (signal?.aborted)
            return Promise.resolve({ success: false, iterations: 0 });
        return new Promise(resolve => {
            let settled = false;
            const done = (r) => { if (!settled) {
                settled = true;
                resolve(r);
            } };
            const args = ['--mode', 'json', '--no-session'];
            if (model)
                args.push('--model', model);
            args.push('-p', this.#prompt(task, cwd));
            const command = resolveCliCommand('pi', args);
            const child = spawn(command.command, command.args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 600_000, // 10 min
                env: process.env,
                /* v8 ignore next 1 -- non-Windows only */
                ...(process.platform !== 'win32' ? { detached: true } : {}),
            });
            let aborted = false;
            const now = Date.now();
            const state = {
                rawBytes: 0,
                iterations: 0,
                iterationTail: '',
                authTail: '',
                authProviders: new Set(),
                tokenUsage: _a.#emptyTokenUsage(),
                lineBuf: '',
                lastProgress: now,
                lastStatus: now,
                lastHeartbeat: now,
                startedAt: now,
                progressStale: false,
                logWriteFailed: false,
            };
            let terminationError = '';
            let progressTimer;
            let forceKillTimer;
            let forceResolveTimer;
            const result = (r) => _a.#hasTokenUsage(state.tokenUsage)
                ? { ...r, tokenUsage: { ...state.tokenUsage } }
                : r;
            const clearKillTimers = () => {
                if (forceKillTimer)
                    clearTimeout(forceKillTimer);
                if (forceResolveTimer)
                    clearTimeout(forceResolveTimer);
                forceKillTimer = undefined;
                forceResolveTimer = undefined;
            };
            const cleanup = () => {
                /* v8 ignore next -- progressTimer is always initialized before cleanup runs */
                if (progressTimer)
                    clearInterval(progressTimer);
                clearKillTimers();
                if (signal)
                    signal.removeEventListener('abort', onAbort);
            };
            const forceResolve = (error) => {
                cleanup();
                done(result({ success: false, iterations: state.iterations, error, logPath }));
            };
            const escalateTermination = (error) => {
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
            _a.#appendAgentLog(agentLog, [
                `=== agent session started at ${new Date().toISOString()} ===`,
                this.#agentLogRaw
                    ? '=== agent log: raw pi JSON stream ==='
                    : '=== agent log: structured activity (set ORCH_AGENT_LOG_RAW=1 for the raw pi JSON stream) ===',
                '',
            ].join('\n'), state, `initialize ${F_AGENT_LOG}`);
            // Auto-generate autoresearch.sh — overwrites agent-modified versions on every spawn
            // Must NOT cd to another dir; runs from worktree root where node_modules lives
            _a.#writeAutoresearchScript(task.directory);
            child.stdout?.on('data', (d) => { state.lastProgress = Date.now(); this.#handleData(d.toString(), state, agentLog); });
            child.stderr?.on('data', (d) => { state.lastProgress = Date.now(); this.#handleData(d.toString(), state, agentLog); });
            // Progress check: kill child if no output for progressTimeout ms
            progressTimer = setInterval(() => this.#checkProgress(state, logPath, escalateTermination), this.#progressCheckInterval);
            child.on('close', (code) => {
                cleanup();
                if (!this.#agentLogRaw) {
                    _a.#flushLineRemainder(state, agentLog);
                }
                const authError = _a.#authError(state.authProviders);
                const failure = state.progressStale
                    ? terminationError
                    : aborted
                        ? 'pi spawn aborted'
                        : code !== 0 && !authError
                            ? `pi exited with code ${code ?? 'unknown'}`
                            : '';
                // Append footer and close — previous chunks already streamed
                _a.#appendAgentLog(agentLog, [
                    `=== agent session ended (exit ${code}) ===`,
                    `=== raw bytes=${state.rawBytes} ${this.#agentLogRaw ? 'logged' : '(structured activity logged)'} ===`,
                    `=== iterations=${state.iterations} ===`,
                    authError ? `=== auth failure ${authError} ===` : '',
                    failure ? `=== failure ${failure} ===` : '',
                    _a.#hasTokenUsage(state.tokenUsage) ? `=== token usage ${_a.#formatTokenUsage(state.tokenUsage)} ===` : '',
                    '',
                ].filter(Boolean).join('\n'), state, `finalize ${F_AGENT_LOG}`);
                if (state.progressStale) {
                    done(result({ success: false, iterations: state.iterations, error: terminationError, logPath }));
                }
                else if (!aborted && code !== 0 && authError) {
                    done(result({ success: false, iterations: state.iterations, authFailure: true, error: authError, logPath }));
                }
                else if (aborted) {
                    done(result({ success: false, iterations: state.iterations, error: 'pi spawn aborted', logPath }));
                }
                else if (code === 0) {
                    done(result({ success: true, iterations: state.iterations, logPath }));
                }
                else {
                    done(result({ success: false, iterations: state.iterations, error: `pi exited with code ${code ?? 'unknown'}`, logPath }));
                }
            });
            child.on('error', (e) => {
                cleanup();
                done(result({ success: false, iterations: 0, error: e.message, logPath }));
            });
        });
    }
    #handleData(txt, state, agentLog) {
        state.rawBytes += Buffer.byteLength(txt);
        if (this.#agentLogRaw) {
            _a.#appendAgentLog(agentLog, txt, state, `write raw ${F_AGENT_LOG}`);
        }
        const iterationScan = `${state.iterationTail}${txt}`;
        state.iterations += countOccurrences(iterationScan, ITERATION_MARKER);
        state.iterationTail = tail(iterationScan, ITERATION_MARKER.length - 1);
        // Only scan for auth errors while the agent has not produced any iterations.
        // Once the agent is actively working (iterations > 0), any auth-error-shaped
        // text in the stream is test fixture / subprocess output, not a real failure.
        if (state.iterations === 0) {
            const authScan = `${state.authTail}${txt}`;
            _a.#collectAuthProviders(authScan, state.authProviders);
            state.authTail = tail(authScan, AUTH_SCAN_TAIL);
        }
        _a.#processPiLines(txt, state, agentLog, !this.#agentLogRaw, () => new Date());
    }
    #checkProgress(state, logPath, escalateTermination) {
        if (state.progressStale)
            return;
        const now = Date.now();
        const ts = _a.#now();
        const quietFor = now - state.lastProgress;
        if (quietFor >= this.#progressTimeout) {
            state.progressStale = true;
            const error = `No agent output for ${_a.#formatDuration(quietFor)}; stopped pi`;
            console.error(`[${ts}] ERROR ${error}. See ${logPath}`);
            escalateTermination(error);
            return;
        }
        // Silence-based warning (agent not producing any output)
        if (quietFor >= this.#progressStatusInterval && now - state.lastStatus >= this.#progressStatusInterval) {
            state.lastStatus = now;
            console.log(`[${ts}] WARN still running: no output for ${_a.#formatDuration(quietFor)} ` +
                `(auto-stop at ${_a.#formatDuration(this.#progressTimeout)})`);
            return;
        }
        // Activity heartbeat (agent IS producing output but user sees nothing)
        if (now - state.lastHeartbeat >= this.#progressStatusInterval) {
            state.lastHeartbeat = now;
            const elapsed = _a.#formatDuration(now - state.startedAt);
            const t = state.tokenUsage;
            const tokens = _a.#hasTokenUsage(t)
                ? `tokens: ${t.totalTokens} (input=${t.input} output=${t.output} cached=${t.cacheRead})`
                : 'waiting for first LLM response';
            console.log(`[${ts}] agent working: ${elapsed} elapsed, ${tokens}`);
        }
    }
    /** Extract provider auth failures from pi output. */
    static #authError(providers) {
        return providers.size > 0 ? `No API key found for ${[...providers].join(', ')}` : '';
    }
    static #collectAuthProviders(output, providers) {
        for (const match of output.matchAll(AUTH_FAILURE_RE)) {
            const provider = match[1];
            // Only accept real provider names (alphanumeric + hyphens). The regex can
            // match test fixture text echoed through vitest (e.g. the PiAgent test
            // contains 'No API key found for azure-openai-responses.'), producing
            // garbage provider names with JSON fragments. Reject those.
            /* v8 ignore next -- the regex always captures a provider when it matches */
            if (provider && /^[a-zA-Z0-9-]+$/.test(provider))
                providers.add(provider);
        }
    }
    static #modelLabel(model) {
        return model || 'pi default';
    }
    static #shortText(text) {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length > SUMMARY_MAX
            ? `${normalized.slice(0, SUMMARY_MAX - 3)}...`
            : normalized;
    }
    static #formatDuration(ms) {
        return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
    }
    static #processPiLines(txt, state, agentLog, structured, nowFn) {
        const { lines, rest } = consumeLines(state.lineBuf, txt);
        for (const line of lines) {
            if (line.length <= MAX_JSON_LINE_BUFFER) {
                _a.#processPiLine(line, state, agentLog, structured, nowFn);
            }
        }
        state.lineBuf = _a.#appendBounded('', rest, MAX_JSON_LINE_BUFFER);
    }
    static #flushLineRemainder(state, agentLog) {
        const line = state.lineBuf;
        if (line.length === 0)
            return;
        state.lineBuf = '';
        // lineBuf is always within MAX_JSON_LINE_BUFFER (bounded by #appendBounded).
        _a.#processPiLine(line, state, agentLog, true, () => new Date());
    }
    static #appendBounded(current, next, maxLength) {
        if (next.length >= maxLength)
            return next.slice(-maxLength);
        const overflow = current.length + next.length - maxLength;
        /* v8 ignore next -- helper is exercised via scanners; exact overflow branch is incidental */
        return overflow > 0 ? `${current.slice(overflow)}${next}` : `${current}${next}`;
    }
    static #processPiLine(raw, state, agentLog, structured, nowFn) {
        const obj = _a.#parseJsonRecord(raw);
        if (obj) {
            const usage = _a.#usageFromEvent(obj);
            if (usage)
                _a.#addTokenUsage(state.tokenUsage, usage);
            if (structured)
                _a.#appendStructuredLines(formatPiEvent(obj, nowFn()), state, agentLog);
            return;
        }
        if (structured) {
            _a.#appendStructuredLines([formatRawLine(raw, nowFn())], state, agentLog);
        }
    }
    static #appendStructuredLines(lines, state, agentLog) {
        if (lines.length === 0)
            return;
        _a.#appendAgentLog(agentLog, `${lines.join('\n')}\n`, state, `write structured ${F_AGENT_LOG}`);
    }
    static #emptyTokenUsage() {
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    }
    static #addTokenUsage(total, usage) {
        total.input += usage.input;
        total.output += usage.output;
        total.cacheRead += usage.cacheRead;
        total.cacheWrite += usage.cacheWrite;
        total.totalTokens += usage.totalTokens;
    }
    static #withTokenUsage(result, usage) {
        return _a.#hasTokenUsage(usage) ? { ...result, tokenUsage: { ...usage } } : result;
    }
    static #hasTokenUsage(usage) {
        return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
    }
    static #usageFromEvent(obj) {
        if (obj.type !== 'message_end')
            return null;
        const message = _a.#record(obj.message);
        if (!message || message.role !== 'assistant')
            return null;
        const usage = _a.#record(message.usage);
        if (!usage)
            return null;
        const parsed = _a.#parseUsage(usage);
        return _a.#hasTokenUsage(parsed) ? parsed : null;
    }
    static #parseUsage(usage) {
        const input = _a.#numberFrom(usage, ['input', 'input_tokens', 'prompt_tokens']);
        const output = _a.#numberFrom(usage, ['output', 'output_tokens', 'completion_tokens']);
        const cacheRead = _a.#numberFrom(usage, ['cacheRead', 'cache_read', 'cache_read_tokens', 'cached_tokens']);
        const cacheWrite = _a.#numberFrom(usage, ['cacheWrite', 'cache_write', 'cache_write_tokens']);
        const totalTokens = _a.#numberFrom(usage, ['totalTokens', 'total_tokens']) || input + output + cacheRead + cacheWrite;
        return { input, output, cacheRead, cacheWrite, totalTokens };
    }
    static #record(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? value
            : null;
    }
    static #numberFrom(record, keys) {
        for (const key of keys) {
            const value = record[key];
            const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
            if (Number.isFinite(number))
                return number;
        }
        return 0;
    }
    static #formatTokenUsage(usage) {
        return `total=${usage.totalTokens} input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`;
    }
    static #parseJsonRecord(raw) {
        try {
            return _a.#record(JSON.parse(raw));
        }
        catch {
            return null;
        }
    }
    static #appendAgentLog(agentLog, text, state, action) {
        /* v8 ignore next -- after the first log-write failure we intentionally stop retrying */
        if (state.logWriteFailed)
            return;
        try {
            appendAgentLog(agentLog, text);
            /* v8 ignore start -- appendAgentLog failures are best-effort and not exercised via public APIs */
        }
        catch (error) {
            state.logWriteFailed = true;
            console.error(`[PiAgent] failed to ${action}: ${errorMessage(error)}`);
        }
        /* v8 ignore stop */
    }
    static #writeAutoresearchScript(taskDirectory) {
        const path = join(taskDirectory, 'autoresearch.sh');
        try {
            writeFileSync(path, [
                '#!/bin/bash',
                '# Auto-generated by orchestrator — do not cd to another directory',
                'DIR="$(cd "$(dirname "$0")" \&\& pwd)"',
                'node "$DIR/benchmark.js"',
            ].join('\n') + '\n');
            /* v8 ignore start -- script generation failure is logged but should not block spawning */
        }
        catch (error) {
            console.error(`[PiAgent] failed to write ${path}: ${errorMessage(error)}`);
        }
        /* v8 ignore stop */
    }
    #prompt(task, cwd) {
        // The task directory may live outside the worktree (independent state-root
        // layout); when it does, fall back to its absolute path. The agent works in
        // `cwd` (the worktree), so benchmark.js it runs from here measures the worktree.
        const arPath = (() => {
            const rel = relative(cwd, task.directory);
            return rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../')
                ? rel
                : task.directory;
        })();
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
_a = PiAgent;
//# sourceMappingURL=PiAgent.js.map