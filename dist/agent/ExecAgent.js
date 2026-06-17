import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { env } from '../shared/env.js';
import { appendAgentLog, openAgentLog, runLogName } from './AgentLog.js';
import { consumeLines, formatRawLine } from './agentActivity.js';
import { positiveInt } from './CodingAgent.js';
const DEFAULT_AGENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Deterministic coding agent: runs the command in `ORCH_AGENT_CMD` as a child
 * process in the worktree, treating exit 0 as success. A real custom-command
 * agent and the E2E enabler — a scripted command makes exactly the worktree
 * change a scenario needs, so the suite stays offline and never flakes.
 */
export class ExecAgent {
    name = 'exec';
    #agentLogMaxBytes;
    #agentLogRaw;
    constructor(opts = {}) {
        this.#agentLogMaxBytes = positiveInt(opts.agentLogMaxBytes ?? env.agentLogMaxBytes, DEFAULT_AGENT_LOG_MAX_BYTES);
        this.#agentLogRaw = opts.agentLogRaw ?? env.agentLogRaw;
    }
    checkPrerequisites() {
        const cmd = env.agentCmd;
        const ok = cmd.length > 0;
        return [{
                name: 'command',
                ok,
                message: ok
                    ? `agent command configured: ${cmd}`
                    : 'set ORCH_AGENT_CMD to the command to run as the agent',
            }];
    }
    spawn(task, worktreePath, signal) {
        const cmd = env.agentCmd;
        const cwd = worktreePath ?? task.directory;
        const logPath = join(task.directory, runLogName());
        const agentLog = openAgentLog(logPath, this.#agentLogMaxBytes);
        const childEnv = {
            ...process.env,
            ORCH_TASK_NUMBER: String(task.taskNumber),
            ORCH_TASK_DIR: task.directory,
            ORCH_WORKTREE: cwd,
            ORCH_GOAL: task.goal,
        };
        ExecAgent.#append(agentLog, [
            `=== exec agent started at ${new Date().toISOString()} ===`,
            `=== command: ${cmd} ===`,
            `=== cwd: ${cwd} ===`,
            '',
        ].join('\n'));
        return new Promise(resolve => {
            let settled = false;
            const done = (result) => {
                if (!settled) {
                    settled = true;
                    resolve(result);
                }
            };
            const child = spawn(cmd, {
                cwd,
                env: childEnv,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let aborted = false;
            signal?.addEventListener('abort', () => { aborted = true; child.kill(); }, { once: true });
            let lineBuffer = '';
            const handleData = (txt) => {
                if (this.#agentLogRaw) {
                    ExecAgent.#append(agentLog, txt);
                    return;
                }
                const consumed = consumeLines(lineBuffer, txt);
                lineBuffer = consumed.rest;
                if (consumed.lines.length > 0) {
                    ExecAgent.#append(agentLog, `${consumed.lines.map(line => formatRawLine(line)).join('\n')}\n`);
                }
            };
            child.stdout?.on('data', (d) => handleData(d.toString()));
            child.stderr?.on('data', (d) => handleData(d.toString()));
            child.on('close', (code) => {
                if (!this.#agentLogRaw && lineBuffer.length > 0) {
                    ExecAgent.#append(agentLog, `${formatRawLine(lineBuffer)}\n`);
                }
                const abortedError = 'exec agent aborted';
                const exitError = `agent command exited with code ${code ?? 'unknown'}`;
                const error = aborted ? abortedError : code === 0 ? '' : exitError;
                ExecAgent.#append(agentLog, [
                    `=== exec agent ended (exit ${code}) ===`,
                    error ? `=== failure ${error} ===` : '',
                    '',
                ].filter(Boolean).join('\n'));
                if (aborted) {
                    done({ success: false, iterations: 1, error: abortedError, logPath });
                }
                else if (code === 0) {
                    done({ success: true, iterations: 1, logPath });
                }
                else {
                    done({ success: false, iterations: 1, error: exitError, logPath });
                }
            });
            child.on('error', (e) => {
                done({ success: false, iterations: 1, error: e.message, logPath });
            });
        });
    }
    /* v8 ignore start -- best-effort log writes; failures are not exercised via public APIs */
    static #append(log, text) {
        try {
            appendAgentLog(log, text);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ExecAgent] failed to write agent log: ${message}`);
        }
    }
}
//# sourceMappingURL=ExecAgent.js.map