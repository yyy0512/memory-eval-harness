```javascript
#!/usr/bin/env node
/**
 * StreamPulse Nexus – Continuous-Integration Build Script
 * -------------------------------------------------------
 * This Node-powered script is invoked by the CI runner (GitHub Actions,
 * GitLab, Jenkins, etc.) to build, lint, test, and security-scan all
 * workspaces that make up the StreamPulse Nexus monorepo.
 *
 * Although the file ends in `.sh`, it is intentionally a Node script
 * because we need richer control-flow, parallelism and JSON/YAML parsing
 * that would become unwieldy in bash alone.  The CI job simply executes:
 *
 *    chmod +x ops/scripts/ci-build.sh
 *    ./ops/scripts/ci-build.sh
 *
 * …and the shebang will hand control to Node.
 *
 * Responsibilities
 * ----------------
 * 1. Discover all workspace packages (Yarn / PNPM / npm workspaces)
 * 2. Run code-quality gates (lint, unit tests, type-check, security scan)
 * 3. Build artifacts (e.g., Docker images or dist bundles)
 * 4. Produce a machine-readable manifest for downstream steps
 * 5. Exit with an aggregated status code so CI can fail fast
 *
 * Best-practice features:
 *   • Robust error handling with aggregation
 *   • Concurrent execution with graceful teardown on signal
 *   • ANSI-colored, timestamped log output
 *   • Minimal external dependencies (falls back gracefully if missing)
 */

'use strict';

/* ────────────────────────────────────────────────────────────────────────── *\
 | Imports                                                                   |
\* ─────────────────────────────────────────────────────────────────────────── */

const fs          = require('fs');
const path        = require('path');
const { spawn }   = require('child_process');
const os          = require('os');
const { promisify } = require('util');
const readline    = require('readline');

// Optional pretty-printing, fall back if not installed
let chalk;
try { chalk = require('chalk'); } catch { chalk = new Proxy({}, {
    get: () => (s) => s, // no-op colorizer
}); }

// Async utilities
const readdir = promisify(fs.readdir);
const access  = promisify(fs.access);

/* ────────────────────────────────────────────────────────────────────────── *\
 | Constants                                                                 |
\* ─────────────────────────────────────────────────────────────────────────── */

const ROOT_DIR            = path.resolve(__dirname, '..', '..'); // repo root
const WORKSPACE_CONFIG    = ['package.json', 'workspace.yml', 'workspace.yaml'];
const CONCURRENCY_LIMIT   = Math.max(os.cpus().length - 1, 2);   // parallel jobs
const LOG_PREFIX_WIDTH    = 16;

/* ────────────────────────────────────────────────────────────────────────── *\
 | Helper Functions                                                          |
\* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Returns high-resolution timestamp (HH:MM:SS.mmm)
 */
const now = () => new Date().toISOString().split('T')[1].replace('Z', '');

/**
 * Formats and writes a message to stdout with optional color.
 *
 * @param {string} prefix   – A label (e.g., "BUILD", "TEST")
 * @param {string} message  – Message body
 * @param {function} color  – chalk color function
 */
function log(prefix, message, color = chalk.gray) {
  const tag = color(prefix.padEnd(LOG_PREFIX_WIDTH));
  process.stdout.write(`${chalk.dim(now())} ${tag} ${message}\n`);
}

/**
 * Executes a shell command and captures stdout/stderr streams in real-time.
 *
 * @param {string} cmd            – Command executable
 * @param {string[]} args         – List of arguments
 * @param {object} options        – child_process.spawn options
 * @returns {Promise<void>}       – Resolves on exit code 0, rejects otherwise
 */
function exec(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'pipe', shell: false, ...options });

    // Prefix each output line with the command name
    const prefix = path.basename(cmd).toUpperCase().slice(0, LOG_PREFIX_WIDTH);
    const rlStdout = readline.createInterface({ input: child.stdout });
    const rlStderr = readline.createInterface({ input: child.stderr });

    rlStdout.on('line', (line) => log(prefix, line, chalk.cyan));
    rlStderr.on('line', (line) => log(prefix, line, chalk.red));

    child.on('error', (err) => reject(err));
    child.on('close', (code) => (code === 0 ? resolve() :
      reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/**
 * Discovers workspace directories by checking for config files.
 *
 * @returns {Promise<string[]>} Array of absolute directory paths
 */
async function discoverWorkspaces() {
  log('DISCOVER', 'Scanning for workspace packages…', chalk.magenta);

  const dirs = await readdir(ROOT_DIR, { withFileTypes: true });
  const candidates = dirs.filter((d) => d.isDirectory()).map((d) => path.join(ROOT_DIR, d.name));

  const workspaceDirs = [];
  for (const dir of candidates) {
    for (const cfg of WORKSPACE_CONFIG) {
      try {
        await access(path.join(dir, cfg), fs.constants.R_OK);
        workspaceDirs.push(dir);
        break;
      } catch {
        /* ignore */
      }
    }
  }

  log('DISCOVER', `Found ${workspaceDirs.length} workspaces.`, chalk.green);
  return workspaceDirs;
}

/**
 * Runs a build step (lint/test/build/scan) against a workspace.
 *
 * @param {string} step          – Name of step ("lint" | "test" | "build" | "scan")
 * @param {string} workspaceDir  – Absolute path
 */
async function runStep(step, workspaceDir) {
  const rel = path.relative(ROOT_DIR, workspaceDir);
  const prefix = `${step.toUpperCase()}:${rel}`;
  log(prefix, `Starting…`, chalk.blueBright);

  // Map step to npm lifecycle script; fall back to no-op
  const scriptMap = {
    lint : 'npm run lint --if-present',
    test : 'npm test --if-present --silent',
    build: 'npm run build --if-present',
    scan : 'npm audit --json',
  };

  const [cmd, ...cmdArgs] = scriptMap[step].split(' ');
  try {
    await exec(cmd, cmdArgs, { cwd: workspaceDir, env: process.env });
    log(prefix, 'Completed ✓', chalk.greenBright);
  } catch (err) {
    log(prefix, err.message, chalk.redBright);
    throw new Error(`${prefix} failed`);
  }
}

/**
 * Limits concurrency for iterator tasks.
 */
async function runWithPool(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);

    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
}

/* ────────────────────────────────────────────────────────────────────────── *\
 | Main Execution                                                            |
\* ─────────────────────────────────────────────────────────────────────────── */

(async function main() {
  const start = Date.now();
  let failures = 0;

  // Handle SIGINT / SIGTERM gracefully to free child processes
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(sig, 'Received, terminating…', chalk.yellow);
      process.exit(130);
    });
  }

  try {
    const workspaces = await discoverWorkspaces();

    // Build task matrix
    const steps = ['lint', 'test', 'build', 'scan'];
    const tasks = [];

    for (const dir of workspaces) {
      for (const step of steps) {
        tasks.push(() => runStep(step, dir));
      }
    }

    /* Run all tasks with concurrency control. Any rejected promises will be
       collected for summary, but tasks continue to run to provide a full
       report (fail-slow). */
    const results = await runWithPool(tasks, CONCURRENCY_LIMIT);

    results.forEach((res) => { if (res.status === 'rejected') failures += 1; });

  } catch (err) {
    log('FATAL', err.stack || err.message, chalk.redBright);
    failures += 1;
  } finally {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const summaryColor = failures === 0 ? chalk.bgGreen : chalk.bgRed;
    log('SUMMARY', summaryColor(` ${failures === 0 ? 'SUCCESS' : 'FAIL'} `) +
                  ` – ${failures} failure(s) in ${elapsed}s`, chalk.white);

    /* Emit a JSON artifact that downstream pipeline steps (e.g. slack
       notification, artifact upload) can consume. */
    const artifact = {
      timestamp: new Date().toISOString(),
      host      : os.hostname(),
      status    : failures === 0 ? 'passed' : 'failed',
      failures,
      duration_s: Number(elapsed),
    };
    const artifactsDir = path.join(ROOT_DIR, 'ci-artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactsDir, 'build-summary.json'),
      JSON.stringify(artifact, null, 2),
    );

    process.exit(failures === 0 ? 0 : 1);
  }
})();
```
