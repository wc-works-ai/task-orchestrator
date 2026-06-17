import { TaskState } from '../state/TaskState.js';
import type { SpawnResult, PrerequisiteResult, CodingAgentOptions } from './CodingAgent.js';
import type { CodingAgent } from './CodingAgent.js';
export interface CopilotAgentOptions extends CodingAgentOptions {
}
export declare class CopilotAgent implements CodingAgent {
    #private;
    readonly name = "copilot";
    constructor(opts?: CopilotAgentOptions);
    resolveModel(task: TaskState): string | undefined;
    resolveReasoning(task: TaskState): string | undefined;
    checkPrerequisites(): PrerequisiteResult[];
    spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult>;
}
