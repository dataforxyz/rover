#!/usr/bin/env bash
# health_check.sh — Verify required services are running before merge.
#
# Config:
#   STEP_HEALTH_CHECK=./scripts/health_check.sh
#
# Exit codes:
#   0 — All services healthy
#   1 — Service unavailable (pipeline stops, goes to approval queue)
#
# Environment (set by pipeline):
#   ROVER_TASK_ID, ROVER_TASK_BRANCH, ROVER_TASK_TITLE,
#   ROVER_TASK_DIR, ROVER_WORKTREE

set -euo pipefail

echo "=== Health check ==="

FAILED=false

# ── Check: Docker running ─────────────────────────────────────
check_docker() {
    echo -n "  Docker: "
    if docker info &>/dev/null; then
        echo "OK"
    else
        echo "FAIL (docker daemon not running)"
        FAILED=true
    fi
}

# ── Check: Database reachable ─────────────────────────────────
# Adapt host/port to your project.
check_service() {
    local name="$1"
    local host="$2"
    local port="$3"

    echo -n "  $name ($host:$port): "
    if timeout 5 bash -c "echo > /dev/tcp/$host/$port" 2>/dev/null; then
        echo "OK"
    else
        echo "FAIL (not reachable)"
        FAILED=true
    fi
}

# ── Check: HTTP endpoint ──────────────────────────────────────
check_http() {
    local name="$1"
    local url="$2"

    echo -n "  $name: "
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo "000")
    if [[ "$STATUS" == "200" ]]; then
        echo "OK"
    else
        echo "FAIL (HTTP $STATUS)"
        FAILED=true
    fi
}

# ── Run checks ────────────────────────────────────────────────
# Uncomment and adapt the checks your project needs:

# check_docker
# check_service "PostgreSQL" "localhost" "5432"
# check_service "Redis" "localhost" "6379"
# check_service "OpenSearch" "localhost" "9200"
# check_http "API" "http://localhost:8080/health"

# Default: just verify git is reachable
echo -n "  Git remote: "
if git ls-remote origin &>/dev/null; then
    echo "OK"
else
    echo "FAIL"
    FAILED=true
fi

echo ""

if [[ "$FAILED" == "true" ]]; then
    echo "Health check FAILED — fix services before retrying"
    exit 1
fi

echo "All checks passed"
