# Rover Pipeline

Automated code delivery system. GitHub/GitLab issues go in, shipped code comes out.

## How It Works

1. Issues labeled `rover` are picked up by intake
2. `rover` CLI creates a task: spawns an AI agent in a git worktree to write code
3. Pipeline runs the completed task through: rebase → test → code review → ship
4. Failed tasks go to an approval queue for human review
5. Shipped tasks merge to the default branch (usually `rover-landing`)

## System Layout

- `/opt/rover-pipeline/` — pipeline framework (Python)
- `/opt/rover/` — rover CLI (task execution engine)
- `/home/rover/projects/<name>/` — project repos
- `/home/rover/.rover-pipeline.env` — forge tokens and agent image config

## Services

```bash
systemctl status rover-pipeline-backend
systemctl status rover-pipeline-frontend
systemctl status rover-pipeline-web

sudo systemctl start rover-pipeline-backend
journalctl -u rover-pipeline-backend -f
```

Web dashboard runs on port 8080 (access via IAP tunnel).

## Project Config (rover-pipeline.env)

```bash
DEFAULT_BRANCH=rover-landing
ROVER_MAX_WORKERS=3
ROVER_MAX_ITERATIONS=6
INTAKE_MAX_RUNNING=5
STEP_TEST=./scripts/test.sh {worktree}
STEP_SHIP=./scripts/ship.sh {worktree}
```

Each project also has `scripts/ship.sh`, `scripts/test.sh`, `scripts/code_review.sh`.

## Branching Strategy

- `rover-landing` — agents merge work here
- `main` / `dev-v2` — human-managed branches
- `nightly` — CI merges both, tags green builds
- Promotions happen from tags, not branch tips

## Agent Guidelines

- **One task, one issue.** Focus only on the issue assigned to you.
- **Don't modify pipeline config.** Don't touch `rover-pipeline.env`, `scripts/ship.sh`, or `.rover/`.
- **Write tests when appropriate.** The pipeline runs tests — broken tests mean iteration.
- **Keep changes minimal.** Only change what's needed. Don't refactor surrounding code.
- **Respect the branch.** Don't merge, rebase, or switch branches — the pipeline handles that.
- `hooks/data/` contains pipeline state (queues, locks, logs) — don't modify.

## Common Tasks

```bash
rover status                    # view active tasks
rover cleanup -a                # clean up old tasks
python3.13 -m rover_pipeline approve /home/rover/projects/backend  # approval TUI
```

## AI Auth

Claude and Codex must be authenticated before starting services:

```bash
claude    # browser auth flow
codex     # browser auth flow
```
