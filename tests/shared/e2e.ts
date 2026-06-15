/**
 * E2E harness: drive the real orchestrator CLI as a spawned process against a
 * real temp git repo + temp state root, then assert on git state, the SQLite
 * state DB, and stdout. Determinism comes from the `exec` agent (a scripted
 * local command) plus scripted `benchmark.js` files — no LLM, no network.
 *
 * All temp dirs live under os.tmpdir() (never the shared test-artifacts/ tree,
 * which races on worktrees) and are tracked for best-effort cleanup.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveStatePaths } from '../../src/StatePaths.js';
import { TaskDb, taskDirName, type TaskRow } from '../../src/TaskDb.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const TSX = resolve(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = resolve(REPO_ROOT, 'src', 'cli.ts');

/** Every temp dir created here, drained by {@link cleanupAll}. */
const tempDirs: string[] = [];

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function mkTemp(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

// ── Result + options ──────────────────────────────────────────────────────
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOpts {
  readonly repo: string;
  readonly stateRoot: string;
  /** Extra env vars merged over the inherited environment (e.g. ORCH_CONVERGE). */
  readonly env?: Record<string, string>;
  /** Override the child's working directory (defaults to the target repo). */
  readonly cwd?: string;
}

// ── Fixtures ──────────────────────────────────────────────────────────────
/** Fresh state-root dir (used as ORCH_STATE_ROOT). */
export function makeStateRoot(): string {
  return mkTemp('orch-e2e-state-');
}

/** A plain (non-git) directory usable as ORCH_REPO for --no-worktree scenarios. */
export function makePlainRepo(): string {
  return mkTemp('orch-e2e-repo-');
}

/**
 * A real git repo with an initial commit on `branch`. Includes a trivial,
 * always-passing `npm run tc` so the CLI's hardcoded pre-merge verify gate
 * succeeds in the worktree. Local user.name/email are set so commits work.
 */
export function makeTargetRepo(branch = 'main'): string {
  const repo = mkTemp('orch-e2e-repo-');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' });
  git('init', '-b', branch);
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  writeFileSync(join(repo, 'README.md'), '# e2e target\n');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'e2e-target', version: '1.0.0', private: true, scripts: { tc: 'node -e ""' } }, null, 2) + '\n',
  );
  git('add', '-A');
  git('commit', '-m', 'init');
  return repo;
}

// ── CLI invocation ────────────────────────────────────────────────────────
/**
 * Spawn `tsx src/cli.ts <args>` as a real process. Runs with cwd = the target
 * repo (so `add`'s branch detection sees the right repo) and never throws on a
 * non-zero exit — the caller asserts on `status`.
 */
export function runCli(args: readonly string[], opts: RunOpts): RunResult {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: opts.cwd ?? opts.repo,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '',
      ORCH_REPO: opts.repo,
      ORCH_STATE_ROOT: opts.stateRoot,
      ...opts.env,
    },
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run one cycle (`--once`). */
export const tick = (opts: RunOpts): RunResult => runCli(['--once'], opts);
/** Run the default loop until the run is complete (all tasks terminal). */
export const loop = (opts: RunOpts): RunResult => runCli([], opts);
/** `add <name>` with optional extra flags (e.g. ['--metric','foo']). */
export const addTask = (name: string, opts: RunOpts, extra: readonly string[] = []): RunResult =>
  runCli(['add', name, ...extra], opts);
export const status = (opts: RunOpts): RunResult => runCli(['--status'], opts);
export const config = (opts: RunOpts): RunResult => runCli(['--config'], opts);
export const check = (opts: RunOpts): RunResult => runCli(['--check'], opts);
export const graph = (opts: RunOpts): RunResult => runCli(['--graph'], opts);
export const stop = (opts: RunOpts): RunResult => runCli(['--stop'], opts);
export const help = (opts: RunOpts): RunResult => runCli(['--help'], opts);

// ── State paths + DB assertions ───────────────────────────────────────────
/** Resolve the tasks dir the same way the CLI does, so harness + CLI agree. */
export function tasksDirOf(stateRoot: string, repo: string): string {
  return resolveStatePaths({ repo, stateRoot }).tasks;
}

/** Absolute content dir for task `n` named `name` (flat `T0n-name` layout). */
export function taskContentDir(stateRoot: string, repo: string, n: number, name: string): string {
  return join(tasksDirOf(stateRoot, repo), taskDirName(n, name));
}

/** Open the real state DB and read task `n` for precise assertions. */
export function readTask(stateRoot: string, repo: string, n: number): TaskRow | undefined {
  const tdb = TaskDb.open(join(tasksDirOf(stateRoot, repo), 'state.db'));
  try {
    return tdb.getByNumber(n);
  } finally {
    tdb.close();
  }
}

/** Replace a task's `benchmark.js` with a scripted body. */
export function writeBenchmark(stateRoot: string, repo: string, n: number, name: string, body: string): void {
  writeFileSync(join(taskContentDir(stateRoot, repo, n, name), 'benchmark.js'), body);
}

// ── Git assertions (target repo) ──────────────────────────────────────────
/** Run git in `repo` and return stdout. */
export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

/** True if `file` is committed on `branch` (e.g. the agent's work landed). */
export function fileExistsOnBranch(repo: string, branch: string, file: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${branch}:${file}`], { cwd: repo, stdio: 'pipe' });
    return true;
  } catch {
    return false; // absent: git exits non-zero — a meaningful negative result
  }
}

// ── Scripted exec agent ───────────────────────────────────────────────────
/** Write a node script the `exec` agent will run, returning its path. */
export function writeAgentScript(dir: string, body: string): string {
  const path = join(dir, 'agent.mjs');
  writeFileSync(path, body);
  return path;
}

/** Env fragment selecting the `exec` agent with a scripted command. */
export function makeExecAgent(body: string): Record<string, string> {
  const path = writeAgentScript(mkTemp('orch-e2e-agent-'), body);
  return { ORCH_AGENT: 'exec', ORCH_AGENT_CMD: `node "${path}"` };
}

/** The `exec` agent wired to a no-op command (exits 0, changes nothing). */
export const NOOP_AGENT: Record<string, string> = { ORCH_AGENT: 'exec', ORCH_AGENT_CMD: 'node -e ""' };

// ── Legacy shard seeding (migration scenarios) ────────────────────────────
export interface LegacyShard {
  readonly status: string;
  readonly autoresearch: string;
  readonly benchmark: string;
}

/**
 * Pre-create an OLD-format file-shard task (`tasks/<status>/T0n-name/`) before
 * any DB exists, so the next Engine run imports it via reconcile.
 */
export function seedLegacyShard(stateRoot: string, repo: string, n: number, name: string, shard: LegacyShard): string {
  const dir = join(tasksDirOf(stateRoot, repo), shard.status.toLowerCase(), taskDirName(n, name));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.status'), shard.status);
  writeFileSync(join(dir, 'autoresearch.md'), shard.autoresearch);
  writeFileSync(join(dir, 'benchmark.js'), shard.benchmark);
  return dir;
}

// ── Cleanup ───────────────────────────────────────────────────────────────
/** Best-effort removal of every temp dir; tolerates Windows EBUSY on worktrees. */
export function cleanupAll(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e: unknown) {
      console.warn(`[e2e] cleanup could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
