/**
 * GitLab Context Parser
 *
 * Parses GitLab CI/CD environment variables to create a context object
 */

export interface ParsedGitLabContext {
  projectId: string;
  mrIid?: string;
  issueIid?: string;
  host: string;
  pipelineUrl?: string;
  commitSha: string;
  commitBranch: string;
  userName: string;
  userEmail: string;
  triggerSource?: string;
}

export function parseGitLabContext(
  opts: {
    projectId?: string;
    mrIid?: string;
    issueIid?: string;
    host?: string;
    pipelineUrl?: string;
  } = {},
): ParsedGitLabContext {
  // Use provided options or fall back to environment variables
  const projectId = opts.projectId ?? process.env.CI_PROJECT_ID;
  // Route by CLAUDE_RESOURCE_TYPE, not CI_MERGE_REQUEST_IID: the latter is only
  // set on MR-event pipelines, but the @claude webhook triggers an ordinary
  // pipeline where it is empty even for an MR comment. Without this an MR's iid
  // lands in issueIid and comments POST to issues/{iid}/notes → 404.
  const isMergeRequest = process.env.CLAUDE_RESOURCE_TYPE === "merge_request";
  const mrIid =
    opts.mrIid ??
    process.env.CI_MERGE_REQUEST_IID ??
    (isMergeRequest ? process.env.CLAUDE_RESOURCE_ID : undefined);
  const issueIid =
    opts.issueIid ??
    (isMergeRequest ? undefined : process.env.CLAUDE_RESOURCE_ID);
  const host = opts.host ?? process.env.CI_SERVER_URL ?? "https://gitlab.com";
  const pipelineUrl = opts.pipelineUrl ?? process.env.CI_PIPELINE_URL;

  // Additional context from GitLab CI variables
  const commitSha = process.env.CI_COMMIT_SHA ?? "";
  const commitBranch = process.env.CI_COMMIT_REF_NAME ?? "";
  const userName =
    process.env.GITLAB_USER_NAME ?? process.env.CI_COMMIT_AUTHOR ?? "";
  const userEmail = process.env.GITLAB_USER_EMAIL ?? "";
  const triggerSource = process.env.CI_PIPELINE_SOURCE;

  if (!projectId) {
    throw new Error("GitLab project ID is required (CI_PROJECT_ID)");
  }

  return {
    projectId,
    mrIid,
    issueIid,
    host,
    pipelineUrl,
    commitSha,
    commitBranch,
    userName,
    userEmail,
    triggerSource,
  };
}

/**
 * Parse GitLab webhook payload for trigger detection
 */
export interface GitLabWebhookPayload {
  object_kind: "merge_request" | "note" | "issue";
  user?: {
    username: string;
    name: string;
  };
  object_attributes?: {
    title?: string;
    description?: string;
    note?: string;
    noteable_type?: string;
    action?: string;
    state?: string;
    iid?: number;
    source_branch?: string;
    target_branch?: string;
  };
  merge_request?: {
    iid: number;
    title: string;
    description: string;
    state: string;
    source_branch: string;
    target_branch: string;
  };
  project?: {
    id: number;
    path_with_namespace: string;
  };
}

export function parseGitLabWebhookPayload(): GitLabWebhookPayload | null {
  const payload = process.env.GITLAB_WEBHOOK_PAYLOAD;
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch (error) {
    console.error("Failed to parse GitLab webhook payload:", error);
    return null;
  }
}
