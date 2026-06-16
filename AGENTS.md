# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Repository Overview

Lunora is a pnpm monorepo for the Lunora framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX. Packages live under `packages/<name>/`. Apps (examples, docs site, studio) live under `apps/<name>/`.

**Package manager**: pnpm v11.5.3 (enforced via `packageManager`). **Monorepo orchestration**: @visulima/vis. **Node**: ^22.14.0 || >=24.10.0.

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
pnpm --filter "@lunora/runtime" run test
pnpm --filter "@lunora/runtime" run lint:types

# Lint
pnpm run lint:eslint              # ESLint all
pnpm run lint:eslint:fix          # ESLint fix all
pnpm run lint:prettier            # Prettier check
pnpm run lint:prettier:fix        # Prettier fix
pnpm run lint:types               # TypeScript type check
pnpm run lint:affected:eslint     # Only changed
pnpm run lint:affected:types      # Only changed
```

> Note: `dist/` is gitignored and built on demand. A raw `pnpm --filter … run
test` / `lint:types` does NOT rebuild workspace dependencies, so if an upstream
> `@lunora/*` package's source changed you may hit stale-`dist` errors
> (`X is not a function`, "missing export"). Build first — `pnpm run
build:packages` once, or `pnpm --filter "@lunora/<pkg>..." run build` (the
> trailing `...` includes dependencies) — or use `pnpm run test:affected` /
> `pnpm run lint:affected:types`, which build dependencies for you.

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

Lunora exposes a typed, chainable functional API (the `query`/`mutation`/`action` procedure builders) on top of Cloudflare Workers and Durable Objects:

- **Default topology**: A single Durable Object per app. Easiest to reason about, sufficient for most apps.
- **Opt-in sharding**: `.shardBy(key)` partitions state across many DOs by user/tenant/room.
- **Opt-in global replication**: `.global()` replicates a function/state across regions for low-latency reads.
- **Vite-first DX**: a Vite plugin powers codegen, type sync between server and client, and the dev server.
- **Type-safe end-to-end**: functions, queries, mutations, and subscriptions infer types from server to client.

## Package Structure

### Naming

The CLI binary is `lunora`. The npm scope is `@lunora/*`. The "main" server package is **`@lunora/server`** (directory `packages/server/`) — it exports `defineSchema`, `query`, `mutation`, `action`, and the function-context types. There is no `@lunora/lunora`. When the docs or plan refer to the "main runtime package", it means `@lunora/server`.

### Packages

| Package             | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lunora/server`    | Main API: `defineSchema`, `defineTable`, `query`, `mutation`, `action`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@lunora/values`    | `v.*` validators, return-type inference.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@lunora/runtime`   | Worker entry: RPC router, shard resolver, query coordinator.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@lunora/do`        | `ShardDO` (SQLite, OCC, hibernated WS subscriptions) and `SessionDO`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@lunora/d1`        | D1 adapter for `.global()` tables; wraps the Sessions API for read-your-writes.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@lunora/codegen`   | Emits `_generated/{api,server,dataModel}.ts` from `schema.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@lunora/client`    | Browser SDK: WebSocket, optimistic updates, offline queue.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@lunora/react`     | `useQuery` / `useMutation` / `useSubscription` / `useAuth`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@lunora/vue`       | Vue adapter: live composables (`useQuery` / `useMutation`), optimistic mutations, reactive loaders.                                                                                                                                                                                                                                                                                                                                                                               |
| `@lunora/solid`     | SolidJS adapter: live queries, optimistic mutations, reactive loaders.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@lunora/svelte`    | Svelte adapter: live stores, optimistic mutations, reactive loaders.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@lunora/astro`     | Astro integration: single-worker composition plus reactive-loader server helpers.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@lunora/db`        | TanStack DB binding: `defineCollections` wires Lunora queries/mutations into live, indexed client collections + a durable offline-transactions outbox (optimistic, retried, client-id-keyed). Peer-deps `@tanstack/db` + `@tanstack/offline-transactions`. Scaffolded by `vis generate lunora-collections`.                                                                                                                                                                       |
| `@lunora/vite`      | Vite plugin over `@cloudflare/vite-plugin` — codegen, wrangler validator, error overlay.                                                                                                                                                                                                                                                                                                                                                                                          |
| `@lunora/cli`       | CLI subcommands: `init`, `dev`, `deploy`, `codegen`, `run`, `reset`, `migrate`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@lunora/auth`      | Auth built on **better-auth**, D1-backed (`lunoraD1Adapter`, or any pluggable `AuthStore`): email/password + OAuth (`genericOAuth`), session policies (`sessionPresets`), `handleAuthRequest` routing `/api/auth/*`. Curated plugins re-exported from `@lunora/auth/plugins`: **passkey/WebAuthn**, 2FA, magic-link, email-OTP, admin, organization, JWT, OIDC provider, SIWE, username, anonymous, multi-session.                                                                |
| `@lunora/mail`      | Resend adapter, TSX templates, queue-backed sends.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@lunora/storage`   | R2 typed buckets, signed URLs.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@lunora/scheduler` | `runAfter` / `runAt` + Cron Triggers via `SchedulerDO`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@lunora/container` | Cloudflare Containers: `defineContainer` (in `lunora/containers.ts`) → generated container DO classes + typed `ctx.containers` (`.get`/`.any`/`.pool`); Dockerfile / registry / Railpack `{ build }` image sources; `@lunora/container/do` (the `LunoraContainer` base) and `@lunora/container/bridge` (container→Lunora RPC client) subpaths.                                                                                                                                    |
| `@lunora/ai`        | Workers AI helper on Vercel AI SDK v6 + `workers-ai-provider`: `createAi({ binding: env.AI })` → `ctx.ai` (codegen-wired on ActionCtx when used); `model()`/`embeddingModel()` take a Workers AI id or any AI SDK model (provider-agnostic); re-exports `generateText`/`streamText`/`embed`/`tool`; raw `run()` escape hatch.                                                                                                                                                     |
| `@lunora/advisor`   | Schema & query lints (splinter-style advisors) feeding the studio Advisors table — 8 static rules over `defineSchema` + discovered query reads & insert writes (unindexed-FK, duplicate/empty index, unknown index/relation field/table, filter-without-index, table-without-insert) + planned runtime rules over scan attribution.                                                                                                                                               |
| `@lunora/config`    | **Internal.** Shared CLI+Vite config/scaffolding layer: `wrangler.jsonc` validator + binding inference/reconciliation, the `.dev.vars` grammar + auto-scaffolder, and the interactive prompt helper. Used by `@lunora/cli` and `@lunora/vite`. Published for transparency; consumers depend on the CLI or Vite plugin and let those call into it.                                                                                                                                 |
| `@lunora/studio`    | The Lunora Studio: a local admin UI for your schema, data, logs, and advisors. Embedded by the CLI/Vite via `@lunora/config`'s studio-host.                                                                                                                                                                                                                                                                                                                                       |
| `@lunora/mcp`       | Model Context Protocol server exposing a Lunora deployment to AI agents (list functions/tables, run query/mutation/action).                                                                                                                                                                                                                                                                                                                                                       |
| `@lunora/ratelimit` | Rate limiting: token-bucket / fixed-window / sliding-window algorithms, deny list, sharding, pluggable stores, and procedure middleware.                                                                                                                                                                                                                                                                                                                                          |
| `@lunora/vectors`   | Cloudflare Vectorize adapter: typed vector indexes and similarity search.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@lunora/testing`   | Testing toolkit: an in-memory harness for queries/mutations/actions (`lunoraTest`) plus E2E mail-catcher helpers re-exported from `@lunora/mail/testing`.                                                                                                                                                                                                                                                                                                                         |
| `@lunora/seed`      | Snaplet-style deterministic seeding: introspects `defineSchema`, generates realistic fake data (field-name heuristics + validator kinds), resolves FK parents in topological order, and supports per-table counts + per-field overrides. Adapters: `seed(harness, schema, opts)` (`@lunora/seed/testing`), the `lunora seed` CLI (→ admin import RPC). Built on an **internal** rebuilt `copycat` over `@faker-js/faker` (input-hashed → stable values); copycat is not exported. |

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

**The one exception is `@lunora/codegen`.** Its emitter (`packages/codegen/src/emit.ts`) deliberately writes `.js` extensions into the code it _generates_, because the emitted `_generated/*` files are consumed under NodeNext where the extension is mandatory. So `.js` is correct and required inside: codegen template/string literals, the `_generated/` output, golden fixtures, and the test assertions that verify emitted output. Leave those alone — only the codegen package's own real `import`/`export` statements follow the no-extension rule.

When stripping extensions in bulk, use an AST-aware codemod (e.g. ts-morph, already a dependency) rather than a regex — only real import/export/dynamic-`import()`/`require()`/`vi.mock()` specifiers should change, never extension-bearing strings inside comments, assertions, or template-literal code fixtures.

### Exports — no mixed default + named

**Never mix a default export with named exports in the same file.** If a file has more than one export, use **named exports only** (no `export default`). A `default` export is allowed only when it is the file's _sole_ export. This keeps import sites uniform (`import { x } from "./m"`) and avoids the default-vs-named ambiguity.

When a third-party API insists on a default export (e.g. `@visulima/cerebro`'s lazy command `loader: () => import("./handler")` expects the module's default to be the execute function), do **not** add a `default` alongside the file's named exports. Instead export everything named and adapt at the call site — `loader: () => import("./handler").then((m) => ({ default: m.execute }))`.

### Vis Tags on `project.json`

Each package has tags for categorization:

- `type:package` — marks it as a publishable package
- `category:<slug>` — e.g., `category:runtime`, `category:client`, `category:vite-plugin`, `category:codegen`, `category:cli`

### Dependency Catalog

Shared dependency versions are managed via pnpm catalogs in `pnpm-workspace.yaml`. Packages reference versions as `catalog:test`, `catalog:lint`, `catalog:dev`, `catalog:tsc`, `catalog:types`, etc. **Never** hard-code a version that already lives in a catalog.

### Pre-commit Hooks

Git hooks are **vis-native** (no husky). The committed hook scripts live in `.vis/hooks/` and run via a generated dispatcher at `.vis/hooks/_/` (gitignored). The root `prepare` script (`vis hook install`) wires `core.hooksPath` at it on every `pnpm install`, so the hooks fire after a fresh clone. The pre-commit stage runs two `@visulima/vis` commands (configured in `vis.config.ts`):

- `vis secrets --staged` — gitleaks-compatible scan over staged files; excludes from `secrets.walk.excludePatterns`.
- `vis staged` — runs the per-glob commands declared in the top-level `staged` block (Prettier + ESLint on code, Prettier on Markdown).

The pre-commit script uses `set -e`, so a secret detection aborts before staged-file linting runs. If hooks aren't firing, run `pnpm exec vis hook install` (or `vis hook validate` to diagnose).

### Release

Independent per-package versioning via `multi-semantic-release`. All publishable packages under `packages/` ship a `.releaserc.json` extending `@anolilab/semantic-release-preset/pnpm`. Conventional Commits drive version bumps; the `semantic-release.yml` workflow generates per-package changelogs and publishes on push to `alpha` / `main` / `next` / `beta`. Do not author `release` commits manually.

### Internal scaffolding (`vis generate`)

The CLI no longer ships a `lunora new` subcommand. Internal scaffolding — adding a query/mutation/action/table/cron to `lunora/`, or scaffolding a fresh `@lunora/<name>` workspace package — is done with `vis generate`. Templates live at `.vis/templates/lunora-*.ts` and are discovered automatically.

```bash
vis generate lunora-query --name=listMessages              # → lunora/listMessages.ts
vis generate lunora-mutation --name=sendMessage
vis generate lunora-action --name=syncWithStripe
vis generate lunora-table --name=invoices                  # AST-merges into lunora/schema.ts (creates it if missing)
vis generate lunora-cron --name='clear presence'           # AST-appends to lunora/crons.ts (creates it if missing)
vis generate lunora-container --name=transcoder            # → lunora/containers.ts + containers/<name>/Dockerfile, wires the worker entry
vis generate lunora-workflow --name=orderPipeline          # appends to lunora/workflows.ts (creates it if missing), wires the worker entry
vis generate lunora-collections                            # → lunora/collections.ts (@lunora/db, wired from schema + functions)
vis generate lunora-package --name=foo --description='…'   # → packages/foo/
vis generate --list                                         # show all available generators
```

**Heads-up on the `--name` flag:** vis's CLI parser treats space-separated `--name listMessages` as `--name=true` + a stray positional. **Always use the `--name=value` form.** Same for any other string option on `vis generate`.

End-user scaffolding (`lunora init`) is unaffected — it fetches whole-project templates remotely via `giget` from `gh:anolilab/lunora/templates/<type>#alpha`.

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
