#!/usr/bin/env bash
# select_tests.sh — Pick which tests to run based on changed files.
#
# Config:
#   STEP_TEST_SELECT=./scripts/select_tests.sh {worktree}
#
# stdout: space-separated test file paths (consumed by STEP_TEST)
# If empty, the pipeline uses TEST_FALLBACK.
#
# Environment (set by pipeline):
#   ROVER_TASK_ID, ROVER_TASK_BRANCH, ROVER_TASK_TITLE,
#   ROVER_TASK_DIR, ROVER_WORKTREE

set -euo pipefail

WORKTREE="${1:-$ROVER_WORKTREE}"

cd "$WORKTREE"

# ── Get files changed by this task ────────────────────────────
CHANGED=$(git diff --name-only origin/${ROVER_DEFAULT_BRANCH:-master}...HEAD 2>/dev/null || true)

if [[ -z "$CHANGED" ]]; then
    # No changes detected — return empty (pipeline will use TEST_FALLBACK)
    exit 0
fi

TESTS=""

# ── Strategy 1: Direct test file mapping ──────────────────────
# If src/foo/bar.py changed, check if tests/test_bar.py exists.
for file in $CHANGED; do
    # Skip non-source files
    [[ "$file" != *.ts ]] && [[ "$file" != *.js ]] && continue
    [[ "$file" == test/* ]] || [[ "$file" == *.test.* ]] && continue

    # Extract filename and look for matching test
    basename=$(basename "$file" | sed "s/\.[^.]*$//"  )
    for test_file in $(find test/ -name "${basename}.test.*" 2>/dev/null); do
        TESTS="$TESTS $test_file"
    done
done

# ── Strategy 2: Changed test files ────────────────────────────
# If a test file itself changed, include it directly.
for file in $CHANGED; do
    if [[ "$file" == test/*.ts ]] || [[ "$file" == test/*.js ]] && [[ -f "$file" ]]; then
        TESTS="$TESTS $file"
    fi
done

# Deduplicate and output
echo "$TESTS" | tr ' ' '\n' | sort -u | tr '\n' ' '
