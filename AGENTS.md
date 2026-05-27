# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Repository Overview

Cirrus is a pnpm monorepo for the Cirrus framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX. Packages live under `packages/<name>/`. Apps (examples, docs site, dashboard) live under `apps/<name>/`.

**Package manager**: pnpm v10.32.1 (enforced). **Monorepo orchestration**: @visulima/vis. **Node**: ^22.14.0 || >=24.10.0.

## Build & Test Commands

```bash
# Build
pnpm run build                    # All targets (dev)
pnpm run build:packages           # Just packages
pnpm run build:affected           # Only changed projects

# Test
pnpm run test                     # All tests
pnpm run test:coverage            # With coverage
pnpm run test:affected            # Only changed projects

# Single package (use pnpm --filter)
pnpm --filter "@cirrus/runtime" run test
pnpm --filter "@cirrus/runtime" run lint:types

# Lint
pnpm run lint:eslint              # ESLint all
pnpm run lint:eslint:fix          # ESLint fix all
pnpm run lint:prettier            # Prettier check
pnpm run lint:prettier:fix        # Prettier fix
pnpm run lint:types               # TypeScript type check
pnpm run lint:affected:eslint     # Only changed
pnpm run lint:affected:types      # Only changed
```

## Commit Convention

Angular-style conventional commits, enforced by hooks:

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `perf`, `docs`, `dx`, `refactor`, `test`, `workflow`, `build`, `ci`, `chore`, `types`, `wip`, `release`, `deps`, `revert`. Scope is typically the package name (e.g., `feat(runtime): add durable-object client`). Subject: imperative, lowercase, no period, max 50 chars.

## Branch Strategy

- **alpha**: Primary development branch — most PRs target this (default branch)
- **main**: Stable releases
- **next/beta**: Pre-release channels
- Feature branches: `feat/name`, `fix/issue-number`

## Architecture Overview

Cirrus exposes a Convex-style functional API on top of Cloudflare Workers and Durable Objects:

- **Default topology**: A single Durable Object per app. Easiest to reason about, sufficient for most apps.
- **Opt-in sharding**: `.shardBy(key)` partitions state across many DOs by user/tenant/room.
- **Opt-in global replication**: `.global()` replicates a function/state across regions for low-latency reads.
- **Vite-first DX**: a Vite plugin powers codegen, type sync between server and client, and the dev server.
- **Type-safe end-to-end**: functions, queries, mutations, and subscriptions infer types from server to client.

## Package Structure

Every package follows the same layout:

- `src/index.ts` — main export
- `__tests__/` — Vitest tests (`.test.ts` or `.spec.ts`)
- `vitest.config.ts` — per-package test config
- `tsconfig.json` — extends `../../tsconfig.base.json`
- `project.json` — vis metadata with tags (e.g., `type:package`, `category:runtime`)
- `package.json` — ESM (`"type": "module"`), `"sideEffects": false`, conditional exports

### Vis Tags on `project.json`

Each package has tags for categorization:

- `type:package` — marks it as a publishable package
- `category:<slug>` — e.g., `category:runtime`, `category:client`, `category:vite-plugin`, `category:codegen`, `category:cli`

### Dependency Catalog

Shared dependency versions are managed via pnpm catalogs in `pnpm-workspace.yaml`. Packages reference versions as `catalog:test`, `catalog:lint`, `catalog:dev`, `catalog:tsc`, `catalog:types`, etc. **Never** hard-code a version that already lives in a catalog.

### Pre-commit Hooks

Husky drives two `@visulima/vis` commands on commit (configured in `vis.config.ts`):

- `vis secrets --staged` — gitleaks-compatible scan over staged files; excludes from `secrets.walk.excludePatterns`.
- `vis staged` — runs the per-glob commands declared in the top-level `staged` block (Prettier + ESLint on code, Prettier on Markdown).

Hook chain (`.husky/pre-commit`) uses `set -e`, so a secret detection aborts before staged-file linting runs.

### Release

Independent per-package versioning via `multi-semantic-release`. Each package gets a `.releaserc.json` extending `@anolilab/semantic-release-preset/pnpm` once it is ready to publish.

Research the codebase before editing. Never change code you haven't read.

## Agent Worktree Isolation

When spawning sub-agents via the Agent tool in this repo, default to `isolation: "worktree"` so the agent works on an isolated git worktree and cannot stomp on uncommitted changes in the main checkout.

**Apply worktree isolation to:**

- Any agent that edits, writes, or refactors code (`general-purpose`, `pro-workflow:orchestrator`, `pro-workflow:debugger`, `coderabbit:code-reviewer` when it auto-fixes, etc.)
- Long-running implementation tasks where the user may continue working in the main tree in parallel

**Skip worktree isolation for:**

- Read-only research/search agents (`Explore`, `Plan`, `pro-workflow:planner`, `pro-workflow:reviewer`, `pro-workflow:scout`, `general-purpose` when used purely for research)
- Quick one-shot lookups where the install/vis-cache overhead outweighs the benefit

**Costs to be aware of:**

- Each worktree needs a fresh `pnpm install` before builds/tests run (pnpm store is shared, but `node_modules` is per-worktree).
- vis cache (`.vis/`) starts cold per worktree — first `build:affected` / `test:affected` runs won't be cached.
- A branch checked out in another worktree can't be checked out simultaneously in the main tree.
- Empty (no-change) worktrees are auto-cleaned by the Agent tool; otherwise the path + branch are returned and must be cleaned up with `git worktree remove`.

**Repo-local git config (apply once with `git config`):**

- `rerere.enabled = true` — record-and-reuse merge conflict resolutions, so rebases inside a worktree don't make you re-solve the same conflict.
- `worktree.guessRemote = true` — `git worktree add -b <branch>` auto-tracks the matching remote branch if one exists.
- `.worktrees/` is gitignored so worktrees placed inside the repo never leak into `git status`.

**Useful commands:**

- `git worktree list` — show all active worktrees.
- `git worktree prune` — clean up stale worktree records (after `rm -rf` of a worktree dir).
- `git worktree remove <path>` — remove a worktree cleanly (refuses if dirty; add `--force` to override).
