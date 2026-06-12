import type { SpawnResult } from './Engine.js';
import type { TaskState } from './TaskState.js';

export interface CodingAgent {
  readonly name: string;
  resolveModel(task: TaskState): string | undefined;
  resolveReasoning?(task: TaskState): string | undefined;
  spawn(task: TaskState, worktreePath?: string, signal?: AbortSignal): Promise<SpawnResult>;
}
