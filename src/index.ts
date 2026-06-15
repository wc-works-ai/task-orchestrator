// agent
export { appendAgentLog, openAgentLog, runLogName } from './agent/AgentLog.js';
export type { AgentLog } from './agent/AgentLog.js';

export { resolveCliCommand } from './agent/CliCommand.js';
export type { ResolvedCommand } from './agent/CliCommand.js';

export {
  countOccurrences,
  positiveInt,
  resolveModel,
  resolveReasoning,
  tail,
} from './agent/CodingAgent.js';
export type {
  CodingAgent,
  CodingAgentOptions,
  PrerequisiteResult,
  SpawnFn,
  SpawnResult,
  TokenUsage,
} from './agent/CodingAgent.js';

export { CopilotAgent } from './agent/CopilotAgent.js';
export type { CopilotAgentOptions } from './agent/CopilotAgent.js';

export { ExecAgent } from './agent/ExecAgent.js';
export type { ExecAgentOptions } from './agent/ExecAgent.js';

export { killTree, PiAgent } from './agent/PiAgent.js';
export type { PiAgentOptions } from './agent/PiAgent.js';

export { Prerequisites } from './agent/Prerequisites.js';

export { createCodingAgent, SUPPORTED_AGENTS } from './agent/agents.js';

// engine
export { Engine, MergeRecoveryAction } from './engine/Engine.js';
export type {
  EngineOptions,
  MergeRecoveryFailure,
  MergeRecoveryFn,
  StopReason,
} from './engine/Engine.js';

export {
  formatOverview,
  formatRunSummary,
  printOverview,
  printRunSummary,
} from './engine/RunReport.js';

export { formatTaskGraph } from './engine/TaskGraph.js';
export type { GraphNode } from './engine/TaskGraph.js';

export { MergeConflictError, Worktree } from './engine/Worktree.js';
export type { WorktreeOptions } from './engine/Worktree.js';

// shared
export { readMeta, sha256, shouldRegenerate, writeMeta } from './shared/BenchmarkMeta.js';
export type { BenchmarkMeta, RegenInput } from './shared/BenchmarkMeta.js';

export {
  COMMAND_SPEC,
  CONFIG_SPEC,
  EXAMPLES,
  OPERATION_SPEC,
  formatEffectiveConfig,
  formatHelp,
  formatSettingsHelp,
} from './shared/config.js';
export type {
  ConfigItem,
  ExampleItem,
  HelpItem,
  HelpSettings,
} from './shared/config.js';

export { env } from './shared/env.js';

export {
  DbBusyError,
  DbCorruptError,
  DbInitError,
  OrchestratorError,
  SchemaMismatchError,
  Severity,
  handleOrchestratorError,
  withRetry,
} from './shared/errors.js';
export type { Logger, RetryOptions } from './shared/errors.js';

export { classifyBenchmark, parseMetrics, unmetSummary } from './shared/metrics.js';
export type {
  BenchmarkKind,
  BenchmarkOutcome,
  Criterion,
  MetricResult,
} from './shared/metrics.js';

export { appVersion } from './shared/version.js';

// state
export { defaultStateRoot, repoSlug, resolveStatePaths } from './state/StatePaths.js';
export type { StatePathInputs, StatePaths } from './state/StatePaths.js';

export {
  CONVERGENCE_THRESHOLD,
  MAX_FAILURES,
  Status,
  inProgress,
  isActionable,
  isInProgress,
} from './state/Status.js';

export { SCHEMA_VERSION, TaskDb, taskDirName } from './state/TaskDb.js';
export type { ImportTask, NewTask, TaskRow, TaskStatus } from './state/TaskDb.js';

export { TaskState } from './state/TaskState.js';
export type { BenchmarkFn, TaskInfo, TickNull, TickResult } from './state/TaskState.js';

export { addTask } from './state/addTask.js';
export type { AddTaskOptions } from './state/addTask.js';

export { migrateShards } from './state/migrate.js';

export { openDb, requireWal } from './state/sqlite.js';
export type { Db, Row, RunResult, SqlParams, SqlValue } from './state/sqlite.js';
