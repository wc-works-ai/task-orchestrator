#!/usr/bin/env node
/**
 * Manual live-agent smoke test — NOT part of any automated gate.
 *
 * Drives the REAL pi/copilot coding agent end-to-end through the orchestrator
 * CLI: it adds a trivial task ("create HELLO.txt"), runs a bounded number of
 * ticks, and confirms the task converges AND the agent's commit merges onto the
 * base branch. Everything runs against a throwaway git repo + a temp state root,
 * so it never touches real orchestrator state.
 *
 * Because it needs real credentials and is non-deterministic, it is run by hand
 * or nightly only — never in pre-commit, pre-push, or CI.
 *
 *   npm run smoke:live                     # default agent: pi
 *   ORCH_AGENT=copilot npm run smoke:live  # exercise the copilot agent instead
 *
 * Without credentials it prints "SKIPPED" and exits 0, so running it blind is
 * harmless. Knobs (all optional):
 *   ORCH_AGENT        pi (default) | copilot
 *   ORCH_MODEL        model override, passed straight through to the orchestrator
 *   SMOKE_REPO        use an existing git repo as the target instead of a temp one
 *   SMOKE_MAX_TICKS   max CLI ticks before giving up        (default 6)
 *   SMOKE_TIMEOUT_MS  overall wall-clock budget in ms       (default 600000)
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const TSX = resolve(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = resolve(ROOT, 'src', 'cli.ts');

const AGENT = process.env.ORCH_AGENT || 'pi';
const MAX_TICKS = intEnv('SMOKE_MAX_TICKS', 6, 1, 50);
const TIMEOUT_MS = intEnv('SMOKE_TIMEOUT_MS', 600_000, 10_000, 3_600_000);

const TASK_NAME = 'smoke';
const GOAL = 'create a file HELLO.txt containing hi';
const METRIC = 'hello_file';
const TARGET_FILE = 'HELLO.txt';

// Benchmark contract: metric is 0 once HELLO.txt exists in the working tree
// (cwd = worktree during the post-agent / pre-merge check), else 1.
const BENCHMARK = [
  "import { existsSync } from 'node:fs';",
  "import { join } from 'node:path';",
  `const done = existsSync(join(process.cwd(), ${JSON.stringify(TARGET_FILE)}));`,
  'console.log(`METRIC ' + METRIC + '=${done ? 0 : 1}`);',
].join('\n');

const temps = [];
let externalRepo; // a user-supplied SMOKE_REPO whose worktrees we prune on exit

main();

// ── Lifecycle ───────────────────────────────────────────────────────────────
function main() {
  console.log('=== live-agent smoke (manual; not a gate) ===');
  const stateRoot = mkTemp('orch-smoke-state-');
  const repo = process.env.SMOKE_REPO ? resolve(process.env.SMOKE_REPO) : makeThrowawayRepo();
  if (process.env.SMOKE_REPO) externalRepo = repo;
  const baseBranch = currentBranch(repo);

  console.log(`  agent:      ${AGENT}`);
  console.log(`  repo:       ${repo} (${process.env.SMOKE_REPO ? 'SMOKE_REPO' : 'throwaway'})`);
  console.log(`  branch:     ${baseBranch}`);
  console.log(`  state root: ${stateRoot}`);
  console.log(`  budget:     ${MAX_TICKS} ticks / ${TIMEOUT_MS} ms`);

  try {
    preflight(repo, stateRoot);
    seedTask(repo, stateRoot);
    const merged = runTicks(repo, stateRoot, baseBranch);
    if (merged) pass(`task converged and merged ${TARGET_FILE} onto ${baseBranch}`);
    fail('task did not converge & merge within the tick / time budget');
  } catch (e) {
    console.error('');
    console.error(`💥 ERROR — ${e instanceof Error ? e.stack || e.message : String(e)}`);
    cleanup();
    process.exit(1);
  }
}

// ── Credential preflight ────────────────────────────────────────────────────
// Run the real `--check` first. For copilot this fully covers auth; for pi the
// binary must exist but pi's own auth check is lenient, so we additionally
// require an API key env (matching PiAgent). Anything missing → SKIP, not fail.
function preflight(repo, stateRoot) {
  console.log('');
  console.log(`▶ preflight: orchestrator --check`);
  const r = runCli(['--check'], repo, stateRoot, {}, 60_000);
  echo(r);

  if (r.status !== 0) {
    skip(`agent prerequisites not met (--check exited ${r.status ?? 'null'})`);
  }
  if (AGENT === 'pi' && !(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY)) {
    skip('no pi API key found (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)');
  }
  console.log('  prerequisites OK — proceeding with the live run');
}

// ── Task setup ──────────────────────────────────────────────────────────────
function seedTask(repo, stateRoot) {
  console.log('');
  console.log(`▶ add task "${TASK_NAME}" — ${GOAL}`);
  const r = runCli(
    ['add', TASK_NAME, '--goal', GOAL, '--metric', METRIC, '--scope', TARGET_FILE],
    repo, stateRoot,
  );
  echo(r);
  if (r.status !== 0) fail(`add failed (exit ${r.status})`);

  const taskDir = parseTaskDir(r.stdout);
  if (!taskDir) fail('could not locate the created task directory in add output');
  // Replace the placeholder benchmark with one that checks for HELLO.txt.
  writeFileSync(join(taskDir, 'benchmark.js'), BENCHMARK);
  console.log(`  task dir: ${taskDir}`);
}

// ── Bounded tick loop ───────────────────────────────────────────────────────
// Returns true as soon as the agent's commit lands on the base branch (the
// definitive "converged & merged" proof, since merge only fires post-convergence).
function runTicks(repo, stateRoot, baseBranch) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (let i = 1; i <= MAX_TICKS; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { console.log('  ⏳ wall-clock budget exhausted'); break; }

    console.log('');
    console.log(`▶ tick ${i}/${MAX_TICKS} (≤ ${remaining} ms left)`);
    const r = runCli(['--once'], repo, stateRoot, { ORCH_CONVERGE: '1' }, remaining);
    echo(r);

    if (r.error) { console.log(`  tick stopped: ${r.error.message}`); break; }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (isAuthFailure(out)) skip('agent failed to authenticate at runtime (credentials invalid)');
    if (/❌ (Environment issue|Fatal):/.test(out)) skip('orchestrator reported an environment/credential issue');
    if (/✅ T\d+: metric=0/.test(out)) console.log('  tick reported convergence');

    if (fileOnBranch(repo, baseBranch, TARGET_FILE)) return true;
    if (/Nothing actionable\./.test(out)) { console.log('  nothing actionable (task is terminal) — stopping'); break; }
  }
  return false;
}

// ── Verdicts ────────────────────────────────────────────────────────────────
function pass(reason) { console.log(`\n✅ PASS — ${reason}`); cleanup(); process.exit(0); }

function fail(reason) {
  console.log(`\n❌ FAIL — ${reason}`);
  console.log('   Inspect the per-tick output above; agent logs live under the temp state root.');
  cleanup();
  process.exit(1);
}

function skip(reason) {
  console.log(`\n⏭️  SKIPPED — ${reason}`);
  console.log('   Live smoke needs real agent credentials; skipping is expected when none are configured.');
  cleanup();
  process.exit(0);
}

// ── Orchestrator CLI ────────────────────────────────────────────────────────
function runCli(args, repo, stateRoot, extraEnv = {}, timeout = 30_000) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: repo,
    timeout,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '', // isolate from the user's global git identity/config
      ORCH_REPO: repo,
      ORCH_STATE_ROOT: stateRoot,
      ORCH_AGENT: AGENT,
      ...extraEnv,
    },
  });
}

function echo(r) {
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
}

// The `add` command prints the absolute task directory on the line after its
// confirmation; grab it rather than re-deriving the state-path layout here.
function parseTaskDir(stdout) {
  const lines = (stdout || '').split(/\r?\n/);
  const i = lines.findIndex(l => /T\d+ added:/.test(l));
  const dir = i >= 0 ? (lines[i + 1] || '').trim() : '';
  return dir && existsSync(dir) ? dir : undefined;
}

function isAuthFailure(out) {
  return /No API key found for|authentication failed|not logged in|COPILOT_GITHUB_TOKEN/i.test(out);
}

// ── Git target ──────────────────────────────────────────────────────────────
function makeThrowawayRepo() {
  const repo = mkTemp('orch-smoke-repo-');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@example.com');
  git(repo, 'config', 'user.name', 'Live Smoke');
  writeFileSync(join(repo, 'README.md'), '# live-smoke target\n');
  // A trivial `npm run tc` so the orchestrator's hardcoded pre-merge verify gate
  // (ORCH_VERIFY_CMD='npm run tc') succeeds in the worktree.
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'smoke-target', version: '1.0.0', private: true, scripts: { tc: 'node -e ""' } }, null, 2) + '\n',
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  return repo;
}

function currentBranch(repo) {
  try {
    return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  } catch (e) {
    console.warn(`  could not detect base branch (${e.message}); assuming main`);
    return 'main';
  }
}

function fileOnBranch(repo, branch, file) {
  return spawnSync('git', ['cat-file', '-e', `${branch}:${file}`], { cwd: repo }).status === 0;
}

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function mkTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`  cleanup could not remove ${dir}: ${e.message}`);
    }
  }
  if (externalRepo) {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: externalRepo });
    } catch (e) {
      console.warn(`  cleanup could not prune worktrees in ${externalRepo}: ${e.message}`);
    }
    externalRepo = undefined;
  }
}

function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`  ${name}=${raw} out of range [${min}, ${max}]; using default ${def}`);
    return def;
  }
  return n;
}
