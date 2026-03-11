#!/usr/bin/env bash
# pr_ready.sh — Pre-merge checks: commit staged work, run linters, auto-fix.
#
# Config:
#   STEP_PR_READY=./scripts/pr_ready.sh {worktree}
#
# Exit codes:
#   0 — Passed (or sent back via "Sending back to rover" in stdout)
#   1 — Fatal failure (needs human intervention)
#
# Output patterns:
#   "Sending back to rover" — triggers ITERATE (send task back for rework)
#   "Pre-checks passed"    — signals success to the pipeline
#
# State files (written to $ROVER_STATE_DIR or /tmp/rover-logs/):
#   pr_ready_state_{task_id}          — ORIGINAL_COMMIT, FIX_APPLIED, FIX_COMMIT
#   pr_ready_autofix_diff_{task_id}   — diff of auto-fix changes
#
# Environment (set by pipeline):
#   ROVER_TASK_ID, ROVER_TASK_BRANCH, ROVER_TASK_TITLE,
#   ROVER_TASK_DIR, ROVER_WORKTREE

set -euo pipefail

WORKTREE="${1:-$ROVER_WORKTREE}"
STATE_DIR="${ROVER_STATE_DIR:-/tmp/rover-logs}"
mkdir -p "$STATE_DIR"

echo "=========================================="
echo "PR Ready — Pre-merge checks"
echo "=========================================="
echo "Task ID:  $ROVER_TASK_ID"
echo "Branch:   $ROVER_TASK_BRANCH"
echo "Worktree: $WORKTREE"
echo ""

# ── 1. Commit any staged/unstaged work ───────────────────────
echo "[1/3] Committing work..."
git -C "$WORKTREE" add -A
if git -C "$WORKTREE" diff --cached --quiet; then
    echo "  No changes to commit (already committed)"
else
    git -C "$WORKTREE" commit -m "$ROVER_TASK_TITLE

Co-Authored-By: rover <noreply@anthropic.com>"
    echo "  Commit created"
fi

ORIGINAL_COMMIT=$(git -C "$WORKTREE" rev-parse HEAD)
echo "  Original commit: $ORIGINAL_COMMIT"
echo ""

# ── 2. Lint / code quality checks ────────────────────────────
# Adapt this section to your project's linting tools.
# Non-fixable issues should send back to rover for retry.
echo "[2/3] Running code quality checks..."

# Example: ruff (Python linter)
# Replace with your project's linter(s).
LINT_OUTPUT=""
LINT_PASSED=true

if command -v eslint &>/dev/null; then
    LINT_OUTPUT=$(eslint "$WORKTREE" 2>&1) || LINT_PASSED=false
fi

if [[ "$LINT_PASSED" == "false" ]]; then
    echo "Code quality issues found:"
    echo "$LINT_OUTPUT"
    echo ""

    # Detect unchanged code between iterations
    PREV_HASH_FILE="$STATE_DIR/rover-${ROVER_TASK_ID}-prev-diff-hash"
    CURRENT_HASH=$(git -C "$WORKTREE" diff origin/${ROVER_DEFAULT_BRANCH:-master}...HEAD 2>/dev/null | md5sum | cut -d' ' -f1)
    UNCHANGED_WARNING=""
    if [[ -f "$PREV_HASH_FILE" ]] && [[ "$(cat "$PREV_HASH_FILE")" == "$CURRENT_HASH" ]]; then
        UNCHANGED_WARNING="WARNING: Your code is IDENTICAL to the previous iteration. You MUST make actual changes.

"
    fi
    echo "$CURRENT_HASH" > "$PREV_HASH_FILE"

    # Extract actionable error lines
    FAILED_CHECKS=$(echo "$LINT_OUTPUT" | grep -E '(error|E[0-9]{3,4})' | head -30)
    [[ -z "$FAILED_CHECKS" ]] && FAILED_CHECKS=$(echo "$LINT_OUTPUT" | head -40)

    echo "Sending back to rover for retry..."
    echo "${UNCHANGED_WARNING}Fix these code quality issues:

$FAILED_CHECKS"
    exit 0  # The pipeline reads "Sending back to rover" from stdout
fi

echo "  Lint checks passed"
echo ""

# ── 3. Auto-fix (formatting) ─────────────────────────────────
# Run auto-fixers that can correct issues without human input.
echo "[3/3] Running auto-fix..."

# Example: ruff format + isort
if command -v prettier &>/dev/null; then
    prettier --write "$WORKTREE" 2>/dev/null || true
fi

FIX_APPLIED=false
AUTOFIX_DIFF=""
if ! git -C "$WORKTREE" diff --quiet; then
    FIX_APPLIED=true
    AUTOFIX_DIFF=$(git -C "$WORKTREE" diff)
    echo "  Auto-fix changes:"
    git -C "$WORKTREE" diff --stat
    git -C "$WORKTREE" add -A
    git -C "$WORKTREE" commit -m "auto-fix: formatting"
    echo "  Auto-fix committed"
else
    echo "  No auto-fix changes needed"
fi

FIX_COMMIT=$(git -C "$WORKTREE" rev-parse HEAD)
echo ""

# ── Export state for downstream steps ─────────────────────────
STATE_FILE="$STATE_DIR/pr_ready_state_${ROVER_TASK_ID}"
cat > "$STATE_FILE" << EOF
ORIGINAL_COMMIT=$ORIGINAL_COMMIT
FIX_APPLIED=$FIX_APPLIED
FIX_COMMIT=$FIX_COMMIT
EOF

if [[ "$FIX_APPLIED" == "true" ]]; then
    echo "$AUTOFIX_DIFF" > "$STATE_DIR/pr_ready_autofix_diff_${ROVER_TASK_ID}"
fi

echo "=========================================="
echo "Pre-checks passed — ready for testing!"
echo "=========================================="
