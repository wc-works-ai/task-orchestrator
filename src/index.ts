export { Engine, MergeRecoveryAction } from './engine/Engine.js';
export type { EngineOptions, MergeRecoveryFailure, MergeRecoveryFn, TokenUsage } from './engine/Engine.js';
export { TaskState, Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD } from './state/TaskState.js';
export type { TaskInfo, BenchmarkFn, TickResult } from './state/TaskState.js';
export { addTask } from './state/addTask.js';
export { resolveCliCommand } from './agent/CliCommand.js';
export type { ResolvedCommand } from './agent/CliCommand.js';
export { PiAgent } from './agent/PiAgent.js';
export type { PiAgentOptions } from './agent/PiAgent.js';
export { CopilotAgent } from './agent/CopilotAgent.js';
export type { CopilotAgentOptions } from './agent/CopilotAgent.js';
export { ExecAgent } from './agent/ExecAgent.js';
export type { ExecAgentOptions } from './agent/ExecAgent.js';
export type { CodingAgent, CodingAgentOptions, PrerequisiteResult, SpawnResult, SpawnFn } from './agent/CodingAgent.js';
export { createCodingAgent, SUPPORTED_AGENTS } from './agent/agents.js';
export { defaultStateRoot, repoSlug, resolveStatePaths } from './state/StatePaths.js';
export type { StatePathInputs, StatePaths } from './state/StatePaths.js';
export { Prerequisites } from './agent/Prerequisites.js';
export {
  Severity,
  OrchestratorError,
  DbCorruptError,
  DbBusyError,
  DbInitError,
  SchemaMismatchError,
  handleOrchestratorError,
  withRetry,
} from './shared/errors.js';
export type { Logger, RetryOptions } from './shared/errors.js';
export { openDb, requireWal } from './state/sqlite.js';
export type { Db, SqlValue, SqlParams, Row, RunResult } from './state/sqlite.js';
export { TaskDb, SCHEMA_VERSION } from './state/TaskDb.js';
export type { TaskRow, NewTask, TaskStatus } from './state/TaskDb.js';
