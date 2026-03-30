# Multi-Repo Multi-Env Workspaces

This document describes the Rover workspace shape for a single task that spans multiple repositories and multiple language/runtime environments.

Status:

- Config and setup support are implemented.
- `push` support for workspace repos is implemented.
- `rebase` support for workspace repos is implemented in Rover.
- The generated Flutter + Go + Python demo now validates from a clean workspace, from a fresh clone, and from a fresh-clone Rover task running `swe-tdd` with `make validate`.

## Use case

One Rover task works across:

- a Flutter/Dart web frontend
- a Go backend
- a Python `nodriver` E2E test project

Each project can live in its own git repository and keep its own install and test requirements.

## Configuration model

Use `rover.json` at the workspace root.

Root-level fields still apply as usual:

- `languages`
- `packageManagers`
- `taskManagers`
- `sandbox.initScript`

Add `projects[]` entries for each repo in the task workspace.

Example:

```json
{
  "version": "1.4",
  "languages": [],
  "mcps": [],
  "packageManagers": [],
  "taskManagers": ["make"],
  "attribution": true,
  "sandbox": {
    "initScript": "scripts/system-init.sh"
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

## How Rover handles it

At task startup Rover now:

- installs the union of all languages, package managers, and task managers
- clones each configured project repository into its configured `path`
- creates or reuses the task branch in each cloned repository
- runs the root init script and each project init script
- resolves dependencies for the root workspace and each configured project

During follow-up commands:

- `rover push` walks the root workspace plus configured project repos
- `rover rebase` walks the root workspace plus configured project repos

## Practical guidance

- Put shared system package installation in the root `sandbox.initScript`.
- Put repo-specific setup in each project `initScript`.
- Put project-specific dependency managers on the project entry, not only at the root.
- Keep a root `Makefile`, `justfile`, or `Taskfile` that drives the combined test workflow.
- Prefer a landing-repo pattern: root repo contains orchestration, docs, and task entrypoints; child repos contain the actual app/test code.
- Put minimal root guidance in `AGENTS.md` and `CLAUDE.md` at the workspace root because Rover tasks start at `/workspace`.
- Use local bare repos or reachable remotes for `projects[].repository`.

## Recommended usage

Use one root landing repo as the task entrypoint.

- Put `rover.json`, `Makefile`, `AGENTS.md`, `CLAUDE.md`, and shared docs at the workspace root.
- Put each app/test project in its own git repo under a stable child path such as `frontend`, `backend`, and `e2e`.
- Keep the root repo lightweight. It should orchestrate the workspace, not duplicate child project logic.

Use root `make` targets as the stable Rover interface.

- `make setup` prepares all child repos for humans and for explicit validation runs outside Rover.
- `make test` runs the default fast test pass Rover should prefer for normal TDD loops.
- `make test-e2e` runs the cross-project flow.
- `make validate` runs `make setup`, `make test`, and `make test-e2e` as one explicit full-workspace check.

Use per-project `Makefile`s to keep ownership local.

- `frontend/Makefile` owns Flutter setup, test, build, and run targets.
- `backend/Makefile` owns Go setup, test, and run targets.
- `e2e/Makefile` owns Python setup and browser-test targets.

Use Rover commands this way.

- Run `rover build` after changing shared image/setup inputs such as languages, package managers, `sandbox.initScript`, or child-project dependency manifests that should be baked into the cache image.
- Run `rover task -a claude:haiku -w swe-tdd` from the root landing repo for normal work.
- For explicit whole-workspace validation, pass or confirm the root command override `make validate`.
- Use `rover push` and `rover rebase` from the landing repo; Rover now walks the root repo plus configured child repos.

Keep cache expectations clear.

- Shared tools and OS packages should be baked into the Rover cache image.
- Child repos are still materialized into a fresh task workspace for isolation.
- Repo-specific setup commands may still run per task, but multi-repo `rover build` now materializes child repos during build so dependency-heavy setup can be cached when the relevant manifests are part of the cache key.

Recommended command shape:

- Root `make setup`: clone local child repos when needed and run each child project's setup command.
- Root `make test`: run the unit/integration tests Rover should prefer by default.
- Root `make test-e2e`: run the full cross-project browser flow.
- Root `make validate`: optional but recommended for explicit workspace verification runs that must execute setup, unit tests, and e2e in one command.
- Child project `Makefile`s may still expose `setup`, `test`, `build`, or `run` for local use.
- Keep identical minimal `AGENTS.md` and `CLAUDE.md` files at the workspace root, because Rover tasks enter at `/workspace`.

Example root `Makefile` shape:

```make
ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BACKEND_PORT ?= 18080
FRONTEND_PORT ?= 13000

setup:
	@if [ ! -d frontend/.git ]; then git clone sources/frontend.git frontend; fi
	@if [ ! -d backend/.git ]; then git clone sources/backend.git backend; fi
	@if [ ! -d e2e/.git ]; then git clone sources/e2e.git e2e; fi
	$(MAKE) -C frontend setup
	$(MAKE) -C backend setup
	$(MAKE) -C e2e setup

test:
	$(MAKE) -C frontend test
	$(MAKE) -C backend test

test-e2e:
	bash -euo pipefail -c '\
	$(MAKE) -C $(ROOT_DIR)/backend run PORT=$(BACKEND_PORT) > /tmp/demo-backend.log 2>&1 & BACKEND_PID=$$!; \
	trap "kill $$BACKEND_PID $$FRONTEND_PID 2>/dev/null || true" EXIT; \
	until curl -sf http://127.0.0.1:$(BACKEND_PORT)/healthz >/dev/null; do sleep 1; done; \
	$(MAKE) -C $(ROOT_DIR)/frontend build API_BASE_URL=http://127.0.0.1:$(BACKEND_PORT) > /tmp/demo-frontend-build.log 2>&1; \
	python3 -m http.server $(FRONTEND_PORT) --directory $(ROOT_DIR)/frontend/build/web > /tmp/demo-frontend.log 2>&1 & FRONTEND_PID=$$!; \
	sleep 2; \
	$(MAKE) -C $(ROOT_DIR)/e2e test FRONTEND_URL=http://127.0.0.1:$(FRONTEND_PORT) BROWSER_BIN=/usr/bin/chromium'

validate: setup test test-e2e
```

Example child `Makefile`s:

```make
# frontend/Makefile
.PHONY: setup test build

API_BASE_URL ?= http://127.0.0.1:8080

setup:
	flutter pub get

test:
	flutter test

build:
	flutter build web --dart-define=API_BASE_URL=$(API_BASE_URL)
```

```make
# backend/Makefile
.PHONY: setup test run

PORT ?= 8080

setup:
	go mod download

test:
	go test ./...

run:
	PORT=$(PORT) go run .
```

```make
# e2e/Makefile
FRONTEND_URL ?= http://127.0.0.1:3000
BROWSER_BIN ?= /usr/bin/chromium

.PHONY: setup test

setup:
	uv sync --all-extras || uv sync

test:
	FRONTEND_URL='$(FRONTEND_URL)' BROWSER_BIN='$(BROWSER_BIN)' uv run pytest -q
```

For this demo, the Python test uses `nodriver` against the built Flutter web app and a small browser-side test hook. That hook exists because raw headless interaction with Flutter web semantics was materially less reliable than the rest of the stack.

## About `make setup`

Rover still clones and prepares the configured child repositories during normal task setup.

Use root `make setup` for:

- local development outside Rover
- rebuilding a landing repo workspace by hand
- giving the workflow and humans one obvious bootstrap command

Do not treat `make setup` as a replacement for Rover's internal multi-project clone/setup logic.

## Workflow guidance

For normal coding tasks, Rover should prefer the root `make test` command when the workspace is `make`-driven.

For explicit workspace verification tasks, prefer one root command that covers the whole flow:

- `make validate`, if the workspace defines it
- otherwise a workflow `test_command` override such as `make setup && make test && make test-e2e`

The validated live path for this demo is:

- `rover task -a claude:haiku -w swe-tdd`
- workflow test override: `make validate`
- result: successful fresh-clone Rover task on cached image with Flutter, Go, and Python tests all passing

Do not rely on in-task OS package installation for these runs. Task containers intentionally drop broad sudo after setup, so OS packages belong in `sandbox.initScript`, image config, or `rover build`.

## Demo workspace

The reproducible demo generator lives at:

- [demos/create-multi-env-demo.sh](../demos/create-multi-env-demo.sh)

It generates:

- one root Rover workspace
- three project repositories
- a Flutter frontend
- a Go backend
- a Python `nodriver` E2E suite
- root `AGENTS.md` and `CLAUDE.md`
- a root `Makefile` with `setup`, `test`, and `test-e2e`
- a root `make validate` target for one-shot Rover validation

## Service dependencies (sidecars)

Rover supports per-task service containers for infrastructure dependencies like databases, caches, and message brokers. Each task gets its own isolated set of services on a dedicated Docker network — no cross-task conflicts.

### Configuration

Add `sandbox.services` to your `rover.json`:

```json
{
  "version": "1.5",
  "languages": ["python"],
  "packageManagers": ["uv"],
  "sandbox": {
    "services": [
      {
        "name": "postgres",
        "image": "postgres:16",
        "env": ["POSTGRES_PASSWORD=test", "POSTGRES_DB=myapp"],
        "ports": [5432],
        "healthcheck": {
          "cmd": "pg_isready -U postgres",
          "interval": 5,
          "retries": 5,
          "startPeriod": 10
        },
        "readyTimeout": 60
      },
      {
        "name": "redis",
        "image": "redis:7-alpine",
        "ports": [6379],
        "healthcheck": {
          "cmd": "redis-cli ping"
        }
      }
    ]
  }
}
```

### How it works

When a task starts, Rover:

1. Creates a Docker network named `rover-services-{taskId}-{iteration}`
2. Starts each service container on that network with the service `name` as hostname
3. Waits for services with healthchecks to become healthy (up to `readyTimeout` seconds)
4. Attaches the task container to the same network
5. Tears down all service containers and the network when the task stops

The task container reaches services by name: `postgres:5432`, `redis:6379`.

### Service fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Hostname on the task network |
| `image` | yes | Docker image |
| `ports` | no | Informational — all ports are reachable on the task network |
| `env` | no | Environment variables (`KEY=VALUE` strings) |
| `volumes` | no | Volume mounts (same syntax as Docker `-v`) |
| `healthcheck` | no | Health check config — services without one are assumed ready immediately |
| `command` | no | Override the image entrypoint command |
| `readyTimeout` | no | Max seconds to wait for healthy (default: 60) |

### Healthcheck fields

| Field | Default | Description |
|-------|---------|-------------|
| `cmd` | (required) | Command to run inside the container |
| `interval` | 5 | Seconds between checks |
| `timeout` | 5 | Seconds before a check times out |
| `retries` | 3 | Failures before unhealthy |
| `startPeriod` | 0 | Grace period before first check |

### Important notes

- Services are **runtime-only** — `rover build` does not start them. They don't affect the cache image.
- Services work with both Docker and Podman backends.
- Network filtering (`sandbox.network`) applies to external traffic only. Containers on the same task network always reach each other.
- Service names must be unique within a workspace.

### Multi-repo workspaces with services

For the multi-repo pattern, services are shared across all sub-projects. Define them once at `sandbox.services` — the backend, frontend, and e2e projects all connect to the same `postgres` and `redis` on the task network.

Example combined config:

```json
{
  "version": "1.5",
  "taskManagers": ["make"],
  "sandbox": {
    "initScript": "scripts/system-init.sh",
    "services": [
      {
        "name": "postgres",
        "image": "postgres:16",
        "env": ["POSTGRES_PASSWORD=test", "POSTGRES_DB=app"],
        "healthcheck": { "cmd": "pg_isready -U postgres" }
      }
    ]
  },
  "projects": [
    {
      "name": "backend",
      "path": "backend",
      "repository": "/workspace/sources/backend.git",
      "languages": ["go"],
      "packageManagers": ["gomod"]
    },
    {
      "name": "frontend",
      "path": "frontend",
      "repository": "/workspace/sources/frontend.git",
      "languages": ["dart"],
      "packageManagers": ["pub"]
    }
  ]
}
```

The backend connects to `postgres:5432` during tests, and the same database is available to e2e tests.

## Current caveats

- First-time container/image setup is expensive because Flutter and Chromium installation are heavy.
- `nodriver` currently emits teardown warnings after the e2e test passes. They did not fail the validated runs, but the warnings are real.
- Live Rover workflow execution still depends on valid agent auth in the local environment. The multi-env workspace path itself is now validated with Claude auth present.
