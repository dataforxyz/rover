#!/usr/bin/env bash
# code_review.sh — AI-powered code review via Claude.
#
# Config:
#   STEP_CODE_REVIEW=./scripts/code_review.sh {worktree} {branch}
#
# Exit codes:
#   0 — Approved
#   1 — Rejected (stdout should be JSON: {"comments": "feedback"})
#
# Environment (set by pipeline):
#   ROVER_TASK_ID, ROVER_TASK_BRANCH, ROVER_TASK_TITLE,
#   ROVER_TASK_DIR, ROVER_WORKTREE

set -euo pipefail

WORKTREE="${1:-$ROVER_WORKTREE}"
BRANCH="${2:-$ROVER_TASK_BRANCH}"

cd "$WORKTREE"

echo "=== Code review for task $ROVER_TASK_ID ===" >&2

# ── Get the diff ──────────────────────────────────────────────
DIFF=$(git diff origin/${ROVER_DEFAULT_BRANCH:-master}...HEAD 2>/dev/null || true)

if [[ -z "$DIFF" ]]; then
    echo "No changes to review" >&2
    exit 0  # Approved (nothing to reject)
fi

# Truncate large diffs to avoid token limits
MAX_CHARS="${MAX_DIFF_CHARS:-8000}"
if [[ ${#DIFF} -gt $MAX_CHARS ]]; then
    DIFF="${DIFF:0:$MAX_CHARS}

... (diff truncated at $MAX_CHARS chars)"
fi

# ── Review prompt ─────────────────────────────────────────────
# Soften review criteria in the last 2 iterations to avoid infinite rejection loops
ITERATION="${ROVER_TASK_ITERATION:-0}"
MAX_ITER="${ROVER_MAX_ITERATIONS:-6}"
SOFT_WINDOW="${ROVER_REVIEW_SOFT_WINDOW:-2}"
REMAINING=$((MAX_ITER - ITERATION))

if [[ $REMAINING -le $SOFT_WINDOW && $ITERATION -gt 0 ]]; then
    echo "  Using lenient review (iteration $ITERATION/$MAX_ITER)" >&2
    REVIEW_CRITERIA="Review this diff for:
1. Bugs or logic errors that would cause runtime failures
2. Security vulnerabilities (injection, hardcoded secrets, unsafe operations)
3. Breaking changes to existing public APIs or behavior

IMPORTANT: This task has been through $ITERATION iterations. Only reject for actual bugs,
security issues, or breaking changes. Do NOT reject for style nits, naming preferences,
minor improvements, or suggestions that are 'nice to have'. Approve code that is correct
and functional, even if it could theoretically be improved."
else
    REVIEW_CRITERIA="Review this diff for:
1. Bugs or logic errors that would cause runtime failures or incorrect behavior
2. Security vulnerabilities (injection, hardcoded secrets, unsafe operations)
3. Breaking changes to existing public APIs or behavior

Approve code that is correct and functional. Only reject for actual bugs, security issues,
or breaking changes. Do NOT reject for style preferences, naming conventions, minor
improvements, missing comments, or suggestions that are 'nice to have'.
The code does not need to be perfect — it needs to be correct and safe."
fi

PROMPT="You are reviewing a pull request. The task was: $ROVER_TASK_TITLE

$REVIEW_CRITERIA

Respond in JSON (no markdown fences, no extra text):
- If approved: {\"verdict\": \"approve\", \"comments\": \"brief summary\"}
- If rejected: {\"verdict\": \"reject\", \"comments\": \"what needs fixing\"}

Diff:
\`\`\`
$DIFF
\`\`\`"

# ── Run AI review ─────────────────────────────────────────────
echo "Running AI review..." >&2
if [[ "${AI_PROVIDER:-claude}" == "codex" ]]; then
    REVIEW=$(codex --model gpt5.3 -p "$PROMPT" 2>/dev/null || echo '{"verdict": "approve", "comments": "review unavailable"}')
else
    REVIEW=$(claude -p "$PROMPT" 2>/dev/null || echo '{"verdict": "approve", "comments": "review unavailable"}')
fi

# Claude sometimes wraps JSON in markdown fences; strip them before parsing.
PARSEABLE_REVIEW=$(printf '%s\n' "$REVIEW" | awk '
    /^[[:space:]]*```/ { next }
    { print }
')

# ── Parse verdict ─────────────────────────────────────────────
VERDICT=$(echo "$PARSEABLE_REVIEW" | jq -r '.verdict // "approve"' 2>/dev/null || echo "approve")
COMMENTS=$(echo "$PARSEABLE_REVIEW" | jq -r '.comments // ""' 2>/dev/null || echo "")

echo "  Verdict: $VERDICT" >&2
echo "  Comments: $COMMENTS" >&2

if [[ "$VERDICT" == "reject" ]]; then
    # Output JSON to stdout for the pipeline to parse
    echo "{\"comments\": $(echo "$COMMENTS" | jq -Rs .)}"
    exit 1
fi

exit 0
