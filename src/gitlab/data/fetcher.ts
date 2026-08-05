/**
 * GitLab Data Fetcher
 *
 * Fetches merge request data from GitLab API
 */

import { Gitlab } from "@gitbeaker/rest";
import type { ParsedGitLabContext } from "../context";
import { gitlabApiGet } from "../api-get";
import type {
  GitLabMergeRequest,
  GitLabMergeRequestChanges,
  GitLabDiscussion,
  GitLabIssue,
} from "../../types/gitbeaker";

export interface GitLabMRData {
  iid: number;
  title: string;
  description: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  author: {
    username: string;
    name: string;
  };
  changes: Array<{
    old_path: string;
    new_path: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
    diff: string;
  }>;
  discussions: Array<{
    id: string;
    notes: Array<{
      id: number;
      body: string;
      author: {
        username: string;
        name: string;
      };
      created_at: string;
    }>;
  }>;
  diffRefs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  projectId: string;
  webUrl: string;
}

export async function fetchGitLabMRData(
  token: string,
  context: ParsedGitLabContext,
): Promise<GitLabMRData> {
  if (!context.mrIid) {
    throw new Error("Merge request IID is required to fetch MR data");
  }

  const api = new Gitlab({
    host: context.host,
    token,
  });

  // Fetch MR details, changes, and discussions in parallel
  const [mrDetails, mrChanges, discussions] = await Promise.all([
    api.MergeRequests.show(
      context.projectId,
      parseInt(context.mrIid),
    ) as Promise<unknown>,
    gitlabApiGet<GitLabMergeRequestChanges>(
      context.host,
      token,
      `/projects/${context.projectId}/merge_requests/${parseInt(context.mrIid)}/changes`,
    ),
    api.MergeRequestDiscussions.all(
      context.projectId,
      parseInt(context.mrIid),
    ) as Promise<unknown>,
  ]);

  const typedMrDetails = mrDetails as unknown as GitLabMergeRequest;
  const typedMrChanges = mrChanges as GitLabMergeRequestChanges;
  const typedDiscussions = discussions as unknown as GitLabDiscussion[];

  return {
    iid: typedMrDetails.iid,
    title: typedMrDetails.title,
    description: typedMrDetails.description || "",
    state: typedMrDetails.state,
    sourceBranch: typedMrDetails.source_branch,
    targetBranch: typedMrDetails.target_branch,
    author: {
      username: typedMrDetails.author.username,
      name: typedMrDetails.author.name,
    },
    changes: typedMrChanges.changes || [],
    discussions: typedDiscussions.map((d) => ({
      id: d.id,
      notes: d.notes.map((n) => ({
        id: n.id,
        body: n.body,
        author: {
          username: n.author.username,
          name: n.author.name,
        },
        created_at: n.created_at,
      })),
    })),
    diffRefs: typedMrDetails.diff_refs ||
      typedMrChanges.diff_refs || {
        base_sha: "",
        head_sha: "",
        start_sha: "",
      },
    projectId: context.projectId,
    webUrl: typedMrDetails.web_url,
  };
}

export interface GitLabIssueData {
  iid: number;
  title: string;
  description: string;
  state: string;
  author: {
    username: string;
    name: string;
  };
  labels: string[];
  discussions: Array<{
    id: string;
    notes: Array<{
      id: number;
      body: string;
      author: {
        username: string;
        name: string;
      };
      created_at: string;
    }>;
  }>;
  projectId: string;
  webUrl: string;
}

export async function fetchGitLabIssueData(
  token: string,
  context: ParsedGitLabContext,
  issueIid: string | number,
): Promise<GitLabIssueData> {
  const api = new Gitlab({
    host: context.host,
    token,
  });

  // Fetch issue details and discussions
  const [issueDetails, discussions] = await Promise.all([
    api.Issues.show(
      typeof issueIid === "string" ? parseInt(issueIid) : issueIid,
      { projectId: context.projectId },
    ) as Promise<unknown>,
    api.IssueDiscussions.all(
      context.projectId,
      typeof issueIid === "string" ? parseInt(issueIid) : issueIid,
    ) as Promise<unknown>,
  ]);

  const typedIssue = issueDetails as unknown as GitLabIssue;
  const typedDiscussions = discussions as unknown as GitLabDiscussion[];

  return {
    iid: typedIssue.iid,
    title: typedIssue.title,
    description: typedIssue.description || "",
    state: typedIssue.state,
    author: {
      username: typedIssue.author.username,
      name: typedIssue.author.name,
    },
    labels: typedIssue.labels.map((l) =>
      typeof l === "string" ? l : (l as any).name,
    ),
    discussions: typedDiscussions.map((d) => ({
      id: d.id,
      notes: d.notes.map((n) => ({
        id: n.id,
        body: n.body,
        author: {
          username: n.author.username,
          name: n.author.name,
        },
        created_at: n.created_at,
      })),
    })),
    projectId: context.projectId,
    webUrl: typedIssue.web_url,
  };
}
