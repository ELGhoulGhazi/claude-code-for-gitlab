/**
 * The one path a run starts on, whoever asked for it.
 *
 * Two callers reach this: the GitLab note webhook (someone typed @claude on an
 * issue) and Control Room (someone typed into the chat box). Everything after
 * this point — branch, environment, container, MR, comment — is identical, so
 * a run started from the dashboard is indistinguishable from one started in
 * GitLab, which is the whole point.
 */

import { randomBytes } from "crypto";
import { getProject, createBranch, sanitizeBranchName } from "./gitlab";
import { logger } from "./logger";
import { startLocalRun } from "./local-runner";
import { runUrl } from "./control-room";
import { synthesizePayload, type ResourceType, type RunRequest, type RunSource } from "./run-context";

export interface StartRunInput {
  projectId: number;
  projectPath: string;
  projectName?: string;
  resourceType: ResourceType;
  resourceId: string;
  author: string;
  /** The comment body as it appears on the issue/MR. */
  note: string;
  /** The instruction alone. Derived from `note` when omitted. */
  directPrompt?: string;
  issueTitle?: string;
  /** Known for merge requests (their source branch); created for issues. */
  branch?: string;
  webhookPayload?: unknown;
  source: RunSource;
}

export interface StartedRun {
  runId: string;
  branch: string;
  url?: string;
}

export const triggerPhrase = () => process.env.TRIGGER_PHRASE || "@claude";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when a comment is addressed to Claude. */
export function mentionsTrigger(note: string): boolean {
  return new RegExp(`${escape(triggerPhrase())}\\b`, "i").test(note);
}

/** Everything after the trigger phrase — the actual instruction. */
export function extractPrompt(note: string): string {
  const m = note.match(new RegExp(`${escape(triggerPhrase())}\\s+(.*)`, "is"));
  return m ? m[1]!.trim() : "";
}

/**
 * Short, sortable, and safe as both a directory name and a Docker object name
 * ([a-zA-Z0-9][a-zA-Z0-9_.-]*). Replaces CI_JOB_ID as the Control Room run key;
 * both are opaque strings there, so old and new runs coexist with no migration.
 */
function newRunId(): string {
  return `cr-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export async function startRun(input: StartRunInput): Promise<StartedRun> {
  const directPrompt = input.directPrompt ?? extractPrompt(input.note);
  let branch = input.branch;

  // An issue has no branch of its own, so Claude gets a fresh one to push to.
  // The timestamp keeps a second @claude on the same issue from colliding with
  // the first one's branch.
  if (!branch) {
    if (input.resourceType !== "issue") {
      throw new Error("a merge request run needs its source branch");
    }
    const project = await getProject(input.projectId);
    const defaultBranch = project.default_branch || "main";
    branch = `claude/issue-${input.resourceId}-${sanitizeBranchName(input.issueTitle || "")}-${Date.now()}`;

    logger.info("Creating branch for issue", {
      issueIid: input.resourceId,
      branch,
      fromBranch: defaultBranch,
    });
    await createBranch(input.projectId, branch, defaultBranch);
  }

  const runId = newRunId();

  const req: RunRequest = {
    projectId: input.projectId,
    projectPath: input.projectPath,
    projectName: input.projectName,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    branch,
    author: input.author,
    note: input.note,
    directPrompt,
    issueTitle: input.issueTitle,
    source: input.source,
  };
  // prepare.ts reads this opportunistically. Synthesising one for the Control
  // Room path keeps the two callers byte-identical from here down.
  req.webhookPayload = input.webhookPayload ?? synthesizePayload(req);

  await startLocalRun(req, runId);

  logger.info("Run started", {
    runId,
    source: input.source,
    project: input.projectPath,
    branch,
    resource: `${input.resourceType}#${input.resourceId}`,
  });

  return { runId, branch, url: runUrl(runId) };
}
