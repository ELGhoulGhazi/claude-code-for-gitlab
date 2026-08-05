/**
 * GitLab Provider Implementation
 *
 * Implements the SCM Provider interface for GitLab
 */

import { Gitlab } from "@gitbeaker/rest";
import { $ } from "bun";
import type {
  SCMProvider,
  SCMContext,
  RepoInfo,
  PullRequestInfo,
  CommentInfo,
  FileChange,
  BranchInfo,
  GitLabProviderOptions,
} from "./scm-provider";
import {
  parseGitLabContext,
  parseGitLabWebhookPayload,
  type ParsedGitLabContext,
} from "../gitlab/context";
import { checkGitLabTriggerAction } from "../gitlab/validation/trigger";
import {
  fetchGitLabMRData,
  fetchGitLabIssueData,
} from "../gitlab/data/fetcher";
import { gitlabApiGet } from "../gitlab/api-get";
import type {
  GitLabUser,
  GitLabMergeRequest,
  GitLabMergeRequestChanges,
  GitLabDiscussion,
  GitLabNote,
  GitLabMember,
  GitLabBranch,
  GitLabCommit,
  GitLabProject,
  GitLabRepositoryFile,
} from "../types/gitbeaker";

export class GitLabProvider implements SCMProvider {
  private api: InstanceType<typeof Gitlab>;
  private context: ParsedGitLabContext;
  private options: GitLabProviderOptions;
  private _mrInfo: PullRequestInfo | null = null; // Cache for MR info

  constructor(options: GitLabProviderOptions) {
    this.options = options;
    this.context = parseGitLabContext({
      projectId: options.projectId,
      mrIid: options.mrIid,
      issueIid: options.issueIid,
      host: options.host,
      pipelineUrl: options.pipelineUrl,
    });

    console.log(`GitLab Provider initialized:`);
    console.log(`  Host: ${this.context.host}`);
    console.log(`  Project ID: ${this.context.projectId}`);
    console.log(`  Token length: ${options.token.length}`);
    console.log(`  Token prefix: ${options.token.substring(0, 8)}...`);

    this.api = new Gitlab({
      host: this.context.host,
      token: options.token,
    });

    console.log(
      `GitLab API initialized with token length: ${options.token.length}`,
    );

    // Test token validity on initialization (skip in test environments)
    if (process.env.NODE_ENV !== "test" && !process.env.BUN_TEST) {
      this.validateToken().catch((error) => {
        console.error(
          `Token validation failed during initialization:`,
          error.message,
        );
      });
    }
  }

  private async validateToken(): Promise<void> {
    try {
      console.log("Testing token validity...");
      // Use showCurrentUser() to get current user in @gitbeaker
      const user = await this.api.Users.showCurrentUser();
      console.log(
        `Token is valid. Authenticated as: ${user.username} (${user.name})`,
      );

      // Test project access
      try {
        const project = await this.api.Projects.show(this.context.projectId);
        console.log(`Project access confirmed: ${project.path_with_namespace}`);
      } catch (projectError: any) {
        console.error(
          `Cannot access project ${this.context.projectId}:`,
          projectError.message,
        );
        if (projectError.response?.status) {
          console.error(
            `Project access error status: ${projectError.response.status}`,
          );
        }
      }
    } catch (error: any) {
      console.error(`Token validation failed:`, error.message);
      if (error.response?.status) {
        console.error(
          `Token validation error status: ${error.response.status}`,
        );
      }
      throw new Error(`Invalid GitLab token: ${error.message}`);
    }
  }

  getPlatform(): "gitlab" {
    return "gitlab";
  }

  async getRepoInfo(): Promise<RepoInfo> {
    const project = (await this.api.Projects.show(
      this.context.projectId,
    )) as unknown as GitLabProject;
    const [owner, repo] = project.path_with_namespace.split("/");

    return {
      owner: owner || "",
      repo: repo || "",
      defaultBranch: project.default_branch,
    };
  }

  getContext(): SCMContext {
    const webhook = parseGitLabWebhookPayload();
    const isMR =
      !!this.context.mrIid || webhook?.object_kind === "merge_request";
    const entityNumber = this.context.mrIid
      ? parseInt(this.context.mrIid)
      : this.context.issueIid
        ? parseInt(this.context.issueIid)
        : 0;

    return {
      platform: "gitlab",
      isPR: isMR,
      entityNumber,
      actor: this.context.userName || webhook?.user?.username || "",
      runId: this.context.pipelineUrl?.split("/").pop(),
      triggerEvent: webhook?.object_kind || "manual",
    };
  }

  async hasWritePermission(username: string): Promise<boolean> {
    // Skip permission checks if CC_SKIP_PRE_CHECK is set
    if (process.env.CC_SKIP_PRE_CHECK === "1") {
      console.log("Skipping permission check due to CC_SKIP_PRE_CHECK=1");
      return true;
    }

    // When using access tokens, we don't validate against specific usernames
    // Access tokens already have their own permissions
    if (process.env.CLAUDE_CODE_GL_ACCESS_TOKEN) {
      console.log("Using GitLab access token - skipping username validation");
      return true;
    }

    if (!username) {
      return false;
    }
    try {
      // 1. Find the user by username to get their ID
      console.log(`Looking up user by username: ${username}`);
      const users = (await this.api.Users.all({
        username,
      })) as unknown as GitLabUser[];

      if (users.length === 0) {
        console.log(`User '${username}' not found on GitLab instance.`);
        return false;
      }
      const user = users[0];
      if (!user) {
        return false;
      }
      const userId = user.id;
      console.log(`Found user ID: ${userId} for username: ${username}`);

      // 2. Use direct API call to check member including inherited permissions
      try {
        console.log(
          `Checking membership for project ${this.context.projectId} and user ${userId}`,
        );
        // GitLab API endpoint: /projects/:id/members/all/:user_id
        const member = await gitlabApiGet<GitLabMember>(
          this.context.host,
          this.options.token,
          `/projects/${this.context.projectId}/members/all/${userId}`,
        );
        console.log(`Member access level: ${member.access_level}`);
        // Developer (30), Maintainer (40), Owner (50) have write access
        return member.access_level >= 30;
      } catch (error: any) {
        console.error(`Error checking project membership:`, error);
        if ((error as any).response?.status === 404) {
          console.log(
            "User is not a member (direct or inherited) - 404 response",
          );
          return false;
        }
        throw error;
      }
    } catch (error) {
      console.error(`Error checking permissions for '${username}':`, error);
      return false;
    }
  }

  async isHumanActor(username: string): Promise<boolean> {
    try {
      console.log(`Checking if user is human: ${username}`);
      const users = (await this.api.Users.all({
        username,
      })) as unknown as GitLabUser[];

      if (users.length === 0) {
        console.log(`User '${username}' not found for human check`);
        return false; // User not found
      }
      const user = users[0];
      console.log(`User type: ${user?.user_type}, state: ${user?.state}`);
      // In GitLab, bot users have user_type 'project_bot' or similar
      // The `bot` property is a GitLab v16.0+ feature
      const isHuman =
        user?.user_type !== "project_bot" && user?.state === "active";
      console.log(`Human check result: ${isHuman}`);
      return isHuman;
    } catch (error) {
      console.error(`Error checking if user is human:`, error);
      return false;
    }
  }

  async getPullRequestInfo(): Promise<PullRequestInfo> {
    // Return cached info if available
    if (this._mrInfo) {
      return this._mrInfo;
    }

    if (!this.context.mrIid) {
      throw new Error("Not in a merge request context");
    }

    const mr = (await this.api.MergeRequests.show(
      this.context.projectId,
      parseInt(this.context.mrIid),
    )) as unknown as GitLabMergeRequest;

    // Cache the MR info
    this._mrInfo = {
      number: mr.iid,
      headSha: mr.sha,
      baseSha: mr.diff_refs?.base_sha || mr.sha,
      headBranch: mr.source_branch,
      baseBranch: mr.target_branch,
      author: mr.author.username,
      title: mr.title,
      body: mr.description || "",
      isDraft: mr.draft || mr.work_in_progress || false,
      state:
        mr.state === "opened"
          ? "open"
          : mr.state === "merged"
            ? "merged"
            : "closed",
    };

    return this._mrInfo;
  }

  async getComments(): Promise<CommentInfo[]> {
    let discussions: GitLabDiscussion[];

    if (this.context.mrIid) {
      // Get comments from merge request
      discussions = (await this.api.MergeRequestDiscussions.all(
        this.context.projectId,
        parseInt(this.context.mrIid),
      )) as unknown as GitLabDiscussion[];
    } else if (this.context.issueIid) {
      // Get comments from issue
      discussions = (await this.api.IssueDiscussions.all(
        this.context.projectId,
        parseInt(this.context.issueIid),
      )) as unknown as GitLabDiscussion[];
    } else {
      return [];
    }

    const comments: CommentInfo[] = [];
    discussions.forEach((discussion) => {
      discussion.notes.forEach((note) => {
        if (!note.system) {
          // Exclude system notes
          comments.push({
            id: note.id,
            author: note.author.username,
            body: note.body,
            createdAt: note.created_at,
          });
        }
      });
    });

    return comments;
  }

  async createComment(body: string): Promise<number> {
    console.log(`Creating comment for project ${this.context.projectId}`);
    console.log(
      `Context: MR IID=${this.context.mrIid}, Issue IID=${this.context.issueIid}`,
    );

    let note: GitLabNote;

    try {
      if (this.context.mrIid) {
        // Create comment on merge request using @gitbeaker
        console.log(
          `Creating MR comment for project ${this.context.projectId}, MR ${this.context.mrIid}`,
        );
        note = (await this.api.MergeRequestNotes.create(
          this.context.projectId,
          parseInt(this.context.mrIid),
          body,
        )) as unknown as GitLabNote;
      } else if (this.context.issueIid) {
        // Create comment on issue using raw fetch API for better control
        console.log(
          `Creating issue comment using raw API for project ${this.context.projectId}, issue ${this.context.issueIid}`,
        );
        console.log(
          `Token being used: length=${this.options.token.length}, prefix="${this.options.token.substring(0, 10)}..."`,
        );

        const url = `${this.context.host}/api/v4/projects/${this.context.projectId}/issues/${this.context.issueIid}/notes`;
        console.log(`API URL: ${url}`);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        // Try both authentication methods
        if (
          this.options.token.startsWith("glpat-") ||
          this.options.token.startsWith("gloas-")
        ) {
          headers["Authorization"] = `Bearer ${this.options.token}`;
          console.log("Using Bearer token authentication");
        } else {
          headers["PRIVATE-TOKEN"] = this.options.token;
          console.log("Using PRIVATE-TOKEN authentication");
        }

        console.log(`Request headers: ${JSON.stringify(Object.keys(headers))}`);

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ body }),
        });

        console.log(`Response status: ${response.status}`);
        console.log(
          `Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`,
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`API error response: ${errorText}`);
          throw new Error(
            `GitLab API error: ${response.status} ${response.statusText} - ${errorText}`,
          );
        }

        note = (await response.json()) as GitLabNote;
      } else {
        throw new Error(
          "Cannot create comment without merge request or issue context",
        );
      }

      console.log(`Comment created successfully with ID: ${note.id}`);
      return note.id;
    } catch (error: any) {
      console.error(`Failed to create comment:`, error.message);
      if (error.response?.status) {
        console.error(`API response status: ${error.response.status}`);
        console.error(`API response URL: ${error.response.url}`);
      }
      if (error.cause?.response?.headers) {
        console.error(
          `Response headers:`,
          Object.fromEntries(error.cause.response.headers.entries()),
        );
      }
      throw error;
    }
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    if (this.context.mrIid) {
      // Update comment on merge request
      await this.api.MergeRequestNotes.edit(
        this.context.projectId,
        parseInt(this.context.mrIid),
        commentId,
        { body },
      );
    } else if (this.context.issueIid) {
      // Update comment on issue
      await this.api.IssueNotes.edit(
        this.context.projectId,
        parseInt(this.context.issueIid),
        commentId,
        { body },
      );
    } else {
      throw new Error(
        "Cannot update comment without merge request or issue context",
      );
    }
  }

  async getDiff(): Promise<string> {
    if (!this.context.mrIid) {
      throw new Error("Not in a merge request context");
    }

    // GitLab changes endpoint needs special handling
    const mr = await gitlabApiGet<GitLabMergeRequestChanges>(
      this.context.host,
      this.options.token,
      `/projects/${this.context.projectId}/merge_requests/${parseInt(this.context.mrIid)}/changes`,
    );

    // Combine all file diffs
    return mr.changes
      .map((change) => {
        const header = `diff --git a/${change.old_path} b/${change.new_path}\n`;
        return header + change.diff;
      })
      .join("\n");
  }

  async getFileContent(path: string, ref: string): Promise<string> {
    try {
      const file = (await this.api.RepositoryFiles.show(
        this.context.projectId,
        path,
        ref,
      )) as unknown as GitLabRepositoryFile;

      // GitLab returns base64 encoded content
      return Buffer.from(file.content, "base64").toString("utf-8");
    } catch (error) {
      if ((error as any).response?.status === 404) {
        throw new Error(`File not found: ${path}`);
      }
      throw error;
    }
  }

  async getFilesContent(
    paths: string[],
    ref: string,
  ): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    // Batch fetch using Promise.all
    await Promise.all(
      paths.map(async (path) => {
        try {
          results[path] = await this.getFileContent(path, ref);
        } catch (error) {
          console.error(`Failed to fetch ${path}:`, error);
        }
      }),
    );

    return results;
  }

  async getChangedFiles(): Promise<FileChange[]> {
    if (!this.context.mrIid) {
      throw new Error("Not in a merge request context");
    }

    // GitLab changes endpoint needs special handling
    const mr = await gitlabApiGet<GitLabMergeRequestChanges>(
      this.context.host,
      this.options.token,
      `/projects/${this.context.projectId}/merge_requests/${parseInt(this.context.mrIid)}/changes`,
    );

    return mr.changes.map((change) => {
      // More robust diff parsing that ignores diff headers
      const diffLines = change.diff.split("\n");
      let additions = 0;
      let deletions = 0;
      let inDiffBody = false;

      for (const line of diffLines) {
        if (line.startsWith("@@")) {
          inDiffBody = true;
          continue;
        }
        if (inDiffBody) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions++;
          if (line.startsWith("-") && !line.startsWith("---")) deletions++;
        }
      }

      return {
        path: change.new_path,
        additions,
        deletions,
        changes: 0, // GitLab doesn't provide this directly
        patch: change.diff,
      };
    });
  }

  async createBranch(name: string, baseSha: string): Promise<void> {
    await this.api.Branches.create(this.context.projectId, name, baseSha);
  }

  async pushChanges(
    branch: string,
    message: string,
    files: Record<string, string>,
  ): Promise<string> {
    // Create a commit with multiple files
    const actions = Object.entries(files).map(([path, content]) => ({
      action: "update" as const,
      filePath: path,
      content,
    }));

    const commit = (await this.api.Commits.create(
      this.context.projectId,
      branch,
      message,
      actions,
    )) as unknown as GitLabCommit;

    return commit.id;
  }

  async getBranch(name: string): Promise<BranchInfo | null> {
    try {
      const branch = (await this.api.Branches.show(
        this.context.projectId,
        name,
      )) as unknown as GitLabBranch;

      return {
        name: branch.name,
        sha: branch.commit.id,
        protected: branch.protected,
      };
    } catch (error) {
      if ((error as any).response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async setupGitAuth(token: string): Promise<void> {
    // Configure git with GitLab credentials
    await $`git config --global user.name "${this.context.userName}"`.quiet();
    await $`git config --global user.email "${this.context.userEmail}"`.quiet();

    // Set up authentication for push
    const encodedToken = encodeURIComponent(token);
    const repoUrl = `https://oauth2:${encodedToken}@${this.context.host.replace("https://", "")}`;
    await $`git remote set-url origin ${repoUrl}/${this.context.projectId}.git`.quiet();
  }

  async applySuggestions(
    suggestions: Array<{
      file: string;
      line: number;
      suggestion: string;
      description?: string;
    }>,
  ): Promise<void> {
    if (!this.context.mrIid) {
      throw new Error("Suggestions can only be applied to merge requests");
    }

    // Fetch and cache MR info if not already done to get the correct SHAs
    const { baseSha, headSha } = await this.getPullRequestInfo();

    // GitLab uses discussions with suggestions
    for (const s of suggestions) {
      const position: any = {
        baseSha: baseSha,
        startSha: headSha, // For new suggestions, start_sha is the same as head_sha
        headSha: headSha,
        oldPath: s.file,
        newPath: s.file,
        positionType: "text",
        newLine: s.line.toString(),
      };

      const body = `${s.description || "Suggestion"}

\`\`\`suggestion
${s.suggestion}
\`\`\``;

      await this.api.MergeRequestDiscussions.create(
        this.context.projectId,
        parseInt(this.context.mrIid),
        body,
        { position },
      );
    }
  }

  getJobUrl(): string {
    return (
      this.context.pipelineUrl ||
      `${this.context.host}/${this.context.projectId}/-/pipelines`
    );
  }

  async checkTrigger(
    triggerPhrase: string,
    directPrompt?: string,
  ): Promise<boolean> {
    const payload = parseGitLabWebhookPayload();
    if (!payload) {
      console.log("No GitLab webhook payload found");
      return !!directPrompt;
    }

    return checkGitLabTriggerAction({
      payload,
      triggerPhrase,
      directPrompt,
    });
  }

  async fetchContextData(): Promise<any> {
    if (this.context.mrIid) {
      return fetchGitLabMRData(this.options.token, this.context);
    }

    if (this.context.issueIid) {
      return fetchGitLabIssueData(
        this.options.token,
        this.context,
        this.context.issueIid,
      );
    }

    // Return basic context if not in MR or Issue
    return {
      projectId: this.context.projectId,
      host: this.context.host,
      userName: this.context.userName,
    };
  }
}
