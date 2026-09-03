#!/usr/bin/env bash
#
# Container entrypoint for one @claude run, outside GitLab CI.
#
# This is the `script:` block from .gitlab-ci.yml's claude_webhook_handler job,
# with two differences:
#
#   - it clones the repository itself, because GitLab's `GIT_STRATEGY: clone`
#     used to do that before the script ran;
#   - it does no Control Room reporting. The start ping, the live event stream
#     and the final metrics all moved to the daemon (src/control-room.ts),
#     because they must still happen when this container is killed on timeout —
#     which is exactly what `after_script` was chosen for and what a killed
#     container cannot do for itself.
#
# It is bind-mounted in at /opt/run.sh rather than baked into the image, so
# changing it does not mean rebuilding the runner.
#
# Everything else — prepare.ts, base-action, update-comment-gitlab.ts — is the
# same code the pipeline ran, reading the same environment variables.

set -uo pipefail

# --- Values that cannot survive a docker --env-file -------------------------
# An env file is strictly one KEY=value per line with no quoting, so a comment
# body containing a newline would truncate it. Those two arrive base64-encoded.
if [ -n "${CLAUDE_NOTE_B64:-}" ]; then
  CLAUDE_NOTE="$(printf '%s' "$CLAUDE_NOTE_B64" | base64 -d)"
  export CLAUDE_NOTE
fi
if [ -n "${DIRECT_PROMPT_B64:-}" ]; then
  DIRECT_PROMPT="$(printf '%s' "$DIRECT_PROMPT_B64" | base64 -d)"
  export DIRECT_PROMPT
fi

echo "========================================="
echo "Claude run ${CI_JOB_ID}"
echo "Project:  ${CLAUDE_PROJECT_PATH}"
echo "Resource: ${CLAUDE_RESOURCE_TYPE} #${CLAUDE_RESOURCE_ID}"
echo "Branch:   ${CLAUDE_BRANCH}"
echo "Author:   ${CLAUDE_AUTHOR}"
echo "========================================="

GL_TOKEN="${CLAUDE_CODE_GL_ACCESS_TOKEN:-${GITLAB_TOKEN:-}}"
if [ -z "$GL_TOKEN" ]; then
  echo "FATAL: no GitLab token (CLAUDE_CODE_GL_ACCESS_TOKEN or GITLAB_TOKEN)." >&2
  exit 2
fi
REMOTE="https://oauth2:${GL_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"

# --- Git identity and credentials (was the job's before_script) -------------
git config --global user.name "${GITLAB_USER_NAME:-Claude Bot}"
git config --global user.email "${GITLAB_USER_EMAIL:-claude-bot@${CI_SERVER_HOST}}"
git config --global credential.helper store
git config --global --add safe.directory '*'
printf 'https://oauth2:%s@%s\n' "$GL_TOKEN" "$CI_SERVER_HOST" > ~/.git-credentials
chmod 600 ~/.git-credentials

# --- Clone (GitLab's GIT_STRATEGY: clone) ----------------------------------
echo "Cloning ${CI_PROJECT_PATH} at ${CLAUDE_BRANCH}…"
rm -rf "$CI_PROJECT_DIR"
if ! git clone --branch "$CLAUDE_BRANCH" "$REMOTE" "$CI_PROJECT_DIR" 2>&1 | sed 's/oauth2:[^@]*@/oauth2:***@/g'; then
  echo "FATAL: clone failed." >&2
  exit 2
fi
cd "$CI_PROJECT_DIR" || exit 2

# prepare.ts calls setupGitAuth(), which runs `git remote set-url` in whatever
# directory it happens to be in — /opt/claude-code, not here. Setting the real
# remote now is what makes the push at the end work; the job's before_script
# did the same thing for the same reason.
git remote set-url origin "$REMOTE"
CI_COMMIT_SHA="$(git rev-parse HEAD)"
export CI_COMMIT_SHA
echo "HEAD is $CI_COMMIT_SHA"

# Advisory Docker check, if the project ships one (JOUR-16): a skipped
# Testcontainers suite must look different from a passing one.
if [ -x ./scripts/require-docker.sh ]; then
  ./scripts/require-docker.sh --warn || true
fi

# --- Step 1: prepare -------------------------------------------------------
echo "========================================="
echo "Step 1: Preparing Claude Code action..."
echo "========================================="
cd /opt/claude-code || exit 2
if ! bun run src/entrypoints/prepare.ts; then
  echo "Prepare step failed, exiting..." >&2
  exit 1
fi

# --- Step 2: run Claude ----------------------------------------------------
echo "========================================="
echo "Step 2: Running Claude Code..."
echo "========================================="
cd "$CI_PROJECT_DIR" || exit 2
CLAUDE_EXIT_CODE=0
bun run /opt/claude-code/base-action/src/index.ts || CLAUDE_EXIT_CODE=$?
cd /opt/claude-code || exit 2
echo "Claude exited with ${CLAUDE_EXIT_CODE}"

# --- Step 3: update the issue/MR comment with the result -------------------
if [ -f /tmp/claude-comment-id.txt ]; then
  CLAUDE_COMMENT_ID="$(tr -d '[:space:]' < /tmp/claude-comment-id.txt)"
  export CLAUDE_COMMENT_ID
  echo "Loaded comment ID: $CLAUDE_COMMENT_ID"
fi

if [ -n "${CLAUDE_COMMENT_ID:-}" ]; then
  echo "========================================="
  echo "Step 3: Updating comment with results..."
  echo "========================================="
  if [ "$CLAUDE_EXIT_CODE" -eq 0 ]; then export CLAUDE_SUCCESS="true"; else export CLAUDE_SUCCESS="false"; fi
  export PREPARE_SUCCESS="true"
  # Must match base-action's own resolution (RUNNER_TEMP || CI_BUILDS_DIR || /tmp)
  # or the reader and the writer disagree about where the result went.
  export OUTPUT_FILE="${RUNNER_TEMP:-${CI_BUILDS_DIR:-/tmp}}/claude-execution-output.json"

  if [ "$CLAUDE_RESOURCE_TYPE" = "issue" ]; then
    export CI_ISSUE_IID="$CLAUDE_RESOURCE_ID"
  fi

  bun run src/entrypoints/update-comment-gitlab.ts || echo "Failed to update comment"
fi

exit "$CLAUDE_EXIT_CODE"
