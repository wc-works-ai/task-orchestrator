// agent
export {
  appendAgentLog,
  openAgentLog,
  runLogName,
  type AgentLog,
} from './agent/AgentLog.js';

export {
  resolveCliCommand,
  type ResolvedCommand,
} from './agent/cliCommand.js';

export {
  countOccurrences,
  positiveInt,
  resolveModel,
  resolveReasoning,
  tail,
  type CodingAgent,
  type CodingAgentOptions,
  type PrerequisiteResult,
  type SpawnFn,
  type SpawnResult,
  type TokenUsage,
} from './agent/CodingAgent.js';

export {
  CopilotAgent,
  type CopilotAgentOptions,
} from './agent/CopilotAgent.js';

export {
  ExecAgent,
  type ExecAgentOptions,
} from './agent/ExecAgent.js';

export {
  killTree,
  PiAgent,
  type PiAgentOptions,
} from './agent/PiAgent.js';

export {
  Prerequisites,
} from './agent/Prerequisites.js';

export {
  createCodingAgent,
  SUPPORTED_AGENTS,
} from './agent/agents.js';

// engine
export {
  Engine,
  MergeRecoveryAction,
  type EngineOptions,
  type MergeRecoveryFailure,
  type MergeRecoveryFn,
  type StopReason,
} from './engine/Engine.js';

export {
  formatOverview,
  formatRunSummary,
  printOverview,
  printRunSummary,
} from './engine/runReport.js';

export {
  formatTaskGraph,
  type GraphNode,
} from './engine/taskGraph.js';

export {
  MergeConflictError,
  Worktree,
  type WorktreeOptions,
} from './engine/Worktree.js';

// shared
export {
  readMeta,
  sha256,
  shouldRegenerate,
  writeMeta,
  type BenchmarkMeta,
  type RegenInput,
} from './shared/BenchmarkMeta.js';

export {
  COMMAND_SPEC,
  CONFIG_SPEC,
  EXAMPLES,
  OPERATION_SPEC,
  formatEffectiveConfig,
  formatHelp,
  formatSettingsHelp,
  type ConfigItem,
  type ExampleItem,
  type HelpItem,
  type HelpSettings,
} from './shared/config.js';

export {
  env,
} from './shared/env.js';

export {
  DbBusyError,
  DbCorruptError,
  DbInitError,
  OrchestratorError,
  SchemaMismatchError,
  Severity,
  handleOrchestratorError,
  withRetry,
  type Logger,
  type RetryOptions,
} from './shared/errors.js';

export {
  classifyBenchmark,
  parseMetrics,
  unmetSummary,
  type BenchmarkKind,
  type BenchmarkOutcome,
  type Criterion,
  type MetricResult,
} from './shared/metrics.js';

export {
  appVersion,
} from './shared/version.js';

// state
export {
  defaultStateRoot,
  repoSlug,
  resolveStatePaths,
  type StatePathInputs,
  type StatePaths,
} from './state/StatePaths.js';

export {
  CONVERGENCE_THRESHOLD,
  MAX_FAILURES,
  Status,
  inProgress,
  isActionable,
  isInProgress,
} from './state/Status.js';

export {
  SCHEMA_VERSION,
  TaskDb,
  taskDirName,
  type ImportTask,
  type NewTask,
  type TaskRow,
  type TaskStatus,
} from './state/TaskDb.js';

export {
  TaskState,
  type BenchmarkFn,
  type TaskInfo,
  type TickNull,
  type TickResult,
} from './state/TaskState.js';

export {
  addTask,
  type AddTaskOptions,
} from './state/addTask.js';

export {
  migrateShards,
} from './state/migrate.js';

export {
  openDb,
  requireWal,
  type Db,
  type Row,
  type RunResult,
  type SqlParams,
  type SqlValue,
} from './state/sqlite.js';
