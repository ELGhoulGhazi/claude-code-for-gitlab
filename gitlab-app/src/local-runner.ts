/**
 * Runs one @claude job in a container on this host, in place of a GitLab CI job.
 *
 * GitLab CI was only ever supplying three things to that job: a trigger, a
 * container, and a set of CI_* variables. This module supplies the last two.
 * Everything inside the container — prepare.ts, base-action, the MR, the issue
 * comment — is byte-for-byte what the pipeline ran.
 *
 * Two things are deliberately done here rather than inside the container:
 *
 *   - Control Room reporting, because a container we kill on timeout cannot
 *     run its own `after_script` (see control-room.ts).
 *   - Concurrency limiting, because GitLab's job queue used to do it and
 *     nothing else will: four simultaneous @claude mentions each running a
 *     Gradle suite will flatten the VPS.
 */

import { spawn } from "child_process";
import { mkdir, rm, writeFile, chmod } from "fs/promises";
import { join, resolve } from "path";

import { logger } from "./logger";
import {
  buildRunEnv,
  runPaths,
  CONTAINER,
  type RunRequest,
  type RunPaths,
} from "./run-context";
import { LiveForwarder, reportStart, reportFinish, runUrl } from "./control-room";

const IMAGE = process.env.CLAUDE_RUNNER_IMAGE || "claude-runner:latest";
const WORK_ROOT = process.env.RUNNER_WORK_ROOT || "/srv/claude-runs";
// Resolved from the daemon's working directory (gitlab-app/), so run.sh can be
// edited and re-run without rebuilding the runner image it is mounted into.
const RUN_SH = resolve(process.env.RUNNER_ENTRYPOINT || "runner/run.sh");
const TIMEOUT_MIN = Number(process.env.RUN_TIMEOUT_MIN) || 70;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RUNS) || 2;
const DIND_ENABLED = process.env.RUNNER_DIND !== "false";
const DIND_IMAGE = process.env.DIND_IMAGE || "docker:28-dind";
// "never" | "onfailure" | "always" — failures are kept so a bad run is debuggable.
const KEEP_WORKDIR = process.env.KEEP_WORKDIR || "onfailure";

/** Secrets. Passed through the env file, never on the command line. */
function secretEnv(): Record<string, string> {
  const pick = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_GL_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
  ];
  const out: Record<string, string> = {};
  for (const k of pick) if (process.env[k]) out[k] = process.env[k]!;
  // The integration reads GITLAB_TOKEN for API calls; fall back to the token
  // the webhook server already uses when a dedicated one isn't configured.
  out.GITLAB_TOKEN =
    process.env.CLAUDE_CODE_GL_ACCESS_TOKEN || process.env.GITLAB_TOKEN || "";
  return out;
}

// ---------------------------------------------------------------------------
// A queue, because GitLab's used to be ours for free.
// ---------------------------------------------------------------------------

let active = 0;
const waiting: Array<() => void> = [];

export function queueDepth() {
  return { active, waiting: waiting.length, max: MAX_CONCURRENT };
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    logger.info("Run queued — concurrency limit reached", queueDepth());
    await new Promise<void>((res) => waiting.push(res));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// docker helpers
// ---------------------------------------------------------------------------

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((res) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      res({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      res({ code: -1, stdout, stderr: String(err) });
    });
  });
}

/** Fire-and-forget cleanup: a failure here must not mask the run's own result. */
async function quiet(args: string[]) {
  try {
    await docker(args, { timeoutMs: 30_000 });
  } catch {
    /* ignore */
  }
}

/**
 * Reproduces the pipeline's `services: docker:28-dind` block. The job's test
 * suites use Testcontainers against DOCKER_HOST=tcp://docker:2375, and five
 * @Testcontainers classes silently skip without it — the exact failure the
 * runner image was built to stop. A sidecar on a per-run network keeps that
 * behaviour without handing the host's docker socket to a container running
 * agent-authored code.
 */
async function startDind(runId: string): Promise<{ network: string; name: string } | null> {
  if (!DIND_ENABLED) return null;
  const network = `claude-net-${runId}`;
  const name = `claude-dind-${runId}`;

  const net = await docker(["network", "create", network], { timeoutMs: 30_000 });
  if (net.code !== 0) {
    logger.warn("Could not create run network; continuing without Docker", {
      runId,
      stderr: net.stderr.trim(),
    });
    return null;
  }

  const up = await docker(
    [
      "run", "-d", "--rm", "--privileged",
      "--name", name,
      "--network", network,
      "--network-alias", "docker",
      "-e", "DOCKER_TLS_CERTDIR=",
      DIND_IMAGE, "--tls=false",
    ],
    { timeoutMs: 120_000 },
  );
  if (up.code !== 0) {
    logger.warn("dind failed to start; tests needing Docker will fail", {
      runId,
      stderr: up.stderr.trim(),
    });
    await quiet(["network", "rm", network]);
    return null;
  }

  // Wait for the daemon to accept connections. GitLab's service startup raced
  // the same way; bounding it here turns a flaky suite into a clear warning.
  for (let i = 0; i < 30; i++) {
    const probe = await docker(["exec", name, "docker", "info"], { timeoutMs: 10_000 });
    if (probe.code === 0) {
      logger.info("dind ready", { runId });
      return { network, name };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  logger.warn("dind did not become ready in 30s; continuing anyway", { runId });
  return { network, name };
}

// ---------------------------------------------------------------------------
// the run itself
// ---------------------------------------------------------------------------

export interface RunHandle {
  runId: string;
  status: "queued" | "running" | "success" | "failed";
  startedAt: string;
  request: RunRequest;
  paths: RunPaths;
  url?: string;
}

const handles = new Map<string, RunHandle>();

export const getRun = (runId: string) => handles.get(runId);
export const listRuns = () => [...handles.values()];

/**
 * Values that may contain newlines cannot go into a docker --env-file, which is
 * strictly one KEY=value per line with no quoting or continuation. The two that
 * can (a comment body, and the instruction extracted from it) travel base64 and
 * are decoded by run.sh.
 */
const B64_KEYS = new Set(["CLAUDE_NOTE", "DIRECT_PROMPT"]);

function renderEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) continue;
    if (B64_KEYS.has(k)) {
      lines.push(`${k}_B64=${Buffer.from(String(v), "utf8").toString("base64")}`);
    } else {
      // Anything else with a newline would silently truncate the file, so drop
      // the newlines rather than corrupt every variable after it.
      lines.push(`${k}=${String(v).replace(/[\r\n]+/g, " ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function startLocalRun(req: RunRequest, runId: string): Promise<RunHandle> {
  const startedAt = new Date().toISOString();
  const work = join(WORK_ROOT, runId);
  const paths = runPaths(work);
  const url = runUrl(runId);

  const handle: RunHandle = { runId, status: "queued", startedAt, request: req, paths, url };
  handles.set(runId, handle);

  // Report before queueing, not before executing: a run waiting behind another
  // should still be visible on the dashboard rather than vanishing until a slot
  // opens up.
  await reportStart({
    runId,
    projectId: req.projectPath,
    projectName: req.projectName || req.projectPath.split("/").pop() || req.projectPath,
    repo: req.projectPath,
    issue: req.resourceType === "issue" ? `#${req.resourceId}` : undefined,
    title: req.issueTitle,
    branch: req.branch,
    triggeredBy: req.author,
    triggerComment: req.note,
    startedAt,
    webUrl: url,
  });

  // Deliberately not awaited: the caller (a webhook or an HTTP request from
  // Control Room) gets its runId immediately and follows progress live.
  void withSlot(() => execute(handle)).catch((err) =>
    logger.error("Run crashed outside the container", {
      runId,
      error: err instanceof Error ? err.message : err,
    }),
  );

  return handle;
}

async function execute(handle: RunHandle): Promise<void> {
  const { runId, request: req, paths } = handle;
  handle.status = "running";

  const base = {
    projectName: req.projectName || req.projectPath.split("/").pop() || req.projectPath,
    repo: req.projectPath,
    branch: req.branch,
    startedAt: handle.startedAt,
  };

  let dind: { network: string; name: string } | null = null;
  let timedOut = false;
  let code = -1;

  const forwarder = new LiveForwarder(runId, paths.liveFile);

  try {
    await mkdir(join(paths.work, "tmp"), { recursive: true });
    await chmod(paths.work, 0o700);

    const env = {
      ...buildRunEnv(req, runId, { startedAt: handle.startedAt, runUrl: handle.url }),
      ...secretEnv(),
    };
    const envFile = join(paths.work, ".runenv");
    await writeFile(envFile, renderEnvFile(env), { mode: 0o600 });

    dind = await startDind(runId);

    const args = [
      "run", "--rm",
      "--name", `claude-${runId}`,
      "--env-file", envFile,
      "-v", `${paths.work}:${CONTAINER.builds}`,
      "-v", `${RUN_SH}:/opt/run.sh:ro`,
      "-w", CONTAINER.builds,
    ];
    if (dind) {
      args.push("--network", dind.network, "-e", "DOCKER_HOST=tcp://docker:2375");
      args.push("-e", "DOCKER_TLS_CERTDIR=", "-e", "TESTCONTAINERS_RYUK_DISABLED=true");
    }
    args.push(IMAGE, "bash", "/opt/run.sh");

    logger.info("Starting run container", {
      runId,
      image: IMAGE,
      project: req.projectPath,
      branch: req.branch,
      dind: !!dind,
    });

    forwarder.start();

    code = await new Promise<number>((res) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      // Container logs go to the daemon's log; the transcript the user reads is
      // the event stream, not this.
      child.stdout?.on("data", (d) => process.stdout.write(`[${runId}] ${d}`));
      child.stderr?.on("data", (d) => process.stderr.write(`[${runId}] ${d}`));

      const killer = setTimeout(
        () => {
          timedOut = true;
          logger.warn("Run exceeded its timeout — killing", { runId, minutes: TIMEOUT_MIN });
          void quiet(["kill", `claude-${runId}`]);
        },
        TIMEOUT_MIN * 60_000,
      );

      child.on("close", (c) => {
        clearTimeout(killer);
        res(c ?? -1);
      });
      child.on("error", (err) => {
        clearTimeout(killer);
        logger.error("Failed to spawn docker", { runId, error: String(err) });
        res(-1);
      });
    });
  } catch (error) {
    logger.error("Run setup failed", {
      runId,
      error: error instanceof Error ? error.message : error,
    });
  } finally {
    await forwarder.stop();
    if (dind) {
      await quiet(["kill", dind.name]);
      await quiet(["network", "rm", dind.network]);
    }
  }

  const ok = code === 0 && !timedOut;
  handle.status = ok ? "success" : "failed";

  const reason = timedOut
    ? `timed out after ${TIMEOUT_MIN}m`
    : code === 0
      ? undefined
      : `runner exited ${code}`;

  await reportFinish(runId, req.projectPath, ok ? "success" : "failed", reason, paths, base);
  logger.info("Run finished", { runId, status: handle.status, code, timedOut });

  const keep = KEEP_WORKDIR === "always" || (KEEP_WORKDIR === "onfailure" && !ok);
  if (!keep) {
    await rm(paths.work, { recursive: true, force: true }).catch(() => {});
  } else {
    // The env file holds tokens; it never survives the run regardless.
    await rm(join(paths.work, ".runenv"), { force: true }).catch(() => {});
  }
}
