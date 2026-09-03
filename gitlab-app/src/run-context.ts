/**
 * Builds the environment one runner container needs.
 *
 * The integration's entrypoints (src/entrypoints/prepare.ts, base-action, and
 * update-comment-gitlab.ts) never call a CI API — they read plain environment
 * variables, and parseGitLabContext() in src/gitlab/context.ts falls back to
 * process.env for everything while hard-requiring only CI_PROJECT_ID. That is
 * the whole reason this code runs unchanged outside a pipeline: we synthesise
 * the handful of CI_* variables it reads and pass them to `docker run -e`.
 *
 * Paths inside the container all hang off /builds, which is a per-run directory
 * on the host. base-action resolves its temp dir as
 * RUNNER_TEMP || CI_BUILDS_DIR || /tmp (base-action/src/run-claude.ts:11), so
 * pinning RUNNER_TEMP=/builds/tmp puts claude-live.jsonl and
 * claude-execution-output.json somewhere the daemon can read from the host —
 * which is how metrics survive a container we had to kill.
 */

export type ResourceType = "issue" | "merge_request";

/** Where the run was asked for. Only affects the note we synthesise. */
export type RunSource = "gitlab" | "control-room";

export interface RunRequest {
  projectId: number | string;
  projectPath: string;
  projectName?: string;
  resourceType: ResourceType;
  resourceId: string;
  /** Branch Claude works on. Created by the caller before we get here. */
  branch: string;
  author: string;
  /** The comment text as it appears (or would appear) on the issue/MR. */
  note: string;
  /** Just the instruction, with the trigger phrase stripped. */
  directPrompt: string;
  issueTitle?: string;
  webhookPayload?: unknown;
  source: RunSource;
}

export interface RunPaths {
  /** Per-run directory on the host, bind-mounted to /builds. */
  work: string;
  /** Host path of base-action's streaming output. */
  liveFile: string;
  /** Host path of the run's final result JSON. */
  outputFile: string;
}

/** Container-side layout. Kept in one place so run.sh and the daemon agree. */
export const CONTAINER = {
  builds: "/builds",
  temp: "/builds/tmp",
  repo: "/builds/repo",
} as const;

export function runPaths(work: string): RunPaths {
  return {
    work,
    liveFile: `${work}/tmp/claude-live.jsonl`,
    outputFile: `${work}/tmp/claude-execution-output.json`,
  };
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/**
 * The non-secret half of the environment: everything derived from the request.
 * Secrets are added separately in local-runner so they never pass through logs.
 */
export function buildRunEnv(
  req: RunRequest,
  runId: string,
  opts: { startedAt: string; runUrl?: string },
): Record<string, string> {
  const serverUrl = (process.env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
  const host = serverUrl.replace(/^https?:\/\//, "");
  const triggerPhrase = process.env.TRIGGER_PHRASE || "@claude";

  return {
    // ---- what the integration's own code reads ----
    CLAUDE_TRIGGER: "true",
    CLAUDE_AUTHOR: str(req.author),
    CLAUDE_RESOURCE_TYPE: req.resourceType,
    CLAUDE_RESOURCE_ID: str(req.resourceId),
    CLAUDE_NOTE: str(req.note),
    CLAUDE_PROJECT_PATH: str(req.projectPath),
    CLAUDE_BRANCH: str(req.branch),
    TRIGGER_PHRASE: triggerPhrase,
    DIRECT_PROMPT: str(req.directPrompt),
    GITLAB_WEBHOOK_PAYLOAD: req.webhookPayload ? JSON.stringify(req.webhookPayload) : "",

    // ---- CI_* variables GitLab used to provide ----
    // Only CI_PROJECT_ID is mandatory; the rest have fallbacks in context.ts,
    // but supplying them keeps comments, links and git identity correct.
    CI_JOB_ID: runId,
    CI_PIPELINE_ID: runId,
    CI_PROJECT_ID: str(req.projectId),
    CI_PROJECT_PATH: str(req.projectPath),
    CI_PROJECT_NAME: str(req.projectName || req.projectPath.split("/").pop()),
    CI_PROJECT_DIR: CONTAINER.repo,
    CI_BUILDS_DIR: CONTAINER.builds,
    RUNNER_TEMP: CONTAINER.temp,
    CI_SERVER_URL: serverUrl,
    CI_SERVER_HOST: host,
    CI_COMMIT_REF_NAME: str(req.branch),
    CI_JOB_STARTED_AT: opts.startedAt,
    // Points at the Control Room run page rather than a job that no longer
    // exists — this is what Claude's own comment links back to.
    CI_PIPELINE_URL: str(opts.runUrl),

    GITLAB_USER_NAME: process.env.GIT_AUTHOR_NAME || "Claude Bot",
    GITLAB_USER_EMAIL: process.env.GIT_AUTHOR_EMAIL || `claude-bot@${host}`,

    // ---- base-action inputs (were `export INPUT_*` in the job's script) ----
    ANTHROPIC_MODEL: process.env.CLAUDE_MODEL || "claude-opus-4-8",
    CLAUDE_CODE_ACTION: "1",
    INPUT_PROMPT_FILE: `${CONTAINER.temp}/claude-prompts/claude-prompt.txt`,
    INPUT_TIMEOUT_MINUTES: process.env.CLAUDE_TIMEOUT_MINUTES || "60",
    INPUT_ALLOWED_TOOLS: process.env.ALLOWED_TOOLS || "Bash,Read,Edit,Write,Glob,Grep",
    INPUT_DISALLOWED_TOOLS: process.env.DISALLOWED_TOOLS || "",
    INPUT_MAX_TURNS: process.env.MAX_TURNS || "",
    INPUT_CLAUDE_ENV: process.env.CLAUDE_ENV || "",
    INPUT_FALLBACK_MODEL: process.env.FALLBACK_MODEL || "",
    INPUT_MCP_CONFIG: "",
    INPUT_SETTINGS: "",
    INPUT_SYSTEM_PROMPT: "",
    INPUT_APPEND_SYSTEM_PROMPT: "",
    DETAILED_PERMISSION_MESSAGES: "1",
  };
}

/**
 * The minimal note-hook payload the pipeline used to forward. prepare.ts reads
 * it opportunistically (src/gitlab/context.ts:107 returns null when absent), so
 * this is about keeping the Control Room path identical to the webhook path
 * rather than satisfying a hard requirement.
 */
export function synthesizePayload(req: RunRequest, projectWebUrl?: string) {
  return {
    object_kind: "note",
    project: {
      id: req.projectId,
      name: req.projectName || req.projectPath.split("/").pop(),
      path_with_namespace: req.projectPath,
      web_url: projectWebUrl,
    },
    user: { username: req.author, name: req.author },
    object_attributes: {
      note: req.note,
      noteable_type: req.resourceType === "issue" ? "Issue" : "MergeRequest",
    },
    ...(req.resourceType === "issue"
      ? { issue: { iid: Number(req.resourceId), title: req.issueTitle, state: "opened" } }
      : { merge_request: { iid: Number(req.resourceId), title: req.issueTitle, state: "opened" } }),
  };
}
