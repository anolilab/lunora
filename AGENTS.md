# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Repository Overview

Lunora is a pnpm monorepo for the Lunora framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX. Packages live under `packages/<name>/`. Apps (examples, docs site, studio) live under `apps/<name>/`.

**Package manager**: pnpm v11.5.3 (enforced via `packageManager`). **Monorepo orchestration**: @visulima/vis. **Node**: ^22.15.0 || >=24.11.0.

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
pnpm run lint:eslint              # ESLint all (add :fix to autofix)
pnpm run lint:prettier            # Prettier check (add :fix to autofix)
pnpm run lint:types               # TypeScript type check
pnpm run lint:affected:eslint     # Only changed
pnpm run lint:affected:types      # Only changed
pnpm run lint:package-json        # package.json key order (add :fix to autofix)
```

> **`package.json` key-order gotcha.** Key order is enforced by its own CI job ("Lint (package.json sort)") and by **nothing else** — ESLint, Prettier, `lint:types`, `api:check`, and `dist:check` are all blind to it. So a hand-added block in the wrong position (classically `peerDependencies` placed above `devDependencies` instead of below) goes green locally and red in CI. Canonical order is whatever `vis sort-package-json` emits; run `pnpm run lint:package-json` (= `vis sort-package-json --check`) after editing any manifest.
>
> Note `vis sort-package-json --help` currently crashes ([visulima#741](https://github.com/visulima/visulima/issues/741)) whenever a command's help text contains a literal `{`, so its flags aren't discoverable that way. `--check`, `--sort-scripts`, `--indent`, `--ignore <glob>`, `--sort-order`, `--unsorted <section>`, and `--line-ending` all exist.

> **Stale-`dist` gotcha.** `dist/` is gitignored and built on demand. A raw `pnpm --filter … run test` / `lint:types` does **not** rebuild workspace dependencies, so if an upstream `@lunora/*` package's source changed you may hit stale-`dist` errors (`X is not a function`, "missing export"). Build first — `pnpm run build:packages` once, or `pnpm --filter "@lunora/<pkg>..." run build` (the trailing `...` includes dependencies) — or use `pnpm run test:affected` / `pnpm run lint:affected:types`, which build dependencies for you.

## Commit Convention

Angular-style conventional commits, enforced by hooks:

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `perf`, `docs`, `dx`, `refactor`, `test`, `workflow`, `build`, `ci`, `chore`, `types`, `wip`, `release`, `deps`, `revert`. Scope is typically the package name (e.g., `feat(runtime): add durable-object client`). Subject: imperative, lowercase, no period, max 50 chars. Do not author `release` commits by hand.

## Branch Strategy

- **alpha**: Primary development branch — most PRs target this (default branch)
- **main**: Stable releases
- **next/beta**: Pre-release channels
- Feature branches: `feat/name`, `fix/issue-number`

## Architecture Overview

Lunora exposes a typed, chainable functional API (the `query`/`mutation`/`action` procedure builders) on top of Cloudflare Workers and Durable Objects:

- **Default topology**: a single Durable Object per app — easiest to reason about, sufficient for most apps.
- **Opt-in sharding**: `.shardBy(key)` partitions state across many DOs by user/tenant/room.
- **Opt-in global replication**: `.global()` replicates a function/state across regions for low-latency reads.
- **Vite-first DX**: a Vite plugin powers codegen, server↔client type sync, and the dev server.
- **Type-safe end-to-end**: functions, queries, mutations, and subscriptions infer types from server to client.

## Package Structure

### Naming

The CLI binary is `lunora`. The npm scope is `@lunora/*`. The "main" server package is **`@lunora/server`** (directory `packages/server/`) — it exports `defineSchema`, `query`, `mutation`, `action`, and the function-context types. "Main runtime package" in docs/plans means `@lunora/server`.

There is an unscoped **umbrella** package `lunorash` (directory `packages/lunora/`; npm name is `lunorash` because `lunora` is taken on npm, but the directory and CLI bin stay `lunora`). It re-exports the base packages (`@lunora/server` + subpaths, `@lunora/values`, `@lunora/runtime`, `@lunora/do`, `@lunora/client`) via subpaths (`lunorash/server`, …) and ships the `lunora` CLI bin. Codegen emits `lunorash/*` imports in `_generated/*` when a project declares a `lunorash` dependency (else `@lunora/*`) — opt-in and backward-compatible. Add-ons/adapters/Vite plugin stay separate installs.

**Platform family (plan 114).** Multi-platform support is split into a contracts package, a host-neutral engine, one host package per target, and extracted host-neutral telemetry:

- `@lunora/platform` — **contracts** (types + capability matrix, zero deps): `ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`, `SchedulerHost`, the canonical binding `*Like` projections, `PlatformCapabilities`. The behavioural TCK lives at the `@lunora/platform/conformance` subpath (`/conformance/suite` is the workerd-safe pure suite; the barrel adds the `node:sqlite` reference host) — the TCK versions in lockstep with the contracts it asserts, and a subpath keeps the root import types-only.
- `@lunora/shard-engine` — the host-neutral reactive engine (extracted from `@lunora/do`).
- `@lunora/platform-cloudflare` — the Cloudflare **host**: the contracts implemented over Durable Object primitives, plus the composition roots (`createShardPlatform` / `createWorkerPlatform`). `@lunora/do` depends on it and stays the Durable Object class itself; app code never imports it directly.
- `@lunora/platform-node` — a Node **host** spike (plan 234): no `lunora dev` wiring, no deploy driver, capabilities mostly `unsupported`/`emulated`; its public surface is still expected to move. Add it alongside `platform`/`platform-cloudflare` in the API-snapshot guard once it graduates past spike stage.
- `@lunora/observability` — host-neutral telemetry (logs, metrics, traces, issues), also extracted from `@lunora/do`.

Each host is its own `@lunora/platform-<target>` package — never a subpath of the contracts package, since each carries its own provider deps. `@lunora/platform` stays zero-dependency.

### Packages

Concise roles below — read the package's `src/` and `docs/` for detail. Flags: **Internal** = supporting layer, depend on the CLI/Vite/runtime that uses it; **not published** = build-time only; **Experimental** = outside the 1.0 stability promise.

| Package                       | Role                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lunorash`                    | **Unscoped umbrella** (dir `packages/lunora/`, npm `lunorash`, bin `lunora`). Re-exports the base packages via subpaths; codegen emits `lunorash/*` when depended on.                                                                                                 |
| `@lunora/server`              | Main API: `defineSchema`, `defineTable`, `query`, `mutation`, `action`; ships `ctx.secrets` (Cloudflare Secrets Store).                                                                                                                                               |
| `@lunora/values`              | `v.*` validators, return-type inference.                                                                                                                                                                                                                              |
| `@lunora/errors`              | **Zero-dep** error layer: `LunoraError`, `ERROR_CATALOG`, guards, `invariant`/`unreachable`, `toErrorBody`. Terminal renderer lives in `@lunora/cli`.                                                                                                                 |
| `@lunora/runtime`             | Worker entry: RPC router, shard resolver, query coordinator.                                                                                                                                                                                                          |
| `@lunora/do`                  | `ShardDO` (SQLite, OCC, hibernated WS subscriptions) and `SessionDO`.                                                                                                                                                                                                 |
| `@lunora/platform`            | Platform-family contracts (types + capability matrix, zero deps): `ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`, `SchedulerHost`, the canonical binding `*Like` projections, `PlatformCapabilities`; behavioural TCK at `@lunora/platform/conformance`. |
| `@lunora/shard-engine`        | Host-neutral reactive engine for the platform family (extracted from `@lunora/do`).                                                                                                                                                                                   |
| `@lunora/platform-cloudflare` | The Cloudflare host: `@lunora/platform` contracts implemented over Durable Object primitives, plus `createShardPlatform` / `createWorkerPlatform`.                                                                                                                    |
| `@lunora/platform-node`       | **Experimental.** A Node host spike (plan 234) for the platform contracts — no `lunora dev` wiring, no deploy driver, capabilities mostly `unsupported`/`emulated`.                                                                                                   |
| `@lunora/observability`       | Host-neutral telemetry storage + read models: request logs, traces, metrics, issue grouping, security audit. Backs the Studio's observability pages; extracted from `@lunora/do`.                                                                                     |
| `@lunora/d1`                  | D1 adapter for `.global()` tables; wraps the Sessions API for read-your-writes.                                                                                                                                                                                       |
| `@lunora/codegen`             | Emits `_generated/{api,server,dataModel}.ts` from `schema.ts`.                                                                                                                                                                                                        |
| `@lunora/client`              | Browser SDK: WebSocket, optimistic updates, offline queue.                                                                                                                                                                                                            |
| `@lunora/react`               | `useQuery` / `useMutation` / `useSubscription` / `useAuth`.                                                                                                                                                                                                           |
| `@lunora/react-native`        | React Native / Expo: re-exports `@lunora/react`, adds `createLunoraClient` + `@lunora/react-native/auth` better-auth Expo bridge.                                                                                                                                     |
| `@lunora/vue`                 | Vue adapter: live composables, optimistic mutations, reactive loaders.                                                                                                                                                                                                |
| `@lunora/solid`               | SolidJS adapter: live queries, optimistic mutations, reactive loaders.                                                                                                                                                                                                |
| `@lunora/svelte`              | Svelte adapter: live stores, optimistic mutations, reactive loaders.                                                                                                                                                                                                  |
| `@lunora/angular`             | Angular signal-based adapter: `provideLunora` / `injectLunoraClient` / `liveQuery` / `mutate` / `connectionStatus`.                                                                                                                                                   |
| `@lunora/astro`               | Astro integration: single-worker composition + reactive-loader server helpers.                                                                                                                                                                                        |
| `@lunora/nuxt`                | Nuxt module: mounts Lunora inside Nitro; `@lunora/nuxt/server` reactive-loader helpers.                                                                                                                                                                               |
| `@lunora/db`                  | TanStack DB binding: `defineCollections` → live indexed collections + durable offline outbox.                                                                                                                                                                         |
| `@lunora/replica`             | Local-first replica runtime: `EventSource`, `LocalMirror` (pluggable SQLite), `EventsSync`; SQLite adapters as subpath exports.                                                                                                                                       |
| `@lunora/vite`                | Vite plugin over `@cloudflare/vite-plugin`: codegen, wrangler validator, error overlay.                                                                                                                                                                               |
| `@lunora/cli`                 | CLI subcommands: `init`, `dev`, `deploy`, `codegen`, `run`, `reset`, `migrate`.                                                                                                                                                                                       |
| `@lunora/auth`                | Auth on **better-auth**, D1-backed; email/password + OAuth, session policies; curated plugins via `@lunora/auth/plugins`.                                                                                                                                             |
| `@lunora/auth-ui`             | **Internal, not published.** Source-of-truth for the copy-in, user-owned auth screens distributed via the `auth-ui-*` registry items; synced into `registry/auth-ui-<framework>/` by `scripts/sync-auth-ui-registry.mjs` (checked by `pnpm run lint:registry:sync`).  |
| `@lunora/cloudflare-access`   | Cloudflare Access (Zero Trust) identity → `ctx.auth` / RLS via a `resolveIdentity` adapter.                                                                                                                                                                           |
| `@lunora/mail`                | Resend adapter, TSX templates, queue-backed sends.                                                                                                                                                                                                                    |
| `@lunora/notify`              | Multi-channel notifications: `ctx.notify`/`ctx.push` over `@visulima/notification`; Web Push + FCM, subscription stores + queue fan-out; `/web` browser subpath.                                                                                                      |
| `@lunora/storage`             | R2 typed buckets, signed URLs.                                                                                                                                                                                                                                        |
| `@lunora/scheduler`           | `runAfter` / `runAt` + Cron Triggers via `SchedulerDO`.                                                                                                                                                                                                               |
| `@lunora/container`           | Cloudflare Containers: `defineContainer` → container DO classes + typed `ctx.containers`; `@lunora/container/do` + `/bridge` subpaths.                                                                                                                                |
| `@lunora/agent`               | Durable AI agents (add-on): `defineAgent` compiles a replay-safe tool-loop onto Cloudflare Workflows — tools (MCP/function/agent/sandbox), memory, HITL approvals, token streaming, telemetry.                                                                        |
| `@lunora/ai`                  | Workers AI on Vercel AI SDK v7 → `ctx.ai`; `@lunora/ai/rag` ships `defineRag` (chunk→embed→Vectorize + retrieve).                                                                                                                                                     |
| `@lunora/flags`               | OpenFeature feature flags: `defineFlags` → `ctx.flags`; `useFlag`/`useFlags` client hooks; read-only Studio page.                                                                                                                                                     |
| `@lunora/advisor`             | Schema & query lints (splinter-style) feeding the Studio Advisors pages (~95 static rules at last count — see `STATIC_LINTS` in `packages/advisor/src/index.ts` for the live set — plus runtime lints).                                                               |
| `@lunora/config`              | **Internal.** Shared CLI+Vite config/scaffolding: `wrangler.jsonc` validator, `.dev.vars` grammar/scaffolder, prompt helper.                                                                                                                                          |
| `@lunora/search-core`         | **Internal, not published** (bundled into server/do/sql-store). The shared full-text search core: analyzer, tokenizer, scorer, caps, cursor algebra, backfill policy.                                                                                                 |
| `@lunora/sql-store`           | **Internal.** Dialect-parameterized SQL store core for `.global()` backends (D1, PlanetScale).                                                                                                                                                                        |
| `@lunora/studio`              | Local admin UI for schema, data, logs, and advisors. Embedded by the CLI/Vite.                                                                                                                                                                                        |
| `@lunora/mcp`                 | MCP server exposing a Lunora deployment to AI agents; can front durable `@lunora/agent` runs (config-gated, fail-closed).                                                                                                                                             |
| `@lunora/ratelimit`           | Rate limiting: token-bucket / fixed-window / sliding-window, deny list, sharding, pluggable stores, procedure middleware.                                                                                                                                             |
| `@lunora/testing`             | Testing toolkit: `lunoraTest` in-memory harness, `agentHarness` double, `evaluate` scorers, mail-catcher helpers.                                                                                                                                                     |
| `@lunora/seed`                | Deterministic seeding from `defineSchema` (FK-ordered fake data); `@lunora/seed/testing` + `lunora seed` CLI.                                                                                                                                                         |
| `@lunora/bindings`            | Cloudflare binding helpers, per-binding subpaths: `/kv`, `/images`, `/analytics`, `/pipelines`, `/vectors`, `/r2sql` → `ctx.*` facades.                                                                                                                               |
| `@lunora/browser`             | Cloudflare Browser Rendering: `ctx.browser` (action-only) — navigate, screenshot/PDF, scrape.                                                                                                                                                                         |
| `@lunora/hyperdrive`          | BYO Postgres/MySQL via Cloudflare Hyperdrive: driver-agnostic `ctx.sql` (action-only); node-postgres / postgres.js / mysql2 adapters.                                                                                                                                 |
| `@lunora/payment`             | Provider-agnostic payments: Stripe-first + Polar adapters, webhook sync, subscription state machine, entitlements, money helpers.                                                                                                                                     |
| `@lunora/x402`                | **Experimental.** Agentic payments (x402): charge agents per request (`/charge`) and pay x402-gated resources (`/pay`).                                                                                                                                               |
| `@lunora/workflow`            | Durable workflows over Cloudflare Workflows: `defineWorkflow` + generated `WorkflowEntrypoint` classes, `ctx.workflows`.                                                                                                                                              |
| `@lunora/queue`               | Cloudflare Queues: `defineQueue` → typed `ctx.queues.<name>` producers + a generated `queue()` consumer (or `mode: "pull"`).                                                                                                                                          |
| `@lunora/dispatch`            | **Internal, not published** (bundled into queue/workflow). Shared dispatch runner calling a Lunora function from a server-initiated context.                                                                                                                          |
| `@lunora/fingerprint`         | **Zero-dep** deterministic error-grouping (`fingerprintError` → stable 16-char hash); feeds the `getIssues` RPC + Studio Issues panel.                                                                                                                                |

### Layout

Every package follows the same shape:

- `src/index.ts` — main export
- `__tests__/` — Vitest tests (`.test.ts` or `.spec.ts`)
- `vitest.config.ts` — per-package test config
- `tsconfig.json` — extends `../../tsconfig.base.json`
- `project.json` — vis metadata with tags (`type:package`, `category:<slug>`)
- `package.json` — ESM (`"type": "module"`), `"sideEffects": false`, conditional exports
- `.releaserc.json` — extends `@anolilab/semantic-release-preset/pnpm`

## Conventions & Best Practices

**Research the codebase before editing. Never change code you haven't read.**

### Module imports — no `.js` extensions

Every package compiles with `"moduleResolution": "bundler"` (see `tsconfig.base.json`). Write relative imports **without** a file extension — `import { x } from "./foo"`, never `"./foo.js"`. Strip any `.js` extensions you encounter.

**The one exception is `@lunora/codegen`.** Its emitter (`packages/codegen/src/emit.ts`) deliberately writes `.js` extensions into the code it _generates_, because `_generated/*` is consumed under NodeNext where the extension is mandatory. So `.js` is correct inside codegen template/string literals, `_generated/` output, golden fixtures, and the assertions verifying emitted output — leave those alone. Only the codegen package's own real `import`/`export` statements follow the no-extension rule.

When stripping extensions in bulk, use an AST-aware codemod (e.g. ts-morph, already a dependency), not a regex — only real import/export/`import()`/`require()`/`vi.mock()` specifiers should change, never extension-bearing strings in comments, assertions, or template-literal fixtures.

### Exports — no mixed default + named

**Never mix a default export with named exports in the same file.** If a file has more than one export, use **named exports only**. A `default` export is allowed only when it is the file's _sole_ export — this keeps import sites uniform and avoids default-vs-named ambiguity.

When a third-party API insists on a default export (e.g. `@visulima/cerebro`'s lazy `loader: () => import("./handler")`), do **not** add a `default` alongside named exports. Adapt at the call site instead — `loader: () => import("./handler").then((m) => ({ default: m.execute }))`.

### Platform parity — state the mapping when you add a feature

Every new `ctx.*` surface or binding states its mapping **per target**, or its
explicit non-support, in the same change that adds it:

- Add the feature to `PlatformCapabilities` in `@lunora/platform` and rate it
  `"native" | "emulated" | "unsupported"` for each target in the matrix
  (`CLOUDFLARE_CAPABILITIES`, and any sibling target that exists).
- If it is host-backed, say which contract carries it — or add one. A feature
  that reaches past `ShardHost`/`SocketHost`/`ShardDirectory`/`ShardKvStore`/
  `SchedulerHost` into a provider API is a porting blocker, and the time to
  notice is while writing it.
- If a target cannot serve it, `"unsupported"` is a fine answer. Codegen omits
  the surface and emits a `platform_unsupported_feature` diagnostic; silence is
  what causes the second host to discover the gap at runtime.

This is a process control, not paperwork. The matrix is what codegen trusts to
decide whether an app can target a host, and it is only honest if it is updated
by the person who already knows the answer. Two contracts have shipped wrong in
exactly the way this prevents — `ShardSqlExec` promised a field nothing read and
omitted three the engine used, and the canonical binding `*Like` types drifted
from the real ones because nothing consumed them.

### Dependency Catalog

Shared dependency versions live in pnpm catalogs in `pnpm-workspace.yaml`. Packages reference them as `catalog:test`, `catalog:lint`, `catalog:dev`, `catalog:tsc`, `catalog:types`, etc. **Never** hard-code a version that already lives in a catalog.

### Top-level `shared/` — bundler-inlined source (not a package)

The repo root holds a **`shared/`** folder for tiny, dependency-free helpers that more than one package needs but that must **not** create a runtime dependency edge between those packages (e.g. `shared/stable-key.ts`, the `stableStringify` encoder used by `@lunora/client`, `@lunora/react`, and `@lunora/do`).

- **Not a package.** Consumers import it by **relative path** (`../../../shared/<file>`) and the bundler **inlines** it into each `dist` — no new dependency edge. Keep these files genuinely zero-dependency (relative or built-in imports only) or inlining breaks.
- **Tooling.** Prettier-formatted and type-checked transitively, but **outside per-package ESLint** — follow the no-`.js`-extension and named-export-only conventions by hand.
- **Consumer tsconfig.** A package importing `shared/*` must drop `outDir`/`rootDir` from its `tsconfig.json` (a set `rootDir` raises TS6059 for the out-of-package file under `tsc --noEmit`). A breadcrumb comment in each such tsconfig explains the divergence.
- **Don't reach for `shared/` first.** Prefer a real `@lunora/*` package when a runtime dependency edge is acceptable; `shared/` is only for the no-coupling, inline-only case.

### Pre-commit Hooks

Git hooks are **vis-native** (no husky). Committed scripts live in `.vis/hooks/`, run via a generated dispatcher at `.vis/hooks/_/` (gitignored); the root `prepare` script (`vis hook install`) wires `core.hooksPath` on every `pnpm install`. The pre-commit stage runs (via `vis.config.ts`, `set -e`):

- `vis secrets --staged` — gitleaks-compatible scan over staged files (aborts before linting on detection).
- `vis staged` — per-glob commands from the top-level `staged` block (Prettier + ESLint on code, Prettier on Markdown).

If hooks aren't firing, run `pnpm exec vis hook install` (or `vis hook validate` to diagnose).

### Release

Independent per-package versioning via `multi-semantic-release`. Publishable packages ship a `.releaserc.json` extending `@anolilab/semantic-release-preset/pnpm`. Conventional Commits drive bumps; the `semantic-release.yml` workflow publishes on push to `alpha` / `main` / `next` / `beta`. Do not author `release` commits manually.

### Internal scaffolding (`vis generate`)

Adding a query/mutation/action/table/cron to `lunora/`, or a fresh `@lunora/<name>` package, is done with `vis generate` (templates at `.vis/templates/lunora-*.ts`). There is no `lunora new` subcommand.

```bash
vis generate lunora-query --name=listMessages              # → lunora/listMessages.ts
vis generate lunora-mutation --name=sendMessage
vis generate lunora-action --name=syncWithStripe
vis generate lunora-http-route --name=stripeWebhook        # → lunora/stripeWebhook.ts (HTTP route)
vis generate lunora-table --name=invoices                  # AST-merges into lunora/schema.ts
vis generate lunora-cron --name='clear presence'           # AST-appends to lunora/crons.ts
vis generate lunora-container --name=transcoder            # → lunora/containers.ts + Dockerfile, wires worker entry
vis generate lunora-workflow --name=orderPipeline          # appends to lunora/workflows.ts, wires worker entry
vis generate lunora-queue --name=emailQueue                # producer + queue() consumer
vis generate lunora-step --name=chargeOrder                # reusable defineStep, run via ctx.runStep
vis generate lunora-agent --name=support                   # defineAgent, appends to lunora/agents.ts (@lunora/agent)
vis generate lunora-flags                                  # → lunora/flags.ts singleton (@lunora/flags); refuses if it exists
vis generate lunora-collections                            # → lunora/collections.ts (@lunora/db)
vis generate lunora-package --name=foo --description='…'   # → packages/foo/
vis generate --list                                         # list all generators
```

**`--name` flag:** vis parses space-separated `--name listMessages` as `--name=true` + a stray positional. **Always use `--name=value`** (same for any string option on `vis generate`).

End-user scaffolding (`lunora init`) is unaffected — it fetches whole-project templates remotely via `giget` from `gh:anolilab/lunora/templates/<type>#alpha`.

## Agent Worktree Isolation

When spawning sub-agents via the Agent tool in this repo, default to `isolation: "worktree"` so the agent works on an isolated git worktree and cannot stomp on uncommitted changes in the main checkout.

- **Use worktrees for** any agent that edits/writes/refactors code, and long-running implementation tasks where the user may keep working in the main tree.
- **Skip worktrees for** read-only research/search agents (`Explore`, `Plan`, `general-purpose` used purely for research) and quick one-shot lookups where install/vis-cache overhead outweighs the benefit.
- **Costs:** each worktree needs a fresh `pnpm install` (store shared, `node_modules` per-worktree); vis cache (`.vis/`) starts cold; a branch checked out in one worktree can't be checked out in another; non-empty worktrees must be cleaned up with `git worktree remove` (empty ones auto-clean).
- **Repo-local git config** (apply once): `rerere.enabled = true` (reuse conflict resolutions across rebases), `worktree.guessRemote = true` (auto-track matching remote branch). `.worktrees/` is gitignored.
- **Commands:** `git worktree list` / `git worktree prune` / `git worktree remove <path>` (refuses if dirty; `--force` to override).
