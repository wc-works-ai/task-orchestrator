import { spawn, spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { TaskState } from '../state/TaskState.js';
import { env } from '../shared/env.js';
import { resolveCliCommand } from './cliCommand.js';
import { consumeLines, formatRawLine } from './agentActivity.js';
import { appendAgentLog, openAgentLog, runLogName } from './AgentLog.js';
import { countOccurrences, positiveInt, resolveModel as resolveAgentModel, resolveReasoning as resolveAgentReasoning, tail, } from './CodingAgent.js';
const DEFAULT_AGENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const METRIC_MARKER = 'METRIC ';
const AUTH_SCAN_TAIL = 256;
const AUTH_FAILURE_RE = /(not logged in|authentication|COPILOT_GITHUB_TOKEN)/i;
/* v8 ignore next 4 -- formatting helper for best-effort log failures */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export class CopilotAgent {
    name = 'copilot';
    #model;
    #reasoning;
    #envModel;
    #envReasoning;
    #workDir;
    #agentLogMaxBytes;
    #agentLogRaw;
    constructor(opts = {}) {
        this.#model = opts.model;
        this.#reasoning = opts.reasoning;
        this.#envModel = env.model;
        this.#envReasoning = env.reasoning;
        this.#workDir = opts.workDir ?? process.cwd();
        this.#agentLogMaxBytes = positiveInt(opts.agentLogMaxBytes ?? env.agentLogMaxBytes, DEFAULT_AGENT_LOG_MAX_BYTES);
        this.#agentLogRaw = opts.agentLogRaw ?? env.agentLogRaw;
    }
    resolveModel(task) {
        return resolveAgentModel(task.model, this.#model, this.#envModel);
    }
    resolveReasoning(task) {
        return resolveAgentReasoning(task.reasoning, this.#reasoning, this.#envReasoning);
    }
    checkPrerequisites() {
        return [CopilotAgent.#checkBinary(), CopilotAgent.#checkAuth()];
    }
    static #checkBinary() {
        const command = resolveCliCommand('copilot', ['--version']);
        const r = spawnSync(command.command, command.args, { timeout: 5000, encoding: 'utf-8' });
        return {
            name: 'copilot',
            ok: r.status === 0,
            /* v8 ignore next -- output text source is incidental to behavior */
            message: r.status === 0
                ? (r.stdout?.trim() || r.stderr?.trim() || 'installed')
                : 'copilot CLI not found — install GitHub Copilot CLI',
        };
    }
    static #checkAuth() {
        const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
        if (token.length > 0)
            return { name: 'auth', ok: true, message: 'GitHub token found' };
        const r = spawnSync('gh', ['auth', 'status'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' });
        return {
            name: 'auth',
            ok: r.status === 0,
            message: r.status === 0 ? 'GitHub authenticated (gh)' : 'authenticate with: gh auth login (or set COPILOT_GITHUB_TOKEN)',
        };
    }
    spawn(task, worktreePath, signal) {
        /* c8 ignore next 1 */
        if (signal?.aborted)
            return Promise.resolve({ success: false, iterations: 0 });
        const cwd = worktreePath ?? this.#workDir;
        const logPath = join(task.directory, runLogName());
        const agentLog = openAgentLog(logPath, this.#agentLogMaxBytes);
        const model = this.resolveModel(task);
        const reasoning = this.resolveReasoning(task);
        const args = ['-p', this.#prompt(task, cwd), '-s', '--allow-all-tools', '--no-ask-user'];
        if (model)
            args.push('--model', model);
        if (reasoning)
            args.push('--reasoning-effort', reasoning);
        const command = resolveCliCommand('copilot', args);
        CopilotAgent.#appendAgentLog(agentLog, [
            `=== agent session started at ${new Date().toISOString()} ===`,
            '=== token usage unavailable: copilot -p -s does not report token usage ===',
            '',
        ].join('\n'), 'start agent session');
        return new Promise(resolve => {
            let settled = false;
            const done = (result) => {
                if (!settled) {
                    settled = true;
                    resolve(result);
                }
            };
            const child = spawn(command.command, command.args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 600_000,
                env: process.env,
            });
            let aborted = false;
            /* c8 ignore next 1 */
            signal?.addEventListener('abort', () => { aborted = true; child.kill(); }, { once: true });
            let iterations = 0;
            let metricTail = '';
            let authTail = '';
            let authFailure = false;
            let logWriteFailed = false;
            let lineBuffer = '';
            const handleData = (txt) => {
                if (this.#agentLogRaw) {
                    logWriteFailed = CopilotAgent.#appendAgentLog(agentLog, txt, 'write agent output', logWriteFailed);
                }
                else {
                    const consumed = consumeLines(lineBuffer, txt);
                    lineBuffer = consumed.rest;
                    if (consumed.lines.length > 0) {
                        logWriteFailed = CopilotAgent.#appendAgentLog(agentLog, `${consumed.lines.map(line => formatRawLine(line)).join('\n')}\n`, 'write agent output', logWriteFailed);
                    }
                }
                const metricScan = `${metricTail}${txt}`;
                iterations += countOccurrences(metricScan, METRIC_MARKER);
                metricTail = tail(metricScan, METRIC_MARKER.length - 1);
                const authScan = `${authTail}${txt}`;
                authFailure = authFailure || AUTH_FAILURE_RE.test(authScan);
                authTail = tail(authScan, AUTH_SCAN_TAIL);
            };
            child.stdout?.on('data', (d) => handleData(d.toString()));
            child.stderr?.on('data', (d) => handleData(d.toString()));
            child.on('close', (code) => {
                if (!this.#agentLogRaw && lineBuffer.length > 0) {
                    logWriteFailed = CopilotAgent.#appendAgentLog(agentLog, `${formatRawLine(lineBuffer)}\n`, 'write final agent output', logWriteFailed);
                }
                const abortedError = 'copilot spawn aborted';
                const authError = 'Copilot CLI authentication failed; sign in or set COPILOT_GITHUB_TOKEN/GITHUB_TOKEN.';
                const exitError = `copilot exited with code ${code ?? 'unknown'}`;
                const error = aborted ? abortedError : authFailure ? authError : code === 0 ? '' : exitError;
                CopilotAgent.#appendAgentLog(agentLog, [
                    `=== agent session ended (exit ${code}) ===`,
                    `=== iterations=${iterations} ===`,
                    error ? `=== failure ${error} ===` : '',
                    '',
                ].filter(Boolean).join('\n'), 'finish agent session', logWriteFailed);
                if (aborted) {
                    done({ success: false, iterations, error: abortedError, logPath });
                }
                else if (authFailure) {
                    done({ success: false, iterations, authFailure: true, error: authError, logPath });
                }
                else if (code === 0) {
                    done({ success: true, iterations, logPath });
                }
                else {
                    done({ success: false, iterations, error: exitError, logPath });
                }
            });
            child.on('error', (e) => {
                done({ success: false, iterations: 0, error: e.message, logPath });
            });
        });
    }
    /* v8 ignore start -- appendAgentLog failures are best-effort and not exercised via public APIs */
    static #appendAgentLog(agentLog, text, action, failed = false) {
        if (failed)
            return true;
        try {
            appendAgentLog(agentLog, text);
            return false;
        }
        catch (error) {
            console.error(`[CopilotAgent] failed to ${action}: ${errorMessage(error)}`);
            return true;
        }
    }
    /* v8 ignore stop */
    #prompt(task, cwd) {
        const taskDir = (() => {
            const rel = relative(cwd, task.directory);
            return rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../')
                ? rel
                : task.directory;
        })();
        // Copilot CLI exposes shell/file tools, not pi's experiment tools, so this prompt
        // spells out the benchmark loop explicitly instead of naming pi-only tools.
        return [
            `You are an autonomous coding agent. Working directory: ${cwd}.`,
            '',
            `Step 1: Read ${taskDir}/autoresearch.md.`,
            'Step 2: From the current worktree/repo root, read AGENTS.md if present.',
            'Step 3: Read docs/DEVELOP.md and docs/TESTING.md if present.',
            'Step 4: Follow the above guidance files strictly for implementation and tests.',
            'Step 5: Respect local worktree environment/configuration (package scripts, Node/toolchain version, and existing environment variables).',
            '',
            `Run the benchmark with: node ${taskDir}/benchmark.js`,
            'Read the printed "METRIC <name>=<value>" line.',
            'Edit only files listed in the task scope.',
            'Iterate until the metric reaches its target value of 0.',
            '',
            `IMPORTANT: Do NOT modify, delete, or move any files inside ${taskDir}/ except autoresearch.md.`,
            'The orchestrator manages benchmark.js, autoresearch.sh, and agent logs there.',
            'Your edits belong in the working directory (the worktree/repo), not the task directory.',
        ].join('\n');
    }
}
//# sourceMappingURL=CopilotAgent.js.map