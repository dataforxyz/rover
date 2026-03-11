#!/usr/bin/env bash
# ship.sh — Push branch, create PR/MR, squash-merge, cleanup.
#
# Config:
#   STEP_SHIP=./scripts/ship.sh {worktree}
#
# Exit codes:
#   0 — Shipped (merged to the default branch)
#   1 — Fatal failure (pipeline stops, goes to approval queue)
#   2 — Merge conflict (triggers retry from rebase step)
#
# Environment (set by pipeline):
#   ROVER_TASK_ID, ROVER_TASK_BRANCH, ROVER_TASK_TITLE,
#   ROVER_TASK_DIR, ROVER_WORKTREE, ROVER_DEFAULT_BRANCH

set -euo pipefail

WORKTREE="${1:-$ROVER_WORKTREE}"
PROJECT_DIR="$ROVER_TASK_DIR"

cd "$PROJECT_DIR"

echo "=== Shipping task $ROVER_TASK_ID: $ROVER_TASK_TITLE ==="

detect_forge() {
    if [[ "${GIT_FORGE:-}" == "gh" || "${GIT_FORGE:-}" == "glab" ]]; then
        echo "$GIT_FORGE"
        return
    fi

    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
    if [[ "$remote_url" == *gitlab* ]]; then
        echo "glab"
    else
        echo "gh"
    fi
}

FORGE=$(detect_forge)

gitlab_wait_for_mergeability() {
    local review_id="$1"
    local timeout_seconds="${2:-30}"
    local interval_seconds=2
    local elapsed=0

    echo "  Waiting for GitLab to calculate mergeability..."
    while (( elapsed < timeout_seconds )); do
        local mr_json review_state review_conflicts detailed_status merge_status
        mr_json=$(glab mr view "$review_id" -F json 2>/dev/null || true)

        if [[ -z "$mr_json" ]]; then
            sleep "$interval_seconds"
            elapsed=$((elapsed + interval_seconds))
            continue
        fi

        review_state=$(echo "$mr_json" | jq -r '.state // "unknown"')
        review_conflicts=$(echo "$mr_json" | jq -r '.has_conflicts // false')
        detailed_status=$(echo "$mr_json" | jq -r '.detailed_merge_status // empty')
        merge_status=$(echo "$mr_json" | jq -r '.merge_status // empty')

        if [[ "$review_state" == "merged" ]]; then
            return 0
        fi

        if [[ "$review_conflicts" == "true" ]]; then
            return 2
        fi

        case "$detailed_status" in
            ""|checking|unchecked|preparing|approvals_syncing)
                sleep "$interval_seconds"
                elapsed=$((elapsed + interval_seconds))
                ;;
            *)
                echo "  GitLab merge status: ${detailed_status}${merge_status:+ ($merge_status)}"
                return 0
                ;;
        esac
    done

    echo "  Mergeability still pending after ${timeout_seconds}s; continuing"
    return 0
}

gitlab_merge_with_retry() {
    local review_id="$1"
    shift

    local attempt output status
    for attempt in 1 2 3; do
        set +e
        output=$(glab mr merge "$review_id" "$@" 2>&1)
        status=$?
        set -e

        if [[ $status -eq 0 ]]; then
            [[ -n "$output" ]] && echo "$output"
            return 0
        fi

        echo "$output" >&2

        if [[ "$output" == *"Branch cannot be merged"* ]] && (( attempt < 3 )); then
            echo "  GitLab mergeability is still settling; retrying..."
            gitlab_wait_for_mergeability "$review_id" 20 || true
            sleep 3
            continue
        fi

        return "$status"
    done
}

# ── 1. Get metadata ──────────────────────────────────────────
INSPECT=$(rover inspect "$ROVER_TASK_ID" --json 2>/dev/null) || {
    echo "ERROR: Failed to inspect task $ROVER_TASK_ID"
    exit 1
}
SOURCE_BRANCH="${ROVER_DEFAULT_BRANCH:-$(echo "$INSPECT" | jq -r '.sourceBranch // "main"')}"
ISSUE_NUM=$(echo "$INSPECT" | jq -r '
    .source as $source
    | if ($source | type) != "object" then
        ""
      else
        (
            $source.id
            // $source.ref.number
            // (try ($source.url | capture("/(?:-/)?issues/(?<num>[0-9]+)$").num) catch empty)
            // (try ($source.title | capture("#(?<num>[0-9]+)").num) catch empty)
            // empty
        )
      end
')

echo "  Forge: $FORGE"
echo "  Source branch: $SOURCE_BRANCH"
echo "  Worktree: $WORKTREE"
echo "  Linked issue: ${ISSUE_NUM:-none}"

# ── 2. Push commits ──────────────────────────────────────────
echo "Pushing commits..."
rover push "$ROVER_TASK_ID" -m "Task $ROVER_TASK_ID: $ROVER_TASK_TITLE" || true

# Verify remote branch exists — rover push sometimes reports
# "no changes" without actually pushing
if ! git ls-remote --heads origin "$ROVER_TASK_BRANCH" | grep -q "$ROVER_TASK_BRANCH"; then
    echo "  Remote branch not found, pushing directly..."
    git -C "$WORKTREE" push -u origin "$ROVER_TASK_BRANCH"
fi

# ── 3. Create or find PR/MR ──────────────────────────────────
echo "Checking for existing review request..."
REVIEW_ID=""

if [[ "$FORGE" == "glab" ]]; then
    REVIEW_ID=$(glab mr list --source-branch "$ROVER_TASK_BRANCH" -F json 2>/dev/null | jq -r '.[0].iid // empty' || echo "")
else
    REVIEW_ID=$(gh pr list --head "$ROVER_TASK_BRANCH" --json number -q '.[0].number' 2>/dev/null || echo "")
fi

if [[ -n "$REVIEW_ID" ]]; then
    if [[ "$FORGE" == "glab" ]]; then
        echo "  MR !$REVIEW_ID already exists"
    else
        echo "  PR #$REVIEW_ID already exists"
    fi
else
    REVIEW_BODY="Generated by Rover Task $ROVER_TASK_ID"
    if [[ -n "$ISSUE_NUM" ]]; then
        REVIEW_BODY="Closes #$ISSUE_NUM

$REVIEW_BODY"
    fi

    if [[ "$FORGE" == "glab" ]]; then
        glab mr create \
            --source-branch "$ROVER_TASK_BRANCH" \
            --target-branch "$SOURCE_BRANCH" \
            --title "Task $ROVER_TASK_ID: $ROVER_TASK_TITLE" \
            --description "$REVIEW_BODY" \
            --remove-source-branch \
            --yes

        REVIEW_ID=$(glab mr list --source-branch "$ROVER_TASK_BRANCH" -F json 2>/dev/null | jq -r '.[0].iid // empty')
        echo "  Created MR !$REVIEW_ID"
    else
        gh pr create \
            --head "$ROVER_TASK_BRANCH" \
            --base "$SOURCE_BRANCH" \
            --title "Task $ROVER_TASK_ID: $ROVER_TASK_TITLE" \
            --body "$REVIEW_BODY"

        REVIEW_ID=$(gh pr view "$ROVER_TASK_BRANCH" --json number -q '.number')
        echo "  Created PR #$REVIEW_ID"
    fi
fi

# ── 4. Squash-merge ──────────────────────────────────────────
if [[ "$FORGE" == "glab" ]]; then
    echo "Merging MR !$REVIEW_ID..."
    WAIT_STATUS=0
    gitlab_wait_for_mergeability "$REVIEW_ID" || WAIT_STATUS=$?
    if [[ "$WAIT_STATUS" == "2" ]]; then
        echo "ERROR: Merge conflict — needs rebase"
        exit 2
    fi

    if ! gitlab_merge_with_retry "$REVIEW_ID" --squash --remove-source-branch --auto-merge --yes; then
        echo "  Auto-merge failed, trying immediate merge..."
        if ! gitlab_merge_with_retry "$REVIEW_ID" --squash --remove-source-branch --yes; then
            REVIEW_STATE=$(glab mr view "$REVIEW_ID" -F json 2>/dev/null | jq -r '.state // "unknown"' || echo "unknown")
            if [[ "$REVIEW_STATE" == "merged" ]]; then
                echo "  MR merged (ignoring post-merge error)"
            else
                REVIEW_CONFLICTS=$(glab mr view "$REVIEW_ID" -F json 2>/dev/null | jq -r '.has_conflicts // false' || echo "false")
                if [[ "$REVIEW_CONFLICTS" == "true" ]]; then
                    echo "ERROR: Merge conflict — needs rebase"
                    exit 2
                else
                    echo "ERROR: Merge failed (state=$REVIEW_STATE)"
                    exit 1
                fi
            fi
        fi
    fi
    echo "  MR !$REVIEW_ID merged"
else
    echo "Merging PR #$REVIEW_ID..."
    if ! gh pr merge "$REVIEW_ID" --squash; then
        # gh sometimes errors after a successful merge (branch deletion race)
        REVIEW_STATE=$(gh pr view "$REVIEW_ID" --json state -q '.state' 2>/dev/null || echo "UNKNOWN")
        if [[ "$REVIEW_STATE" == "MERGED" ]]; then
            echo "  PR merged (ignoring post-merge error)"
        else
            REVIEW_MERGEABLE=$(gh pr view "$REVIEW_ID" --json mergeable -q '.mergeable' 2>/dev/null || echo "UNKNOWN")
            if [[ "$REVIEW_MERGEABLE" == "CONFLICTING" ]]; then
                echo "ERROR: Merge conflict — needs rebase"
                exit 2  # Special: triggers rebase retry
            else
                echo "ERROR: Merge failed (state=$REVIEW_STATE, mergeable=$REVIEW_MERGEABLE)"
                exit 1
            fi
        fi
    fi
    echo "  PR #$REVIEW_ID merged"
fi

# ── 5. Close linked issue (safety net) ───────────────────────
if [[ -n "$ISSUE_NUM" ]]; then
    echo "Closing linked issue #$ISSUE_NUM..."
    if [[ "$FORGE" == "glab" ]]; then
        glab issue close "$ISSUE_NUM"
    else
        gh issue close "$ISSUE_NUM" --comment "Fixed via PR #$REVIEW_ID"
    fi
fi

# ── 6. Cleanup worktree + branch ─────────────────────────────
echo "Cleaning up..."
rover del -y "$ROVER_TASK_ID"

# ── 7. Sync local repo (best effort) ─────────────────────────
echo "Syncing local repository..."
git fetch origin
git checkout "$SOURCE_BRANCH" 2>/dev/null || true
git pull origin "$SOURCE_BRANCH" 2>/dev/null || true

echo ""
echo "=== Successfully shipped task $ROVER_TASK_ID ==="
