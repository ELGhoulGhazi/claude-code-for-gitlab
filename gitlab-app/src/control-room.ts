/**
 * Control Room reporting.
 *
 * In the pipeline this lived in .gitlab-ci.yml: a start-ping in `script:`, a
 * backgrounded jq/curl loop tailing claude-live.jsonl, and an `after_script`
 * that posted final metrics. All three now run here, on the host, for one
 * reason: `after_script` was chosen because it runs on success, failure AND
 * timeout, and a container we kill ourselves has no such hook. Reading the
 * files from the host after `docker wait` gives the same guarantee back —
 * including for a container that was OOM-killed or timed out.
 *
 * Every function here is best-effort. Reporting must never fail a run.
 */

import { readFile } from "fs/promises";
import { logger } from "./logger";
import type { RunPaths } from "./run-context";

const CONTROL_ROOM_URL = (process.env.CONTROL_ROOM_URL || "").replace(/\/+$/, "");
const CONTROL_ROOM_TOKEN = process.env.CONTROL_ROOM_TOKEN || "";

export const controlRoomConfigured = () => !!(CONTROL_ROOM_URL && CONTROL_ROOM_TOKEN);

/** URL of a run's page, used as the link in Claude's own issue comment. */
export function runUrl(runId: string): string | undefined {
  const base = process.env.CONTROL_ROOM_PUBLIC_URL || CONTROL_ROOM_URL;
  return base ? `${base.replace(/\/+$/, "")}/runs/${runId}` : undefined;
}

async function post(path: string, body: unknown, timeoutMs = 15_000): Promise<boolean> {
  if (!controlRoomConfigured()) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CONTROL_ROOM_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONTROL_ROOM_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn("Control Room rejected a post", { path, status: res.status });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn("Control Room post failed", {
      path,
      error: error instanceof Error ? error.message : error,
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface StartPing {
  runId: string;
  projectId: string;
  projectName: string;
  repo: string;
  issue?: string;
  title?: string;
  branch: string;
  triggeredBy: string;
  triggerComment: string;
  startedAt: string;
  webUrl?: string;
}

/** Mark the run live so it appears on the dashboard the moment it is queued. */
export async function reportStart(p: StartPing): Promise<void> {
  await post("/api/ingest", { ...p, status: "running", pipelineId: p.runId });
}

/**
 * Incremental forwarder for base-action's stream-json output.
 *
 * Mirrors the shell loop it replaces: read every complete line, post only the
 * ones not yet accepted, and advance the cursor only on a 2xx so a failed post
 * is retried rather than skipped. The server dedupes by (runId, seq), so a
 * re-sent batch is harmless.
 */
export class LiveForwarder {
  private sent = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;

  constructor(
    private readonly runId: string,
    private readonly liveFile: string,
    private readonly intervalMs = 3_000,
  ) {}

  start(): void {
    if (!controlRoomConfigured() || this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // One final pass, so nothing written between the last tick and exit is lost.
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.inflight) return; // overlapping posts would double-count `sent`
    this.inflight = true;
    try {
      const events = await this.readComplete();
      if (events.length <= this.sent) return;
      const batch = events.slice(this.sent);
      const ok = await post(`/api/runs/${this.runId}/events`, { from: this.sent, events: batch }, 20_000);
      if (ok) this.sent = events.length;
    } catch {
      // file not written yet, or a torn read — the next tick retries
    } finally {
      this.inflight = false;
    }
  }

  /** Parsed events, dropping a trailing partial line the runner is mid-write on. */
  private async readComplete(): Promise<unknown[]> {
    let raw: string;
    try {
      raw = await readFile(this.liveFile, "utf8");
    } catch {
      return [];
    }
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // partial tail — stop here, it will be complete on the next read
        break;
      }
    }
    return out;
  }
}

interface ModelUsage {
  canonicalModel?: string;
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Pull the terminal `result` object out of base-action's output file. */
async function readResult(outputFile: string): Promise<any | null> {
  try {
    const parsed = JSON.parse(await readFile(outputFile, "utf8"));
    if (Array.isArray(parsed)) {
      const results = parsed.filter((e) => e && e.type === "result");
      return results.length ? results[results.length - 1] : null;
    }
    return parsed ?? null;
  } catch {
    return null;
  }
}

/**
 * Final report. Two posts, in the order the after_script used them:
 *
 *  1. a bare status flip, which must land or the run shows "running" forever
 *  2. best-effort metrics, which depend on a file that may not exist
 *
 * Splitting them is deliberate — a malformed or missing execution-output file
 * must never leave a finished run stuck live on the dashboard.
 */
export async function reportFinish(
  runId: string,
  projectId: string,
  status: "success" | "failed",
  statusReason: string | undefined,
  paths: RunPaths,
  base: { projectName: string; repo: string; branch: string; startedAt: string },
): Promise<void> {
  await post("/api/ingest", {
    runId,
    projectId,
    projectName: base.projectName,
    repo: base.repo,
    branch: base.branch,
    startedAt: base.startedAt,
    status,
    statusReason: statusReason || null,
  });

  const result = await readResult(paths.outputFile);
  if (!result) {
    logger.info("No execution-output result; metrics skipped", { runId });
    return;
  }

  const usage = result.usage ?? {};
  const modelUsage: Record<string, ModelUsage> = result.modelUsage ?? {};
  const entries = Object.entries(modelUsage);
  const dominant = entries.length
    ? entries.reduce((a, b) => ((b[1].costUSD ?? 0) > (a[1].costUSD ?? 0) ? b : a))
    : null;

  await post("/api/ingest", {
    runId,
    projectId,
    status,
    statusReason: statusReason || null,
    turns: result.num_turns ?? 0,
    costUsd: result.total_cost_usd ?? result.cost_usd ?? 0,
    durationSec: Math.floor((result.duration_ms ?? 0) / 1000),
    model: dominant ? (dominant[1].canonicalModel ?? dominant[0]) : undefined,
    tokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreate: usage.cache_creation_input_tokens ?? 0,
    },
    models: entries.map(([key, m]) => ({
      name: m.canonicalModel ?? key,
      costUsd: m.costUSD ?? 0,
      tokens: {
        input: m.inputTokens ?? 0,
        output: m.outputTokens ?? 0,
        cacheRead: m.cacheReadInputTokens ?? 0,
        cacheCreate: m.cacheCreationInputTokens ?? 0,
      },
    })),
  });
  logger.info("Control Room metrics ingested", { runId, status });
}
