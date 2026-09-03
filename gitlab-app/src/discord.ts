import { logger } from "./logger";

interface DiscordNotificationOptions {
  projectPath: string;
  authorUsername: string;
  resourceType: string;
  resourceId: string;
  branch: string;
  /** Control Room run id — replaces the GitLab pipeline id. */
  runId: string;
  /** Control Room run page. Absent when Control Room isn't configured. */
  runUrl?: string;
  gitlabUrl: string;
  triggerPhrase: string;
  directPrompt: string;
  issueTitle?: string;
  /** Where the run was asked for, so Discord shows the two apart. */
  source?: string;
}

/**
 * Send a Discord notification when a pipeline is triggered
 * This is fire-and-forget - errors are logged but don't affect the main flow
 */
export function sendPipelineNotification(
  options: DiscordNotificationOptions,
): void {
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!discordWebhookUrl) {
    // Discord notifications are optional
    return;
  }

  try {
    const {
      projectPath,
      authorUsername,
      resourceType,
      resourceId,
      branch,
      runId,
      runUrl,
      gitlabUrl,
      triggerPhrase,
      directPrompt,
      issueTitle,
      source,
    } = options;

    // Determine resource URL
    const resourceUrl =
      resourceType === "merge_request"
        ? `${gitlabUrl}/${projectPath}/-/merge_requests/${resourceId}`
        : resourceType === "issue"
          ? `${gitlabUrl}/${projectPath}/-/issues/${resourceId}`
          : null;

    // Create Discord embed
    const embed = {
      title:
        source === "control-room"
          ? "🤖 Claude Run Started (Control Room)"
          : "🤖 Claude Run Started",
      url: runUrl ?? resourceUrl ?? undefined,
      color: 0xfc6d26, // GitLab orange
      fields: [
        {
          name: "Project",
          value: projectPath,
          inline: true,
        },
        {
          name: "Triggered By",
          value: `@${authorUsername}`,
          inline: true,
        },
        {
          name: "Resource",
          value:
            resourceType === "merge_request"
              ? `Merge Request !${resourceId}`
              : resourceType === "issue"
                ? `Issue #${resourceId}${issueTitle ? ` - ${issueTitle}` : ""}`
                : "Unknown",
          inline: true,
        },
        {
          name: "Branch",
          value: `\`${branch}\``,
          inline: true,
        },
        {
          name: "Run",
          value: runUrl ? `[${runId}](${runUrl})` : runId,
          inline: true,
        },
        {
          name: "Trigger",
          value: triggerPhrase,
          inline: true,
        },
      ],
      footer: {
        text: "GitLab Claude Webhook",
        icon_url:
          "https://about.gitlab.com/images/press/logo/png/gitlab-icon-rgb.png",
      },
      timestamp: new Date().toISOString(),
    };

    // Add prompt if present
    if (directPrompt) {
      embed.fields.push({
        name: "Prompt",
        value:
          directPrompt.length > 100
            ? directPrompt.substring(0, 100) + "..."
            : directPrompt,
        inline: false,
      });
    }

    // Add resource link if available
    if (resourceUrl) {
      embed.fields.push({
        name: "View Resource",
        value: `[Open in GitLab](${resourceUrl})`,
        inline: false,
      });
    }

    const payload = {
      embeds: [embed],
    };

    // Send notification without awaiting (fire-and-forget)
    fetch(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((response) => {
        if (!response.ok) {
          logger.warn(`Discord notification failed`, {
            status: response.status,
            statusText: response.statusText,
          });
        } else {
          logger.debug("Discord notification sent successfully");
        }
      })
      .catch((error) => {
        logger.error("Error sending Discord notification", {
          error: error instanceof Error ? error.message : error,
        });
      });
  } catch (error) {
    logger.error("Failed to prepare Discord notification", {
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Send a rate limit notification to Discord
 */
export function sendRateLimitNotification(
  projectPath: string,
  authorUsername: string,
  resourceType: string,
  resourceId: string,
): void {
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!discordWebhookUrl) {
    return;
  }

  try {
    const embed = {
      title: "⚠️ Rate Limit Exceeded",
      color: 0xff0000, // Red
      description: `Claude requests have been rate-limited for @${authorUsername}`,
      fields: [
        {
          name: "Project",
          value: projectPath,
          inline: true,
        },
        {
          name: "User",
          value: `@${authorUsername}`,
          inline: true,
        },
        {
          name: "Resource",
          value: `${resourceType} ${resourceId}`,
          inline: true,
        },
      ],
      footer: {
        text: "GitLab Claude Webhook - Rate Limited",
        icon_url:
          "https://about.gitlab.com/images/press/logo/png/gitlab-icon-rgb.png",
      },
      timestamp: new Date().toISOString(),
    };

    const payload = {
      embeds: [embed],
    };

    // Send notification without awaiting
    fetch(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((response) => {
        if (!response.ok) {
          logger.warn(`Discord rate limit notification failed`, {
            status: response.status,
          });
        }
      })
      .catch((error) => {
        logger.error("Error sending Discord rate limit notification", {
          error: error instanceof Error ? error.message : error,
        });
      });
  } catch (error) {
    logger.error("Failed to prepare Discord rate limit notification", {
      error: error instanceof Error ? error.message : error,
    });
  }
}
