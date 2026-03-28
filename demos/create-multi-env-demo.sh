#!/usr/bin/env bash
set -euo pipefail

DEST="${1:-/tmp/rover-multi-env-demo}"
SEED_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$SEED_DIR"
}
trap cleanup EXIT

git_init_repo() {
  local dir="$1"
  git -C "$dir" init -b main >/dev/null
  git -C "$dir" config user.name "Rover Demo"
  git -C "$dir" config user.email "demo@example.com"
}

commit_all() {
  local dir="$1"
  local message="$2"
  git -C "$dir" add -A
  git -C "$dir" commit -m "$message" >/dev/null
}

materialize_bare_ref() {
  local bare_dir="$1"
  local branch="${2:-main}"
  local sha
  sha="$(git --git-dir="$bare_dir" rev-parse "refs/heads/$branch")"
  mkdir -p "$bare_dir/refs/heads"
  printf '%s\n' "$sha" >"$bare_dir/refs/heads/$branch"
}

mkdir -p "$DEST"
rm -rf "$DEST"
mkdir -p "$DEST"

FRONTEND_SRC="$SEED_DIR/frontend-src"
BACKEND_SRC="$SEED_DIR/backend-src"
E2E_SRC="$SEED_DIR/e2e-src"

mkdir -p "$FRONTEND_SRC/lib" "$FRONTEND_SRC/test" "$FRONTEND_SRC/scripts" "$FRONTEND_SRC/web"
cat >"$FRONTEND_SRC/.metadata" <<'EOF'
# This file tracks properties of this Flutter project.
# Used by Flutter tool to assess capabilities and perform upgrades etc.
#
# This file should be version controlled and should not be manually edited.

version:
  revision: "2c9eb20739dfec95e2c74bd3dfa4601b0a8a36aa"
  channel: "stable"

project_type: app

migration:
  platforms:
    - platform: root
      create_revision: 2c9eb20739dfec95e2c74bd3dfa4601b0a8a36aa
      base_revision: 2c9eb20739dfec95e2c74bd3dfa4601b0a8a36aa
    - platform: web
      create_revision: 2c9eb20739dfec95e2c74bd3dfa4601b0a8a36aa
      base_revision: 2c9eb20739dfec95e2c74bd3dfa4601b0a8a36aa

  unmanaged_files:
    - 'lib/main.dart'
EOF
cat >"$FRONTEND_SRC/pubspec.yaml" <<'EOF'
name: joke_frontend
description: Flutter web frontend for the Rover multi-env demo.
publish_to: none
version: 0.1.0

environment:
  sdk: ">=3.3.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.1

dev_dependencies:
  flutter_test:
    sdk: flutter

flutter:
  uses-material-design: true
EOF
cat >"$FRONTEND_SRC/web/index.html" <<'EOF'
<!DOCTYPE html>
<html>
<head>
  <base href="$FLUTTER_BASE_HREF">
  <meta charset="UTF-8">
  <meta content="IE=Edge" http-equiv="X-UA-Compatible">
  <meta name="description" content="Rover multi-env Flutter demo.">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="apple-mobile-web-app-title" content="joke_frontend">
  <title>joke_frontend</title>
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
EOF
cat >"$FRONTEND_SRC/web/manifest.json" <<'EOF'
{
  "name": "joke_frontend",
  "short_name": "joke_frontend",
  "start_url": ".",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "description": "Rover multi-env Flutter demo.",
  "orientation": "portrait-primary",
  "prefer_related_applications": false,
  "icons": []
}
EOF
cat >"$FRONTEND_SRC/lib/main.dart" <<'EOF'
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'browser_storage_stub.dart'
    if (dart.library.html) 'browser_storage_web.dart' as browser_storage;

const apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://127.0.0.1:8080',
);

void main() {
  runApp(const JokeApp());
}

class JokeApp extends StatelessWidget {
  const JokeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Joke Demo',
      theme: ThemeData(colorSchemeSeed: Colors.orange),
      home: const JokeHomePage(),
    );
  }
}

class JokeHomePage extends StatefulWidget {
  const JokeHomePage({super.key});

  @override
  State<JokeHomePage> createState() => _JokeHomePageState();
}

class _JokeHomePageState extends State<JokeHomePage> {
  final _nameController = TextEditingController(text: 'Rover');
  final _random = Random();
  Timer? _debounce;
  String _joke = 'Press the button to fetch a joke.';
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    browser_storage.markReady();
    browser_storage.registerFetchHook((name) {
      _nameController.text = name;
      _fetchJoke();
    });
  }

  void _scheduleFetch() {
    _debounce?.cancel();
    if (_nameController.text.trim().isEmpty) {
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted && !_loading) {
        _fetchJoke();
      }
    });
  }

  Future<void> _fetchJoke() async {
    setState(() {
      _loading = true;
    });

    final response = await http.get(
      Uri.parse(
        '$apiBaseUrl/api/joke?name=${Uri.encodeQueryComponent(_nameController.text)}&seed=${_random.nextInt(10)}',
      ),
    );
    final payload = jsonDecode(response.body) as Map<String, dynamic>;
    final joke = payload['joke'] as String;

    setState(() {
      _joke = joke;
      _loading = false;
    });
    browser_storage.storeJoke(joke);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _nameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Rover Joke Demo')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Enter a name and fetch a random joke from the Go API.'),
            const SizedBox(height: 16),
            TextField(
              key: const Key('name-field'),
              controller: _nameController,
              textInputAction: TextInputAction.done,
              onChanged: (_) => _scheduleFetch(),
              onSubmitted: (_) => _fetchJoke(),
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                labelText: 'Name',
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              key: const Key('fetch-joke'),
              onPressed: _loading ? null : _fetchJoke,
              child: Text(_loading ? 'Loading...' : 'Get joke'),
            ),
            const SizedBox(height: 24),
            SelectableText(
              _joke,
              key: const Key('joke-output'),
            ),
          ],
        ),
      ),
    );
  }
}
EOF
cat >"$FRONTEND_SRC/lib/browser_storage_stub.dart" <<'EOF'
void storeJoke(String value) {}

void markReady() {}

void registerFetchHook(void Function(String name) callback) {}
EOF
cat >"$FRONTEND_SRC/lib/browser_storage_web.dart" <<'EOF'
import 'dart:html' as html;

void storeJoke(String value) {
  html.window.localStorage['rover_demo_joke'] = value;
}

void markReady() {
  html.window.localStorage['rover_demo_ready'] = '1';
}

void registerFetchHook(void Function(String name) callback) {
  html.window.addEventListener('rover-demo-fetch', (event) {
    final customEvent = event as html.CustomEvent;
    final detail = customEvent.detail;
    if (detail is String) {
      callback(detail);
    }
  });
}
EOF
cat >"$FRONTEND_SRC/test/widget_test.dart" <<'EOF'
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joke_frontend/main.dart';

void main() {
  testWidgets('renders the input and button', (tester) async {
    await tester.pumpWidget(const JokeApp());

    expect(find.byType(TextField), findsOneWidget);
    expect(find.widgetWithText(ElevatedButton, 'Get joke'), findsOneWidget);
    expect(find.textContaining('Press the button'), findsOneWidget);
  });
}
EOF
cat >"$FRONTEND_SRC/scripts/init.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
flutter pub get >/dev/null
EOF
cat >"$FRONTEND_SRC/Makefile" <<'EOF'
.PHONY: setup test build

API_BASE_URL ?= http://127.0.0.1:8080

setup:
	flutter pub get

test:
	flutter test

build:
	flutter build web --dart-define=API_BASE_URL=$(API_BASE_URL)
EOF
git_init_repo "$FRONTEND_SRC"
commit_all "$FRONTEND_SRC" "Initial frontend demo"

mkdir -p "$BACKEND_SRC" "$BACKEND_SRC/scripts"
cat >"$BACKEND_SRC/go.mod" <<'EOF'
module example.com/joke-backend

go 1.23.0

require (
	github.com/go-chi/chi/v5 v5.2.1
	github.com/lib/pq v1.10.9
	github.com/rs/cors v1.11.1
)
EOF
cat >"$BACKEND_SRC/go.sum" <<'EOF'
github.com/go-chi/chi/v5 v5.2.1 h1:KOIHODQj58PmL80G2Eak4WdvUzjSJSm0vG72crDCqb8=
github.com/go-chi/chi/v5 v5.2.1/go.mod h1:L2yAIGWB3H+phAw1NxKwWM+7eUH/lU8pOMm5hHcoops=
github.com/lib/pq v1.10.9 h1:YXG7RB+JIjhP29X+OtkiDnYaXQwpS4JEWq7dtCCRUEw=
github.com/lib/pq v1.10.9/go.mod h1:AlVN5x4E4T544tWzH6hKfbfQvm3HdbOxrmggDNAPY9o=
github.com/rs/cors v1.11.1 h1:eU3gRzXLRK57F5rKMGMZURNdIG4EoAmX8k94r9wXWHA=
github.com/rs/cors v1.11.1/go.mod h1:XyqrcTp5zjWr1wsJ8PIRZssZ8b/WMcMf71DJnit4EMU=
EOF
cat >"$BACKEND_SRC/main.go" <<'EOF'
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	_ "github.com/lib/pq"
	"github.com/rs/cors"
)

var seedJokes = []string{
	"%s's code compiled on the first try. Nobody believed the logs.",
	"%s taught a rubber duck to file bug reports.",
	"%s replaced a flaky test with a passing one and then fixed the bug too.",
	"%s wrote a TODO so clear it gained sentience.",
	"%s refactored the joke service until the jokes had interfaces.",
	"%s shipped a hotfix so cold it needed a sweater.",
	"%s opened devtools and the browser confessed immediately.",
	"%s added telemetry to the punchline and measured 100%% laughter.",
	"%s made the backend faster by politely asking it to stop blocking.",
	"%s clicked deploy and the CI pipeline asked for an autograph.",
}

var db *sql.DB

func initDB() *sql.DB {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://postgres:postgres@postgres:5432/jokes?sslmode=disable"
	}

	conn, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}

	if _, err := conn.Exec(`
		CREATE TABLE IF NOT EXISTS jokes (
			id SERIAL PRIMARY KEY,
			template TEXT NOT NULL UNIQUE
		)
	`); err != nil {
		log.Fatalf("failed to create jokes table: %v", err)
	}

	for _, j := range seedJokes {
		_, _ = conn.Exec("INSERT INTO jokes (template) VALUES ($1) ON CONFLICT DO NOTHING", j)
	}

	return conn
}

func jokesFromDB() []string {
	if db == nil {
		return seedJokes
	}
	rows, err := db.Query("SELECT template FROM jokes ORDER BY id")
	if err != nil {
		return seedJokes
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil {
			result = append(result, t)
		}
	}
	if len(result) == 0 {
		return seedJokes
	}
	return result
}

func jokeHandler(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "Rover"
	}

	jokes := jokesFromDB()
	joke := fmt.Sprintf(jokes[rand.IntN(len(jokes))], name)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"joke": joke})
}

func jokeCountHandler(w http.ResponseWriter, _ *http.Request) {
	jokes := jokesFromDB()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"count": len(jokes)})
}

func newRouter() http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	router.Get("/api/joke", jokeHandler)
	router.Get("/api/joke/count", jokeCountHandler)

	return cors.AllowAll().Handler(router)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	db = initDB()
	defer db.Close()

	log.Printf("listening on :%s", port)
	if err := http.ListenAndServe(":"+port, newRouter()); err != nil {
		panic(err)
	}
}
EOF
cat >"$BACKEND_SRC/main_test.go" <<'EOF'
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJokeHandlerIncludesProvidedName(t *testing.T) {
	// db is nil in unit tests — falls back to seedJokes slice
	req := httptest.NewRequest(http.MethodGet, "/api/joke?name=Flutter", nil)
	rec := httptest.NewRecorder()

	newRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var payload map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse payload: %v", err)
	}

	if !strings.Contains(payload["joke"], "Flutter") {
		t.Fatalf("expected joke to include provided name, got %q", payload["joke"])
	}
}

func TestJokeCountHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/joke/count", nil)
	rec := httptest.NewRecorder()

	newRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var payload map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse payload: %v", err)
	}

	if payload["count"] != len(seedJokes) {
		t.Fatalf("expected count %d, got %d", len(seedJokes), payload["count"])
	}
}

func TestHealthz(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	newRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
}
EOF
cat >"$BACKEND_SRC/scripts/init.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
go mod download
EOF
cat >"$BACKEND_SRC/Makefile" <<'EOF'
.PHONY: setup test run

PORT ?= 8080

setup:
	go mod download

test:
	go test ./...

run:
	PORT=$(PORT) go run .
EOF
git_init_repo "$BACKEND_SRC"
commit_all "$BACKEND_SRC" "Initial backend demo"

mkdir -p "$E2E_SRC/tests" "$E2E_SRC/scripts"
cat >"$E2E_SRC/pyproject.toml" <<'EOF'
[project]
name = "joke-e2e"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "nodriver==0.48.1",
  "pytest==8.3.5",
  "pytest-asyncio==0.25.3",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
EOF
cat >"$E2E_SRC/conftest.py" <<'EOF'
import asyncio
import os

from nodriver.core import browser as browser_module
from nodriver.core.config import Config


def pytest_configure(config):
    if "BROWSER_BIN" not in os.environ:
        os.environ["BROWSER_BIN"] = "/usr/bin/chromium"
    if "FRONTEND_URL" not in os.environ:
        os.environ["FRONTEND_URL"] = "http://127.0.0.1:3000"


_original_config_init = Config.__init__


def _patched_config_init(self, *args, **kwargs):
    _original_config_init(self, *args, **kwargs)
    self.sandbox = False

    extra_args = [
        "--disable-gpu",
        "--enable-automation",
        "--no-zygote",
        "--disable-namespace-sandbox",
        "--disable-setuid-sandbox",
    ]
    for arg in extra_args:
        if not any(existing == arg or existing.startswith(f"{arg}=") for existing in self.browser_args):
            self.add_argument(arg)


Config.__init__ = _patched_config_init

_original_stop = browser_module.Browser.stop


async def _async_stop(self):
    return _original_stop(self)


browser_module.Browser.stop = _async_stop
EOF
cat >"$E2E_SRC/tests/test_joke_flow.py" <<'EOF'
import os

import nodriver as uc
import pytest

JOKE_MARKERS = [
    "Nobody believed the logs.",
    "file bug reports.",
    "fixed the bug too.",
    "gained sentience.",
    "had interfaces.",
    "needed a sweater.",
    "confessed immediately.",
    "100% laughter.",
    "stop blocking.",
    "asked for an autograph.",
]


def _extract_text(result) -> str:
    value = getattr(result, "value", result)
    deep_value = getattr(value, "value", value)
    return "" if deep_value is None else str(deep_value)


@pytest.mark.asyncio
async def test_joke_flow():
    browser = await uc.start(
        browser_executable_path=os.environ.get("BROWSER_BIN", "/usr/bin/chromium"),
        headless=True,
        no_sandbox=True,
    )
    try:
        page = await browser.get(os.environ.get("FRONTEND_URL", "http://127.0.0.1:3000"))
        name_field = await page.find("Name")
        await name_field.click()
        ready = ""
        for _ in range(20):
            ready = _extract_text(
                await page.evaluate(
                    "window.localStorage.getItem('rover_demo_ready')",
                    return_by_value=True,
                )
            )
            if ready == "1":
                break
            await page.sleep(0.5)
        assert ready == "1"

        dispatched_name = _extract_text(
            await page.evaluate(
                """
                (() => {
                  const name = "Go + Flutter + Python";
                  window.dispatchEvent(
                    new CustomEvent("rover-demo-fetch", {
                      detail: name,
                    }),
                  );
                  return name;
                })()
                """,
                return_by_value=True,
            )
        )
        assert dispatched_name == "Go + Flutter + Python"

        joke_text = ""
        for _ in range(20):
            joke_text = _extract_text(
                await page.evaluate(
                    "window.localStorage.getItem('rover_demo_joke')",
                    return_by_value=True,
                )
            )
            if any(marker in joke_text for marker in JOKE_MARKERS):
                break
            await page.sleep(0.5)

        assert any(marker in joke_text for marker in JOKE_MARKERS), joke_text
    finally:
        await browser.stop()
EOF
cat >"$E2E_SRC/scripts/init.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
uv sync --all-extras >/dev/null || uv sync >/dev/null
uv run python - <<'PY'
import nodriver
print(f"nodriver ready: {nodriver.__file__}")
PY
EOF
cat >"$E2E_SRC/Makefile" <<'EOF'
FRONTEND_URL ?= http://127.0.0.1:3000
BROWSER_BIN ?= /usr/bin/chromium

.PHONY: setup test

setup:
	uv sync --all-extras || uv sync

test:
	FRONTEND_URL='$(FRONTEND_URL)' BROWSER_BIN='$(BROWSER_BIN)' uv run pytest -q
EOF
git_init_repo "$E2E_SRC"
commit_all "$E2E_SRC" "Initial e2e demo"

mkdir -p "$DEST/sources"
git -C "$FRONTEND_SRC" clone --bare "$FRONTEND_SRC" "$DEST/sources/frontend.git" >/dev/null
git -C "$BACKEND_SRC" clone --bare "$BACKEND_SRC" "$DEST/sources/backend.git" >/dev/null
git -C "$E2E_SRC" clone --bare "$E2E_SRC" "$DEST/sources/e2e.git" >/dev/null
materialize_bare_ref "$DEST/sources/frontend.git"
materialize_bare_ref "$DEST/sources/backend.git"
materialize_bare_ref "$DEST/sources/e2e.git"

mkdir -p "$DEST/scripts"
cat >"$DEST/Makefile" <<'EOF'
PROJECTS=frontend backend e2e
ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

.PHONY: setup test test-frontend test-backend test-e2e validate

BACKEND_PORT ?= 18080
FRONTEND_PORT ?= 13000

setup:
	@if [ ! -d frontend/.git ]; then git clone sources/frontend.git frontend; fi
	@if [ ! -d backend/.git ]; then git clone sources/backend.git backend; fi
	@if [ ! -d e2e/.git ]; then git clone sources/e2e.git e2e; fi
	$(MAKE) -C frontend setup
	$(MAKE) -C backend setup
	$(MAKE) -C e2e setup

test: test-frontend test-backend

test-frontend:
	$(MAKE) -C frontend test

test-backend:
	$(MAKE) -C backend test

test-e2e:
	bash -euo pipefail -c '\
	FRONTEND_PID=""; \
	DATABASE_URL=$${DATABASE_URL:-postgres://postgres:postgres@postgres:5432/jokes?sslmode=disable} \
	$(MAKE) -C $(ROOT_DIR)/backend run PORT=$(BACKEND_PORT) > /tmp/rover-demo-backend.log 2>&1 & BACKEND_PID=$$!; \
	trap "kill $$BACKEND_PID $$FRONTEND_PID 2>/dev/null || true" EXIT; \
	until curl -sf http://127.0.0.1:$(BACKEND_PORT)/healthz >/dev/null; do sleep 1; done; \
	$(MAKE) -C $(ROOT_DIR)/frontend build API_BASE_URL=http://127.0.0.1:$(BACKEND_PORT) > /tmp/rover-demo-frontend-build.log 2>&1; \
	python3 -m http.server $(FRONTEND_PORT) --directory $(ROOT_DIR)/frontend/build/web > /tmp/rover-demo-frontend.log 2>&1 & FRONTEND_PID=$$!; \
	sleep 2; \
	$(MAKE) -C $(ROOT_DIR)/e2e test FRONTEND_URL=http://127.0.0.1:$(FRONTEND_PORT) BROWSER_BIN=/usr/bin/chromium'

validate: setup test test-e2e
EOF
cat >"$DEST/rover.json" <<'EOF'
{
  "version": "1.5",
  "languages": [],
  "mcps": [],
  "packageManagers": [],
  "taskManagers": [
    "make"
  ],
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
      "languages": [
        "dart"
      ],
      "packageManagers": [
        "pub"
      ],
      "initScript": "scripts/init.sh"
    },
    {
      "name": "backend",
      "path": "backend",
      "repository": "/workspace/sources/backend.git",
      "languages": [
        "go"
      ],
      "packageManagers": [
        "gomod"
      ],
      "initScript": "scripts/init.sh"
    },
    {
      "name": "e2e",
      "path": "e2e",
      "repository": "/workspace/sources/e2e.git",
      "languages": [
        "python"
      ],
      "packageManagers": [
        "uv"
      ],
      "initScript": "scripts/init.sh"
    }
  ]
}
EOF
cat >"$DEST/scripts/system-init.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y -qq chromium curl postgresql-client
EOF
cat >"$DEST/README.md" <<'EOF'
# Rover Multi-Env Demo

This workspace is generated for validating Rover against a single task that spans:

- `frontend`: Flutter web UI
- `backend`: Go API (backed by PostgreSQL)
- `e2e`: Python `nodriver` browser tests
- `postgres`: PostgreSQL 15 sidecar container (managed by Rover)

The backend stores jokes in a Postgres database. When running under Rover, the
Postgres sidecar is started automatically and is reachable at `postgres:5432`.
Unit tests run without a database (the backend falls back to an in-memory list).

Useful commands:

- `make setup`
- `make test`
- `make test-e2e`
- `make validate`
EOF
cat >"$DEST/AGENTS.md" <<'EOF'
# Workspace Guide

This workspace has 3 parts plus a database sidecar:

- `frontend`: Flutter web UI
- `backend`: Go API (stores jokes in PostgreSQL)
- `e2e`: Python `nodriver` browser tests
- `postgres` sidecar: PostgreSQL 15 (auto-started by Rover, reachable at `postgres:5432`)

The backend connects to Postgres via `DATABASE_URL` env var.
Default: `postgres://postgres:postgres@postgres:5432/jokes?sslmode=disable`
Unit tests run without a database (falls back to in-memory seed list).

Use the root commands first:

- `make setup`: clone local child repos if needed and install each project
- `make test`: run frontend and backend tests (no DB needed)
- `make test-e2e`: run the full backend + frontend + browser flow (needs DB)
- `make validate`: run `make setup`, `make test`, and `make test-e2e` in order

Project-local commands also exist:

- `make -C frontend test`
- `make -C backend test`
- `make -C e2e test`
EOF
cp "$DEST/AGENTS.md" "$DEST/CLAUDE.md"

git -C "$DEST" init -b main >/dev/null
git -C "$DEST" config user.name "Rover Demo"
git -C "$DEST" config user.email "demo@example.com"
git -C "$DEST" add -A
git -C "$DEST" commit -m "Initial multi-env demo workspace" >/dev/null

printf 'Demo workspace created at %s\n' "$DEST"
