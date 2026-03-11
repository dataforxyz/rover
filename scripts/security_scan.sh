#!/usr/bin/env bash
# security_scan.sh — Security checks before merge (runs after AI rebase).
#
# Config:
#   STEP_SECURITY_SCAN=./scripts/security_scan.sh {worktree}
#
# Only runs when the rebase step resolved conflicts with AI assistance.
# Catches prompt-injection or malicious changes introduced during rebase.
#
# Exit codes:
#   0 — Passed
#   1 — Security issue found
#
# Environment (set by pipeline):
#   ROVER_TASK_ID, ROVER_TASK_BRANCH, ROVER_TASK_TITLE,
#   ROVER_TASK_DIR, ROVER_WORKTREE

set -euo pipefail

WORKTREE="${1:-$ROVER_WORKTREE}"

cd "$WORKTREE"

echo "=== Security scan for task $ROVER_TASK_ID ==="
FAILED=false

# ── Check for dangerous patterns ─────────────────────────────
echo "Checking for dangerous patterns..."

# Pipe-to-shell
if grep -rnE 'curl\s+.*\|\s*(ba)?sh' --include='*.sh' --include='*.py' . 2>/dev/null; then
    echo "FAIL: curl piped to shell detected"
    FAILED=true
fi

# Hardcoded secrets (common patterns)
SECRETS_FOUND=$(grep -rnEi \
    '(password|api_key|secret_key|access_token)\s*=\s*"[^"]{8,}"' \
    --include='*.py' --include='*.env' . 2>/dev/null \
    | grep -vE '(#|os\.environ|os\.getenv|""|\.\.\.|placeholder|changeme|your.key)' \
    || true)

if [[ -n "$SECRETS_FOUND" ]]; then
    echo "FAIL: Possible hardcoded secrets:"
    echo "$SECRETS_FOUND"
    FAILED=true
fi

# ── Bandit (if available) ─────────────────────────────────────
if command -v bandit &>/dev/null; then
    echo "Running bandit..."
    # Only medium+ severity, quiet mode
    if ! bandit -ll -q -r . --exclude ./tests 2>/dev/null; then
        echo "FAIL: Bandit found security issues"
        FAILED=true
    else
        echo "  Bandit: OK"
    fi
else
    echo "  Bandit: skipped (not installed)"
fi

echo ""
if [[ "$FAILED" == "true" ]]; then
    echo "Security scan FAILED"
    exit 1
fi

echo "Security scan passed"
