import type { TaskState } from '../state/TaskState.js';
import type { SpawnResult, PrerequisiteResult, CodingAgentOptions, CodingAgent } from './CodingAgent.js';
export interface ExecAgentOptions extends CodingAgentOptions {
}
/**
 * Deterministic coding agent: runs the command in `ORCH_AGENT_CMD` as a child
 * process in the worktree, treating exit 0 as success. A real custom-command
 * agent and the E2E enabler — a scripted command makes exactly the worktree
 * change a scenario needs, so the suite stays offline and never flakes.
 */
export declare class ExecAgent implements CodingAgent {
    #private;
    readonly name = "exec";
    constructor(opts?: ExecAgentOptions);
    checkPrerequisites(): PrerequisiteResult[];
    spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult>;
}
