# Multi-Env Demo Validation

## Goal

Validate that Rover can run a single task against a multi-repo workspace with:

- Flutter/Dart web frontend
- Go backend (backed by PostgreSQL)
- Python `nodriver` E2E tests
- PostgreSQL sidecar container

Each part should have its own git repository, its own install requirements, and tests that fit the `swe-tdd` workflow.

## Working branch

- `feat/multi-env-demo-validation`

## Desired end state

- One Rover workspace can define multiple sub-projects.
- Sandbox/container setup installs everything needed for all sub-projects.
- A task can work across frontend, backend, and tests in one run.
- `rebase` and `push` behave correctly for the resulting workspace layout.
- Demo project exists locally and is usable for validation.

## Audit checklist

- [x] Confirm current `rover.json` schema for multi-project support.
- [x] Confirm task setup scripts install root and per-project requirements.
- [x] Confirm container image cache hash includes project-specific setup.
- [x] Confirm project cloning/setup works for multiple repositories.
- [x] Confirm `task` works against a multi-project workspace.
- [x] Confirm `rebase` behavior with nested repos/submodules or sibling repos.
- [x] Confirm `push` behavior with nested repos/submodules or sibling repos.
- [x] Confirm `swe-tdd`-style root commands can build/test the demo.

## Demo shape

- `demo/frontend`: Flutter web app
- `demo/backend`: Go API (stores jokes in PostgreSQL)
- `demo/e2e`: Python `nodriver` tests
- `postgres` sidecar: PostgreSQL 15 (auto-started by Rover via `sandbox.services[]`)

Shared demo behavior:

- Frontend renders a simple form/button.
- Backend stores seed jokes in PostgreSQL on startup and reads from the DB for each request. Falls back to in-memory seed list when no DB is available (unit tests).
- E2E test opens the frontend, triggers the same Dart fetch path from the browser, and asserts a joke is shown.

## Resolved questions

- [x] Best repo layout: nested independent repos cloned under one parent workspace via `projects[]` in `rover.json`.
- [x] Rover treats these as cloned sub-project repos (not git submodules). Each is cloned from its `repository` field at task setup.
- [x] `nodriver` works with Chromium and container-safe browser flags in `conftest.py`. No extra companion packages needed beyond Chromium in `sandbox.initScript`.

## Findings

- Multi-project schema support already existed via `projects[]` with per-project language, package manager, task manager, repository, ref, and init script fields.
- Runtime dependency resolution was still root-only. Fixed by iterating root plus per-project package managers during sandbox startup.
- External repositories were being cloned onto base branches only. Fixed by creating or reusing the task branch inside each cloned project repo.
- `projects[].initScript` for cloned repos was effectively broken because Rover tried to mount the script from the host before the repo existed. Fixed by executing project init scripts from the cloned workspace path.
- `push` was still single-repo. Fixed by iterating the root workspace plus configured workspace repositories and pushing each repo branch.
- The default `ghcr.io/endorhq/rover/agent-dev:latest` image is currently stale for this branch's workflow/runtime changes. It still bundles an older `@endorhq/agent` runtime that only validates `agent` and `command` steps, so `swe-tdd` fails in-container even though the workflow is valid in the repo.
- Validation for unreleased Rover workflow/runtime changes therefore needs a locally built agent image from the current checkout. The demo is pinned to `rover-agent-local:latest` for that purpose.
- The demo root `Makefile` had a real `test-e2e` orchestration bug: backgrounding `go run` inside a chained `cd` sequence left later `cd` commands in the wrong directory under Rover's shell, and failed retries could leave port `8080` occupied. Fixed by using absolute workspace paths, explicit bash orchestration, and pre-run cleanup of stale demo processes.
- The backend demo repo shipped an incomplete `go.sum`, so `go test ./...` failed on a clean workspace before any application logic ran. The reproducible demo needs the fully resolved module hashes committed up front.
- Cache-image builds were not executing the root workspace init script, so shared OS-level setup like installing Chromium never made it into the cached image. Fixed in Rover by running root init scripts during `rover build`.
- Attempting to run per-project init scripts during cache builds exposed a second Rover gap: build containers do not clone external project repos first. The pragmatic fix was to keep cache builds to root init scripts only and let per-project init scripts continue to run at normal task startup in the writable cloned workspace.
- Cache-image commits were failing after Go installation because the image diff/export path broke on `/usr/local/go`. Fixed in Rover by installing Go under `/opt/go` instead of `/usr/local/go` for sandbox setup.
- The demo `test-e2e` recipe still had a process-management bug after the first orchestration fix: the leading `pkill -f ...` pre-cleanup commands could match the shell running the recipe itself and terminate the job before backend/frontend logs were even written. Fixed by removing that brittle pre-cleanup from the demo Makefile and generator.
- Clean live validation in task `16` reached a green `make test` inside a real Rover task container after setup completed.
- The child demo `Makefile`s originally omitted `.PHONY`, so `frontend/test` and `frontend/build` could be treated as existing paths and skipped. Fixed by marking root and child task targets as phony.
- The original e2e child `Makefile` used shell-invalid `?=` lines inside a recipe. Fixed by moving those to actual Make variables.
- `flutter config --enable-web` and in-place `flutter create . --platforms web` both proved too brittle as runtime setup steps inside live Rover tasks. The demo now ships a minimal Flutter web scaffold (`.metadata`, `web/index.html`, `web/manifest.json`) up front instead of generating it at task runtime.
- The backend demo now accepts `PORT`, and the root demo Makefile now parameterizes `BACKEND_PORT` and `FRONTEND_PORT`, so repeated runs do not depend on fixed `8080`/`3000` ports.
- The Flutter frontend now accepts `API_BASE_URL` via `--dart-define`, allowing the root orchestration layer to point the built web app at the selected backend port.
- The Python `nodriver` harness needed container-safe browser flags in `conftest.py` to get past initial browser startup failures. That patch is now part of the generated demo.
- In a clean task after the web-scaffold fix, root `make test` passed fully in-container again.
- The root demo `Makefile` originally hardcoded `/workspace` paths, which made isolated/manual reruns harder. It now resolves paths relative to the root Makefile itself.
- The Flutter web e2e path needed an explicit browser-side hook because headless `nodriver` interaction with Flutter semantics was not reliable enough by itself. The generated frontend now exposes a ready signal and fetch event hook for the Python browser test.
- After that hook was added, full root `make setup`, `make test`, and `make test-e2e` passed on a clean generated workspace and again on a separate fresh clone.
- `nodriver` still emits teardown warnings after the passing e2e run. Those warnings did not fail the validated runs, but they are real cleanup noise in the current dependency stack.
- A fresh Rover task has now been validated end to end with Claude auth present. On a fresh clone, Rover created a task from the cached multi-repo image, carried `test_command=make validate`, ran the full `swe-tdd` test loop in-container, and completed successfully.
- Rover task containers intentionally do not keep full sudo after setup. Missing OS packages must be handled in image/build configuration, not installed by the agent during task execution.
- The `swe` and `swe-tdd` workflow prompts are now updated to reflect that boundary and to allow an explicit multi-command root validation sequence when a task is about validating the whole workspace.
- The demo root `Makefile` now also exposes `make validate` as the explicit one-shot validation entrypoint for `make setup`, `make test`, and `make test-e2e`.
- The `swe` and `swe-tdd` workflows no longer rely on agent-created sidecar files for core step handoff. Core markdown now flows through string outputs and is persisted explicitly, which removes the false `context.md` / `plan.md` / `changes.md` missing-file warnings from otherwise successful runs.

## Demo status

- [x] Added reproducible generator script: `demos/create-multi-env-demo.sh`
- [x] Generated local demo workspace at `/tmp/rover-multi-env-demo`
- [x] Build local agent image from current checkout
- [x] Validate `rover build` enough to confirm a fresh cache image is produced with Chromium available
- [x] Validate root `make setup && make test && make test-e2e` on a clean generated workspace
- [x] Validate the same flow on a separate fresh clone
- [x] Validate `rover task -a claude:haiku -w swe-tdd` against a fresh clone using `test_command=make validate`
- [x] Validate `rover rebase` against the demo workspace
- [x] Draft user-facing setup/configuration doc after command validation
- [ ] Add PostgreSQL sidecar to demo (`sandbox.services[]` in `rover.json`)
- [ ] Update Go backend to store/retrieve jokes from Postgres
- [ ] Validate sidecar lifecycle (start, healthcheck, teardown)
- [ ] Validate `rover task -a claude:haiku -w swe-tdd` with Postgres sidecar
- [ ] Write user-facing demo guide: `docs/demo-project-guide.md`

## Validated commands

- `make setup`
- `make test`
- `make test-e2e`
- `make validate`

## Validated Rover task

- Workflow: `swe-tdd`
- Agent: `claude:haiku`
- Explicit test command override: `make validate`
- Result: `Run Tests (exit code: 0)` and final workflow status `completed`
- End-to-end proof point: the Python browser step finished with `1 passed`

## Notes

- Per request, if new questions come up during implementation, they go here and work continues with the most pragmatic placeholder.
