import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { limitByUser } from "./limiter";
import { logger } from "./logger";
import type { WebhookPayload } from "./types";
import { sendPipelineNotification, sendRateLimitNotification } from "./discord";
import { startRun, mentionsTrigger, extractPrompt, triggerPhrase } from "./start-run";
import { isIgnoredAuthor } from "./gitlab";
import { getRun, listRuns, queueDepth } from "./local-runner";
import { controlRoomConfigured } from "./control-room";

const app = new Hono();

// Log all requests
app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  logger.info(`${method} ${path}`, {
    method,
    path,
    headers: logger.maskSensitive(Object.fromEntries(c.req.raw.headers)),
  });

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  logger.info(`${method} ${path} ${status} ${duration}ms`, {
    method,
    path,
    status,
    duration,
  });
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    disabled: process.env.CLAUDE_DISABLED === "true",
    controlRoom: controlRoomConfigured(),
    queue: queueDepth(),
  }),
);

// Optional admin endpoint to disable bot
app.get(
  "/admin/disable",
  bearerAuth({ token: process.env.ADMIN_TOKEN! }),
  (c) => {
    process.env.CLAUDE_DISABLED = "true";
    logger.warn("Bot disabled via admin endpoint");
    return c.text("disabled");
  },
);

app.get(
  "/admin/enable",
  bearerAuth({ token: process.env.ADMIN_TOKEN! }),
  (c) => {
    process.env.CLAUDE_DISABLED = "false";
    logger.info("Bot enabled via admin endpoint");
    return c.text("enabled");
  },
);

// ---------------------------------------------------------------------------
// GitLab note webhook — someone typed @claude on an issue or MR.
// ---------------------------------------------------------------------------

app.post("/webhook", async (c) => {
  const gitlabEvent = c.req.header("x-gitlab-event");
  const gitlabToken = c.req.header("x-gitlab-token");

  logger.debug("Webhook received", {
    event: gitlabEvent,
    hasToken: !!gitlabToken,
  });

  // Verify webhook secret
  if (gitlabToken !== process.env.WEBHOOK_SECRET) {
    logger.warn("Webhook unauthorized - invalid token");
    return c.text("unauthorized", 401);
  }

  // Only handle Note Hook events
  if (gitlabEvent !== "Note Hook") {
    logger.debug("Ignoring non-Note Hook event", { event: gitlabEvent });
    return c.text("ignored");
  }

  const body = await c.req.json<WebhookPayload>();

  logger.debug("Webhook payload received", {
    payload: logger.maskSensitive(body),
  });

  const note = body.object_attributes?.note || "";
  const projectId = body.project?.id;
  const projectPath = body.project?.path_with_namespace;
  const mrIid = body.merge_request?.iid;
  const issueIid = body.issue?.iid;
  const issueTitle = body.issue?.title;
  const authorUsername = body.user?.username;

  if (!mentionsTrigger(note)) {
    logger.debug(`No ${triggerPhrase()} mention found in note`);
    return c.text("skipped");
  }

  // Claude's own comments, and the ones Control Room mirrors onto an issue,
  // are posted with this same token. Acting on them would loop.
  if (await isIgnoredAuthor(authorUsername)) {
    logger.info("Ignoring a comment from the runner's own account", { author: authorUsername });
    return c.text("ignored-self");
  }

  if (process.env.CLAUDE_DISABLED === "true") {
    logger.warn("Bot is disabled, skipping trigger");
    return c.text("disabled");
  }

  // Rate limit: 3 triggers per author per MR/issue per 15 min
  const resourceId = mrIid || issueIid || "general";
  const key = `${authorUsername}:${projectId}:${resourceId}`;

  if (!(await limitByUser(key))) {
    logger.warn("Rate limit exceeded", { key, author: authorUsername });
    sendRateLimitNotification(
      projectPath,
      authorUsername,
      mrIid ? "merge_request" : issueIid ? "issue" : "unknown",
      String(mrIid || issueIid || ""),
    );
    return c.text("rate-limited", 429);
  }

  if (!mrIid && !issueIid) {
    logger.error("Note is on neither an issue nor a merge request");
    return c.text("unsupported-resource", 400);
  }
  if (mrIid && !body.merge_request?.source_branch) {
    logger.error("No source branch on the merge request");
    return c.text("no-branch-ref", 400);
  }

  logger.info(`${triggerPhrase()} triggered`, {
    project: projectPath,
    author: authorUsername,
    resourceType: mrIid ? "merge_request" : "issue",
    resourceId: mrIid || issueIid,
  });

  // Trimmed copy of the hook. prepare.ts reads it opportunistically; the 10KB
  // CI/CD variable ceiling that forced the trimming is gone, but a run's
  // environment is no place for a full webhook body either.
  const minimalPayload = {
    object_kind: body.object_kind,
    project: body.project,
    user: body.user,
    object_attributes: body.object_attributes
      ? {
          note: body.object_attributes.note,
          noteable_type: body.object_attributes.noteable_type,
        }
      : undefined,
    merge_request: body.merge_request
      ? {
          iid: body.merge_request.iid,
          title: body.merge_request.title,
          state: body.merge_request.state,
        }
      : undefined,
    issue: body.issue
      ? {
          iid: body.issue.iid,
          title: body.issue.title,
          state: body.issue.state,
        }
      : undefined,
  };

  try {
    const started = await startRun({
      projectId,
      projectPath,
      projectName: body.project?.name,
      resourceType: mrIid ? "merge_request" : "issue",
      resourceId: String(mrIid || issueIid),
      author: authorUsername,
      note,
      directPrompt: extractPrompt(note),
      issueTitle,
      branch: mrIid ? body.merge_request!.source_branch : undefined,
      webhookPayload: minimalPayload,
      source: "gitlab",
    });

    sendPipelineNotification({
      projectPath,
      authorUsername,
      resourceType: mrIid ? "merge_request" : "issue",
      resourceId: String(mrIid || issueIid || ""),
      branch: started.branch,
      runId: started.runId,
      runUrl: started.url,
      gitlabUrl: process.env.GITLAB_URL || "https://gitlab.com",
      triggerPhrase: triggerPhrase(),
      directPrompt: extractPrompt(note),
      issueTitle: issueTitle || undefined,
      source: "gitlab",
    });

    return c.json({ status: "started", runId: started.runId, branch: started.branch, url: started.url });
  } catch (error) {
    logger.error("Failed to start run", {
      error: error instanceof Error ? error.message : error,
      projectPath,
    });
    return c.json({ error: "Failed to start run" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Direct start — Control Room's chat box. Same run, different front door.
// ---------------------------------------------------------------------------

const runnerAuth = bearerAuth({
  verifyToken: async (token) => {
    const expected = process.env.RUNNER_TOKEN || "";
    return !!expected && token === expected;
  },
});

interface DirectRunBody {
  projectId: number | string;
  projectPath: string;
  projectName?: string;
  resourceType?: "issue" | "merge_request";
  resourceId: number | string;
  /** What the user typed. The trigger phrase is not required here. */
  message: string;
  author?: string;
  issueTitle?: string;
  /** Required for a merge request; issues get a fresh branch. */
  branch?: string;
}

app.post("/run", runnerAuth, async (c) => {
  if (process.env.CLAUDE_DISABLED === "true") {
    return c.json({ error: "runner is disabled" }, 503);
  }

  let body: DirectRunBody;
  try {
    body = await c.req.json<DirectRunBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const message = String(body.message ?? "").trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  if (!body.projectId || !body.projectPath || !body.resourceId) {
    return c.json({ error: "projectId, projectPath and resourceId are required" }, 400);
  }

  const resourceType = body.resourceType ?? "issue";
  if (resourceType === "merge_request" && !body.branch) {
    return c.json({ error: "branch is required for a merge_request run" }, 400);
  }

  const author = body.author || "control-room";
  const key = `${author}:${body.projectId}:${body.resourceId}`;
  if (!(await limitByUser(key))) {
    logger.warn("Rate limit exceeded (control room)", { key });
    return c.json({ error: "rate limited — too many runs on this issue" }, 429);
  }

  // The comment form is what prepare.ts renders into the prompt, so a chat
  // message is wrapped to look like the mention it replaces. Claude sees the
  // same input either way.
  const note = `${triggerPhrase()} ${message}`;

  try {
    const started = await startRun({
      projectId: Number(body.projectId),
      projectPath: String(body.projectPath),
      projectName: body.projectName,
      resourceType,
      resourceId: String(body.resourceId),
      author,
      note,
      directPrompt: message,
      issueTitle: body.issueTitle,
      branch: body.branch,
      source: "control-room",
    });

    sendPipelineNotification({
      projectPath: String(body.projectPath),
      authorUsername: author,
      resourceType,
      resourceId: String(body.resourceId),
      branch: started.branch,
      runId: started.runId,
      runUrl: started.url,
      gitlabUrl: process.env.GITLAB_URL || "https://gitlab.com",
      triggerPhrase: triggerPhrase(),
      directPrompt: message,
      issueTitle: body.issueTitle,
      source: "control-room",
    });

    return c.json({ status: "started", runId: started.runId, branch: started.branch, url: started.url });
  } catch (error) {
    logger.error("Failed to start run from Control Room", {
      error: error instanceof Error ? error.message : error,
      project: body.projectPath,
    });
    return c.json({ error: error instanceof Error ? error.message : "failed to start run" }, 500);
  }
});

/**
 * Liveness for one run. Control Room follows a run through its own event
 * stream, so this is for debugging and for the queued-but-not-started window.
 */
app.get("/runs/:id", runnerAuth, (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "unknown run" }, 404);
  return c.json({
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    branch: run.request.branch,
    project: run.request.projectPath,
    url: run.url,
  });
});

app.get("/runs", runnerAuth, (c) =>
  c.json({
    queue: queueDepth(),
    runs: listRuns().map((r) => ({
      runId: r.runId,
      status: r.status,
      startedAt: r.startedAt,
      project: r.request.projectPath,
      branch: r.request.branch,
    })),
  }),
);

const port = Number(process.env.PORT) || 3000;
logger.info(`GitLab Claude runner starting on port ${port}`, {
  controlRoom: controlRoomConfigured(),
  concurrency: queueDepth().max,
});

export default {
  port,
  fetch: app.fetch,
};
