# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Repository Overview

Cirrus is a pnpm monorepo for the Cirrus framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX. Packages live under `packages/<name>/`. Apps (examples, docs site, studio) live under `apps/<name>/`.

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

### Naming

The CLI binary is `cirrus`. The npm scope is `@cirrus/*`. The "main" server package is **`@cirrus/server`** (directory `packages/server/`) — it exports `defineSchema`, `query`, `mutation`, `action`, and the function-context types. There is no `@cirrus/cirrus`. When the docs or plan refer to the "main runtime package", it means `@cirrus/server`.

### Packages

| Package             | Role                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cirrus/server`    | Main API: `defineSchema`, `defineTable`, `query`, `mutation`, `action`.                                                                                                                                                                                                                                                                           |
| `@cirrus/values`    | `v.*` validators, return-type inference.                                                                                                                                                                                                                                                                                                          |
| `@cirrus/runtime`   | Worker entry: RPC router, shard resolver, query coordinator.                                                                                                                                                                                                                                                                                      |
| `@cirrus/do`        | `ShardDO` (SQLite, OCC, hibernated WS subscriptions) and `SessionDO`.                                                                                                                                                                                                                                                                             |
| `@cirrus/d1`        | D1 adapter for `.global()` tables; wraps the Sessions API for read-your-writes.                                                                                                                                                                                                                                                                   |
| `@cirrus/codegen`   | Emits `_generated/{api,server,dataModel}.ts` from `schema.ts`.                                                                                                                                                                                                                                                                                    |
| `@cirrus/client`    | Browser SDK: WebSocket, optimistic updates, offline queue.                                                                                                                                                                                                                                                                                        |
| `@cirrus/react`     | `useQuery` / `useMutation` / `useSubscription` / `useAuth`.                                                                                                                                                                                                                                                                                       |
| `@cirrus/db`        | TanStack DB binding: `defineCollections` wires Cirrus queries/mutations into live, indexed client collections + a durable offline-transactions outbox (optimistic, retried, client-id-keyed). Peer-deps `@tanstack/db` + `@tanstack/offline-transactions`. Scaffolded by `vis generate cirrus-collections`.                                         |
| `@cirrus/vite`      | Vite plugin over `@cloudflare/vite-plugin` — codegen, wrangler validator, error overlay.                                                                                                                                                                                                                                                          |
| `@cirrus/cli`       | CLI subcommands: `init`, `dev`, `deploy`, `codegen`, `run`, `reset`, `migrate`.                                                                                                                                                                                                                                                                   |
| `@cirrus/auth`      | Cookie-session auth: PBKDF2 email/password + OAuth (PKCE) scaffolding, D1-backed; sessions persisted in `SessionDO`.                                                                                                                                                                                                                              |
| `@cirrus/mail`      | Resend adapter, TSX templates, queue-backed sends.                                                                                                                                                                                                                                                                                                |
| `@cirrus/storage`   | R2 typed buckets, signed URLs.                                                                                                                                                                                                                                                                                                                    |
| `@cirrus/scheduler` | `runAfter` / `runAt` + Cron Triggers via `SchedulerDO`.                                                                                                                                                                                                                                                                                           |
| `@cirrus/advisor`   | Schema & query lints (splinter-style advisors) feeding the studio Advisors table — 8 static rules over `defineSchema` + discovered query reads & insert writes (unindexed-FK, duplicate/empty index, unknown index/relation field/table, filter-without-index, table-without-insert) + planned runtime rules over scan attribution.                |
| `@cirrus/config`    | **Internal.** Shared CLI+Vite config/scaffolding layer: `wrangler.jsonc` validator + binding inference/reconciliation, the `.dev.vars` grammar + auto-scaffolder, and the interactive prompt helper. Used by `@cirrus/cli` and `@cirrus/vite`. Published for transparency; consumers depend on the CLI or Vite plugin and let those call into it. |

### Layout

Every package follows the same shape:

- `src/index.ts` — main export
- `__tests__/` — Vitest tests (`.test.ts` or `.spec.ts`)
- `vitest.config.ts` — per-package test config
- `tsconfig.json` — extends `../../tsconfig.base.json`
- `project.json` — vis metadata with tags (e.g., `type:package`, `category:runtime`)
- `package.json` — ESM (`"type": "module"`), `"sideEffects": false`, conditional exports
- `.releaserc.json` — extends `@anolilab/semantic-release-preset/pnpm` (multi-semantic-release picks it up)

### Module imports — no `.js` extensions

Every package compiles with `"moduleResolution": "bundler"` (see `tsconfig.base.json`). Relative imports must therefore be written **without** a file extension — `import { x } from "./foo"`, never `import { x } from "./foo.js"`. Hand-written `.js` extensions are redundant clutter; do not add them and strip any you encounter.

**The one exception is `@cirrus/codegen`.** Its emitter (`packages/codegen/src/emit.ts`) deliberately writes `.js` extensions into the code it _generates_, because the emitted `_generated/*` files are consumed under NodeNext where the extension is mandatory. So `.js` is correct and required inside: codegen template/string literals, the `_generated/` output, golden fixtures, and the test assertions that verify emitted output. Leave those alone — only the codegen package's own real `import`/`export` statements follow the no-extension rule.

When stripping extensions in bulk, use an AST-aware codemod (e.g. ts-morph, already a dependency) rather than a regex — only real import/export/dynamic-`import()`/`require()`/`vi.mock()` specifiers should change, never extension-bearing strings inside comments, assertions, or template-literal code fixtures.

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

Independent per-package versioning via `multi-semantic-release`. All publishable packages under `packages/` ship a `.releaserc.json` extending `@anolilab/semantic-release-preset/pnpm`. Conventional Commits drive version bumps; the `semantic-release.yml` workflow generates per-package changelogs and publishes on push to `alpha` / `main` / `next` / `beta`. Do not author `release` commits manually.

### Internal scaffolding (`vis generate`)

The CLI no longer ships a `cirrus new` subcommand. Internal scaffolding — adding a query/mutation/action/table/cron to `cirrus/`, or scaffolding a fresh `@cirrus/<name>` workspace package — is done with `vis generate`. Templates live at `.vis/templates/cirrus-*.ts` and are discovered automatically.

```bash
vis generate cirrus-query --name=listMessages              # → cirrus/listMessages.ts
vis generate cirrus-mutation --name=sendMessage
vis generate cirrus-action --name=syncWithStripe
vis generate cirrus-table --name=invoices                  # AST-merges into cirrus/schema.ts (creates it if missing)
vis generate cirrus-cron --name='clear presence'           # AST-appends to cirrus/crons.ts (creates it if missing)
vis generate cirrus-collections                            # → cirrus/collections.ts (@cirrus/db, wired from schema + functions)
vis generate cirrus-package --name=foo --description='…'   # → packages/foo/
vis generate --list                                         # show all available generators
```

**Heads-up on the `--name` flag:** vis's CLI parser treats space-separated `--name listMessages` as `--name=true` + a stray positional. **Always use the `--name=value` form.** Same for any other string option on `vis generate`.

End-user scaffolding (`cirrus init`) is unaffected — it fetches whole-project templates remotely via `giget` from `gh:anolilab/cirrus/templates/<type>#alpha`.

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
