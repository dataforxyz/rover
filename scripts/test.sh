#!/usr/bin/env bash
# test.sh — Run tests with baseline comparison.
#
# Config:
#   STEP_TEST=./scripts/test.sh {worktree}
#
# Selected test files (from STEP_TEST_SELECT) are appended as extra args.
#
# Exit codes:
#   0 — All tests passed
#   1 — Test failures
#
# Output patterns the pipeline parses:
#   "BASELINE_CRASH"  — Infrastructure error (not a test failure)
#   "New failures:"   — Section header followed by failure details
#
# Environment (set by pipeline):
#   ROVER_TASK_ID, ROVER_TASK_BRANCH, ROVER_TASK_TITLE,
#   ROVER_TASK_DIR, ROVER_WORKTREE

set -euo pipefail

WORKTREE="${1:-$ROVER_WORKTREE}"
shift || true  # Remaining args are selected test files

cd "$WORKTREE"

echo "=== Running tests for task $ROVER_TASK_ID ==="

# ── Build test command ────────────────────────────────────────
# Adapt to your project's test runner.
# Selected test files are passed as extra arguments.
TEST_ARGS=("$@")

if [[ ${#TEST_ARGS[@]} -eq 0 ]]; then
    # No specific tests selected — run the full suite
    TEST_ARGS=("test/")
fi

echo "  Test targets: ${TEST_ARGS[*]}"
echo ""

# ── Run tests ─────────────────────────────────────────────────
# Capture output for pattern matching by the pipeline.
set +e
OUTPUT=$(npm test -- "${TEST_ARGS[@]}" 2>&1)
EXIT_CODE=$?
set -e

echo "$OUTPUT"

# ── Handle infrastructure crashes ─────────────────────────────
# If pytest itself crashes and produces no test results, signal infra error.
# But compilation/import errors with file:line references are code bugs, not infra.
if [[ $EXIT_CODE -ne 0 ]] && ! grep -qE '(passing|failing|Tests:)' <<< "$OUTPUT"; then
    if grep -qE '(SyntaxError|ImportError|ModuleNotFoundError|\.py:[0-9]+)' <<< "$OUTPUT"; then
        echo ""
        echo "New failures:"
        echo "--- FAIL: Build/Import"
        echo "$OUTPUT" | grep -E '(Error|\.py:[0-9]+)' | tail -20 || true
        exit 1
    fi
    echo ""
    echo "BASELINE_CRASH: Test infrastructure failed (no test results)"
    exit 1
fi

# ── Format failure output ─────────────────────────────────────
# The pipeline's TestStep parses "New failures:" sections.
if [[ $EXIT_CODE -ne 0 ]]; then
    # Extract FAILED lines from pytest short summary
    FAILURES=$(echo "$OUTPUT" | grep -E '(failing|FAIL)' || true)
    if [[ -n "$FAILURES" ]]; then
        echo ""
        echo "New failures:"
        echo "$FAILURES"
    fi
fi

exit $EXIT_CODE
