#!/usr/bin/env node

/**
 * Claude Code Pipeline Runner for GitLab
 * This script runs in the GitLab CI pipeline when triggered by the webhook server
 */

import { Gitlab } from "@gitbeaker/rest";
import { execSync } from "child_process";
import { writeFileSync } from "fs";

// Initialize GitLab client
const gitlab = new Gitlab({
  host: process.env.CI_SERVER_URL || "https://gitlab.com",
  token: process.env.GITLAB_TOKEN!,
});

interface ClaudeContext {
  projectId: string;
  resourceType: "merge_request" | "issue";
  resourceId: string;
  branch: string;
  author: string;
  note: string;
  projectPath: string;
}

async function extractClaudePrompt(note: string): Promise<string> {
  // Extract text after @claude mention
  const match = note.match(/@claude\s+([\s\S]*)/i);
  return match ? match[1].trim() : "";
}

async function runClaudeCode(prompt: string) {
  console.log("🤖 Running Claude Code...");
  console.log(`📝 Prompt: ${prompt}`);

  try {
    // Build the Claude Code command
    const claudeCommand = [
      "npx",
      "@anthropic/claude-code@latest",
      "--model",
      process.env.CLAUDE_MODEL || "opus",
      "--prompt",
      prompt,
    ];

    // Add custom instructions if provided
    if (process.env.CLAUDE_INSTRUCTIONS) {
      claudeCommand.push("--system", process.env.CLAUDE_INSTRUCTIONS);
    }

    // Execute Claude Code
    const output = execSync(claudeCommand.join(" "), {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      env: {
        ...process.env,
        // Pass necessary environment variables
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      },
    });

    console.log("✅ Claude Code execution completed");
    return output;
  } catch (error) {
    console.error("❌ Claude Code execution failed:", error);
    throw error;
  }
}

async function createMergeRequest(context: ClaudeContext) {
  const { projectId, branch, author } = context;

  try {
    // Check if MR already exists for this branch
    const existingMRs = await gitlab.MergeRequests.all({
      projectId,
      sourceBranch: branch,
      state: "opened",
    });

    if (existingMRs.length > 0) {
      console.log(`ℹ️ Merge request already exists: !${existingMRs[0].iid}`);
      return existingMRs[0];
    }

    // Get project details for default branch
    const project = await gitlab.Projects.show(projectId);
    const targetBranch = project.default_branch || "main";

    // Create new merge request
    const mr = await gitlab.MergeRequests.create(
      projectId,
      branch,
      targetBranch,
      `Claude: Automated changes for ${context.resourceType} #${context.resourceId}`,
      {
        description: `This merge request was automatically created by Claude in response to a mention by @${author}.\n\nOriginal request:\n> ${context.note}`,
        removeSourceBranch: true,
        assigneeId: undefined, // Let GitLab handle default assignee
      },
    );

    console.log(`✅ Created merge request: !${mr.iid}`);
    return mr;
  } catch (error) {
    console.error("❌ Failed to create merge request:", error);
    throw error;
  }
}

async function postComment(context: ClaudeContext, message: string) {
  const { projectId, resourceType, resourceId } = context;

  try {
    if (resourceType === "issue") {
      await gitlab.IssueNotes.create(projectId, parseInt(resourceId), message);
    } else if (resourceType === "merge_request") {
      await gitlab.MergeRequestNotes.create(
        projectId,
        parseInt(resourceId),
        message,
      );
    }
    console.log(`✅ Posted comment to ${resourceType} #${resourceId}`);
  } catch (error) {
    console.error("❌ Failed to post comment:", error);
    // Don't throw - commenting failure shouldn't fail the entire pipeline
  }
}

async function main() {
  // Parse context from environment variables
  const context: ClaudeContext = {
    projectId: process.env.CI_PROJECT_ID!,
    resourceType: process.env.CLAUDE_RESOURCE_TYPE as "merge_request" | "issue",
    resourceId: process.env.CLAUDE_RESOURCE_ID!,
    branch: process.env.CLAUDE_BRANCH!,
    author: process.env.CLAUDE_AUTHOR!,
    note: process.env.CLAUDE_NOTE!,
    projectPath: process.env.CLAUDE_PROJECT_PATH!,
  };

  console.log("🚀 Claude Pipeline Runner Started");
  console.log(`📦 Project: ${context.projectPath}`);
  console.log(`🔀 Branch: ${context.branch}`);
  console.log(`👤 Triggered by: @${context.author}`);

  try {
    // Extract prompt from the note
    const prompt = await extractClaudePrompt(context.note);
    if (!prompt) {
      throw new Error("No prompt found after @claude mention");
    }

    // Post initial comment
    await postComment(context, "🤖 Claude is working on your request...");

    // Run Claude Code
    const claudeOutput = await runClaudeCode(prompt);

    // Check if any changes were made
    const gitStatus = execSync("git status --porcelain", { encoding: "utf8" });

    if (gitStatus.trim()) {
      console.log("📝 Changes detected, committing...");

      // Commit changes
      execSync("git add -A");
      execSync(
        `git commit -m "Claude: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}"\n\nRequested by @${context.author} in ${context.resourceType} #${context.resourceId}`,
      );

      // Push changes
      execSync(`git push origin ${context.branch}`);

      // Create merge request if working on an issue
      if (context.resourceType === "issue") {
        const mr = await createMergeRequest(context);
        await postComment(
          context,
          `✅ Claude has completed the requested changes!\n\n` +
            `🔀 Merge Request: !${mr.iid}\n\n` +
            `Please review the changes and merge when ready.`,
        );
      } else {
        await postComment(
          context,
          `✅ Claude has pushed changes to branch \`${context.branch}\`.\n\n` +
            `Please review the changes.`,
        );
      }
    } else {
      console.log("ℹ️ No changes were needed");
      await postComment(
        context,
        `ℹ️ Claude analyzed your request but no code changes were needed.\n\n` +
          `Response: ${claudeOutput.substring(0, 500)}${claudeOutput.length > 500 ? "..." : ""}`,
      );
    }

    // Save output for artifacts
    const output = {
      success: true,
      prompt,
      branch: context.branch,
      changes: gitStatus.trim() !== "",
      response: claudeOutput,
    };

    writeFileSync("claude-output.json", JSON.stringify(output, null, 2));
    console.log("✅ Pipeline completed successfully");
  } catch (error) {
    console.error("❌ Pipeline failed:", error);

    // Post error comment
    await postComment(
      context,
      `❌ Claude encountered an error while processing your request:\n\n` +
        `\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``,
    );

    // Save error output
    const output = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };

    writeFileSync("claude-output.json", JSON.stringify(output, null, 2));
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
