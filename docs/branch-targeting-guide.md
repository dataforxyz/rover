# Branch Targeting Guide

How to create tasks from non-default branches and how branch state flows through the full rover lifecycle.

## Quick reference

| Operation | Branch used | Must specify? |
| --------- | ----------- | ------------- |
| `rover task --source-branch X` | Creates task branch from `X` | Only if not using current branch |
| `rover iterate <id>` | Inherits from task creation | No |
| `rover diff <id>` | Shows changes vs task branch tip | No |
| `rover diff <id> --base` | Shows changes vs source branch HEAD at creation time | No |
| `rover push <id>` | Pushes the task branch (not source) | No |
| `rover rebase <id>` | Rebases onto current branch or `--base` | Optional `--base` |
| `rover merge <id>` | Merges task branch into current branch | No |

## Single-repo: task from a feature branch

### Setup

Any repo with a `rover.json` and multiple branches works. Example:

```
my-project/
  main              ← default branch
  feature/my-work   ← branch you want to task from
  rover.json
```

### Create the task

```bash
cd my-project
rover build -a claude:haiku            # build cache (once)
rover task -a claude:haiku -w swe-tdd \
  --source-branch feature/my-work \
  "Add a /healthz endpoint. Add a test."
```

Rover creates a git worktree from `feature/my-work` with a new task branch (e.g. `rover/task-1-Abc123`). The task branch contains all commits from `feature/my-work`.

### Verify

```bash
rover inspect <id>
# Shows: Branch Name: rover/task-1-Abc123

rover diff <id> --base
# Shows: Comparing with base commit (<feature branch HEAD>)
```

### Iterate

No need to re-specify the branch:

```bash
rover iterate <id> "Also add a timestamp to the response"
```

The iterate runs in the same worktree, on the same task branch, with the same base.

### Push

```bash
rover push <id>
```

Pushes the **task branch** (`rover/task-1-Abc123`) to the remote. Does NOT push to `feature/my-work`.

### Rebase

```bash
rover rebase <id>
```

Rebases the task branch onto the **current** branch (whatever you have checked out in the main repo). To rebase onto a specific branch:

```bash
rover rebase <id> --base feature/my-work
```

### Merge

```bash
git checkout feature/my-work   # switch to target branch first
rover merge <id>               # merges task branch into current branch
```

## Multi-repo: task from a feature branch

### Setup

A workspace with child repos defined in `rover.json`:

```json
{
  "version": "1.5",
  "projects": [
    {
      "name": "backend",
      "path": "backend",
      "repository": "/workspace/sources/backend.git",
      "ref": "main",
      "languages": ["go"],
      "packageManagers": ["gomod"]
    },
    {
      "name": "frontend",
      "path": "frontend",
      "repository": "/workspace/sources/frontend.git",
      "ref": "main",
      "languages": ["python"],
      "packageManagers": ["uv"]
    }
  ]
}
```

The root workspace has branches (`main`, `feature/filters`). Each child repo also has its own branches (`main`, `feature/priority`, `feature/dark-mode`).

### How branches map

- `--source-branch` applies to the **root workspace** only
- Child repos are cloned from their configured `ref` (e.g. `"ref": "main"`)
- All repos share the same **task branch name** (e.g. `rover/task-1-Abc123`)

```
Root workspace:  feature/filters → rover/task-1-Abc123
Backend child:   main            → rover/task-1-Abc123
Frontend child:  main            → rover/task-1-Abc123
```

### Create the task

```bash
cd my-workspace
rover build -a claude:haiku
rover task -a claude:haiku -w swe-tdd \
  --source-branch feature/filters \
  "Add a GET /api/todos/count endpoint to the backend. Add a test."
```

The root worktree is created from `feature/filters`. Inside the container, child repos are cloned from their bare repos and checked out to their configured `ref`, then a task branch is created.

### Push (multi-repo)

```bash
rover push <id>
```

Pushes the task branch from **all repos** (root + each child) to their respective remotes.

### Rebase (multi-repo)

```bash
rover rebase <id>
```

- Root workspace: rebases onto current branch (or `--base`)
- Each child repo: rebases onto its configured `ref` (from `rover.json`)

### Changing child repo branches

To have a child repo start from a different branch, change its `ref` in `rover.json`:

```json
{
  "name": "backend",
  "path": "backend",
  "repository": "/workspace/sources/backend.git",
  "ref": "feature/priority"
}
```

Rebuild the cache after changing refs (`rover build`).

## Key behaviors

1. **Source branch is set once at task creation.** You do NOT need to re-specify it for iterate, push, rebase, or merge.

2. **The task branch is what gets pushed/merged.** The source branch is only used to create the initial worktree. All subsequent operations work with the task branch.

3. **Iterate inherits everything.** No branch flags needed — it runs in the existing task workspace.

4. **Rebase uses current branch by default.** If you want to rebase onto a specific branch, use `--base`. For multi-repo, each child repo rebases onto its own `ref`.

5. **Cache is branch-independent.** The same cache image works regardless of which source branch you use. You only need to rebuild when languages, packages, or init scripts change.

## Verified end-to-end

These scenarios were tested and confirmed working:

| Scenario | Result |
| -------- | ------ |
| Single-repo: `rover task --source-branch feature/X` | Worktree created from feature branch |
| Single-repo: `rover iterate <id>` (no branch flag) | Inherits source branch, runs in same worktree |
| Single-repo: `rover diff <id> --base` | Shows base commit = feature branch HEAD |
| Multi-repo: `rover task --source-branch feature/X` | Root from feature branch, children from their `ref` |
| Multi-repo: child repos cloned inside container | Backend/frontend cloned from bare repos |
| Multi-repo: cache hit after build | `Using cached setup image` confirmed |
| Multi-repo: `/workspace/` repository paths | Resolved to host paths, mounted into container |
