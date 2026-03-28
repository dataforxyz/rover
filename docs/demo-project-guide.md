# Demo Project Guide

How to create, build, and run the multi-environment demo that validates the `swe-tdd` workflow across Python, Go, Flutter, and a PostgreSQL sidecar.

## Prerequisites

- Docker (or Podman)
- Rover CLI built and on PATH (`pnpm build && pnpm link --global` from repo root)
- A locally built agent image **or** the published `ghcr.io/endorhq/rover/agent-dev:latest`
- Claude API key configured (`~/.claude/` credentials present)

### Building a local agent image

If you are working from an unreleased branch (e.g. `feat/multi-env-demo-validation`), the published agent image may not contain the latest workflow/runtime changes. Build a local image instead:

```bash
# From the rover repo root
docker build -t rover-agent-local:latest -f packages/agent/Dockerfile .
```

The generated demo pins `sandbox.agentImage` to `rover-agent-local:latest`. To use the published image instead, edit the generated `rover.json` and remove (or change) the `sandbox.agentImage` field.

## Step 1 — Generate the demo workspace

```bash
bash demos/create-multi-env-demo.sh          # default: /tmp/rover-multi-env-demo
bash demos/create-multi-env-demo.sh ~/my-demo # or pick your own path
```

This creates a self-contained workspace with three sub-projects and a database sidecar:

| Component  | Language     | Package Manager | What it does                              |
| ---------- | ------------ | --------------- | ----------------------------------------- |
| `frontend` | Dart/Flutter | `pub`           | Web UI with a "get joke" button           |
| `backend`  | Go           | `gomod`         | HTTP API that stores/retrieves jokes in PG |
| `e2e`      | Python       | `uv`            | Browser tests via `nodriver`/Chromium     |
| `postgres` | —            | —               | PostgreSQL 15 sidecar (managed by Rover)  |

### How the Postgres sidecar works

The `rover.json` declares a service container in `sandbox.services[]`. When Rover starts a task:

1. Rover creates an isolated Docker network for the task
2. Rover starts the `postgres:15-alpine` container on that network
3. Rover waits for `pg_isready` healthcheck to pass
4. The task container joins the same network — Postgres is reachable at `postgres:5432`
5. The Go backend connects via `DATABASE_URL` (default: `postgres://postgres:postgres@postgres:5432/jokes?sslmode=disable`)
6. On task completion, Rover tears down the sidecar and network

Unit tests (`make test`) run **without** Postgres — the backend falls back to an in-memory seed list when `db` is nil.

### Generated layout

```
<workspace>/
├── rover.json              # Multi-project config + Postgres sidecar
├── Makefile                # Root orchestration (setup / test / test-e2e / validate)
├── AGENTS.md / CLAUDE.md   # Agent instructions
├── README.md
├── scripts/
│   └── system-init.sh      # OS-level setup (Chromium, curl, postgresql-client)
└── sources/                # Bare git repos (cloned at task time)
    ├── frontend.git
    ├── backend.git
    └── e2e.git
```

Sub-projects are **not** checked out yet — `make setup` (or Rover at task time) clones them from the bare repos in `sources/`.

## Step 2 — Verify the workspace manually (optional)

Before involving Rover, confirm the demo projects work on their own:

```bash
cd /tmp/rover-multi-env-demo

make setup      # clone sub-repos + install deps
make test       # run frontend + backend unit tests (no DB needed)
make test-e2e   # full browser flow (backend → frontend → Python e2e)
make validate   # all of the above in sequence
```

`make validate` is the single command that proves the entire workspace is healthy.

Note: `make test` works without Postgres (in-memory fallback). `make test-e2e` needs a running Postgres if the backend is configured to use one. Under Rover, the sidecar handles this automatically.

## Step 3 — Build the Rover cache image

```bash
cd /tmp/rover-multi-env-demo
rover build -a claude:haiku
```

This creates a Docker image (`rover-cache:<hash>`) with:

- Go, Dart/Flutter, and Python installed
- All package manager dependencies resolved
- Chromium and postgresql-client installed (via `scripts/system-init.sh`)

The cache hash is derived from languages, package managers, init scripts, repo revisions, and agent image ID. Rebuilds only when inputs change.

To verify the cache was created:

```bash
docker images 'rover-cache:*'
```

### Troubleshooting cache builds

| Symptom | Fix |
| ------- | --- |
| Build fails during Go install | Ensure the agent image has enough disk. Go installs under `/opt/go`. |
| Chromium not found at task time | Confirm `scripts/system-init.sh` installs `chromium` and runs during build. |
| Stale cache after code changes | Delete old images: `docker rmi $(docker images -q 'rover-cache:*')` and rebuild. |
| Per-project init fails during build | Expected — project repos are only cloned at task time, not build time. Per-project init scripts run inside the task container. |
| Postgres sidecar not starting | Check `docker ps` for `rover-svc-*-postgres` containers. Verify the image `postgres:15-alpine` is pullable. |

## Step 4 — Run a demo task with `swe-tdd`

### Simple task (recommended for demos)

Use `-a claude:haiku` for fast, cheap runs:

```bash
cd /tmp/rover-multi-env-demo

rover task -a claude:haiku -w swe-tdd \
  "Add a /api/joke/random endpoint to the backend that returns a single random joke without requiring query parameters. It should read from the database. Add a corresponding unit test."
```

This is a simple, self-contained Go task. The agent will:

1. Analyze the codebase (context step)
2. Plan a TDD approach
3. Write a failing test first
4. Implement the endpoint
5. Loop until tests pass
6. Review and summarize

### Database-focused task

```bash
rover task -a claude:haiku -w swe-tdd \
  "Add a /api/joke POST endpoint that accepts a JSON body with a 'template' field and inserts a new joke into the database. Return 201 on success. Add a unit test."
```

### Cross-project task

```bash
rover task -a claude:haiku -w swe-tdd \
  "Add a 'joke count' display to the frontend that calls /api/joke/count on the backend and shows the total number of jokes stored in the database. Add unit tests for both the frontend widget and the backend endpoint."
```

### Full validation task

Use `test_command` override to run the full workspace validation:

```bash
rover task -a claude:haiku -w swe-tdd \
  --test-command "make validate" \
  "Add input validation to the /api/joke endpoint: return 400 if the 'name' parameter is empty. Add a unit test."
```

### Monitoring a running task

```bash
rover logs <task-id>       # stream logs
rover inspect <task-id>    # show task metadata and status
rover list                 # list all tasks
```

## Step 5 — Iterate, merge, or clean up

```bash
# Refine the task with a follow-up instruction
rover iterate <task-id> "Also add a timestamp field to the /healthz response"

# View the diff
rover diff <task-id>

# Merge the task branch into main
rover merge <task-id>

# Or clean up
rover delete <task-id>
```

## Example task ideas for demos

These are intentionally simple tasks suitable for `claude:haiku`:

### Backend only (Go + Postgres)

- "Add a `/api/joke/random` endpoint that returns a single random joke without requiring query parameters. Add a unit test."
- "Add input validation to the `/api/joke` endpoint: return 400 if the `name` parameter is empty. Add a test."
- "Add a `DELETE /api/joke/:id` endpoint that removes a joke from the database. Add a test."
- "Add a `GET /api/jokes` endpoint that returns all jokes from the database as a JSON array. Add a test."

### Frontend only (Flutter)

- "Add a loading spinner that shows while the joke API request is in flight. Add a widget test."
- "Add a character counter below the name input field. Add a widget test."

### Cross-project (Go + Flutter)

- "Add a `/api/jokes` endpoint to the backend that returns all jokes as a JSON array. Update the frontend to show a 'View All' button that fetches and displays the list. Add tests for both."

### E2E (Python)

- "Update the e2e test to also verify that the joke text is non-empty after fetching."

## Configuration reference

The generated `rover.json`:

```json
{
  "version": "1.5",
  "languages": [],
  "mcps": [],
  "packageManagers": [],
  "taskManagers": ["make"],
  "attribution": true,
  "sandbox": {
    "agentImage": "rover-agent-local:latest",
    "initScript": "scripts/system-init.sh",
    "services": [
      {
        "name": "postgres",
        "image": "postgres:15-alpine",
        "ports": [5432],
        "env": [
          "POSTGRES_USER=postgres",
          "POSTGRES_PASSWORD=postgres",
          "POSTGRES_DB=jokes"
        ],
        "healthcheck": {
          "cmd": "pg_isready -U postgres",
          "interval": 5,
          "timeout": 5,
          "retries": 3,
          "startPeriod": 10
        },
        "readyTimeout": 30
      }
    ]
  },
  "projects": [
    {
      "name": "frontend",
      "path": "frontend",
      "repository": "/workspace/sources/frontend.git",
      "languages": ["dart"],
      "packageManagers": ["pub"],
      "initScript": "scripts/init.sh"
    },
    {
      "name": "backend",
      "path": "backend",
      "repository": "/workspace/sources/backend.git",
      "languages": ["go"],
      "packageManagers": ["gomod"],
      "initScript": "scripts/init.sh"
    },
    {
      "name": "e2e",
      "path": "e2e",
      "repository": "/workspace/sources/e2e.git",
      "languages": ["python"],
      "packageManagers": ["uv"],
      "initScript": "scripts/init.sh"
    }
  ]
}
```

Key fields:

| Field | Purpose |
| ----- | ------- |
| `taskManagers: ["make"]` | Installs `make` in the container |
| `sandbox.agentImage` | Docker image for the agent runtime (remove to use published default) |
| `sandbox.initScript` | Runs during `rover build` — use for OS packages like Chromium |
| `sandbox.services[]` | Sidecar containers started before each task (Postgres in this demo) |
| `sandbox.services[].healthcheck` | Rover polls this before starting the task container |
| `projects[].repository` | Path to bare git repo (resolved inside the container as `/workspace/sources/...`) |
| `projects[].initScript` | Runs at task time after the project repo is cloned (e.g. `flutter pub get`, `go mod download`) |

### Service container fields

| Field | Required | Purpose |
| ----- | -------- | ------- |
| `name` | yes | Hostname on the task network (e.g. `postgres`) |
| `image` | yes | Docker image (e.g. `postgres:15-alpine`) |
| `ports` | no | Informational — all ports are reachable on the task network |
| `env` | no | Environment variables for the container |
| `volumes` | no | Volume mounts (`name:/path` or `/host:/container`) |
| `healthcheck.cmd` | no | Command to check readiness |
| `healthcheck.interval` | no | Seconds between checks (default: 5) |
| `healthcheck.timeout` | no | Timeout per check (default: 5) |
| `healthcheck.retries` | no | Retries before unhealthy (default: 3) |
| `healthcheck.startPeriod` | no | Delay before first check (default: 0) |
| `readyTimeout` | no | Max seconds to wait for healthy (default: 60) |
| `command` | no | Override container command (string or array) |

## Tips

- **Use `claude:haiku` for demos.** It's fast and cheap. Save `claude:sonnet` or `claude:opus` for real work.
- **Keep tasks small and focused.** One endpoint + one test is ideal for a demo.
- **`make validate` is the gold standard.** If it passes, the whole workspace is healthy.
- **Cache builds are slow the first time** (installs Go, Flutter, Python, Chromium). Subsequent runs reuse the cached image.
- **The agent cannot install OS packages at task time.** Everything that needs `apt-get` must go in `scripts/system-init.sh` and be baked into the cache image via `rover build`.
- **Per-project init scripts run at task time**, not build time, because the project repos are cloned fresh for each task.
- **The Postgres sidecar starts automatically** when Rover creates a task. No manual setup needed. The backend's `DATABASE_URL` defaults to the sidecar hostname.
- **Unit tests don't need Postgres.** The Go backend falls back to in-memory jokes when `db` is nil, so `make test` works anywhere.
