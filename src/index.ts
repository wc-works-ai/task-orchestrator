export { Engine, MergeRecoveryAction } from './engine/Engine.js';
export type { EngineOptions, MergeRecoveryFailure, MergeRecoveryFn, TokenUsage } from './engine/Engine.js';
export { TaskState, Status, inProgress, isInProgress, CONVERGENCE_THRESHOLD } from './state/TaskState.js';
export type { TaskInfo, BenchmarkFn, TickResult } from './state/TaskState.js';
export { addTask } from './state/addTask.js';
export { piCommand, resolveCliCommand } from './agent/PiCommand.js';
export type { PiCommand } from './agent/PiCommand.js';
export { PiSpawner } from './agent/PiSpawner.js';
export type { PiSpawnerOptions } from './agent/PiSpawner.js';
export { CopilotCliAgent } from './agent/CopilotCliAgent.js';
export type { CopilotCliAgentOptions } from './agent/CopilotCliAgent.js';
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
