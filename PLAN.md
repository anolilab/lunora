# Cirrus — Plan

## Context

We are bootstrapping a new framework, **Cirrus**, that brings the Convex developer experience to user-owned Cloudflare infrastructure. Two prior-art repos validate the shape:

- **`convex.do`** (dot-do/convex) — early prototype, drop-in Convex API on Cloudflare DO+SQLite. Strengths: API parity ambition, R2 tiering. Gaps: no auth, naive search, schema migrations missing, NL-query layer is speculative.
- **`zeroback`** (zerodeploy-dev/zeroback) — more mature (v0.0.26). Strong DX: schema → codegen → typed `api.*` client, OCC, WebSocket subscriptions, better-auth, R2, scheduler. Critical limit: **single-DO architecture** (10 GB / ~1k req/s ceiling, no sharding).

Cirrus's wedge is to keep Zeroback's DX and beat its scale ceiling from day one, while being **Vite-first** (HMR, codegen via the module graph, dev overlay) with a **standalone fallback** so it's usable from any frontend or backend-only. `kitcn` informs the add-on strategy: ship first-party adapters for **auth (better-auth)**, **mail (Resend)**, **R2 file storage**, and **cron/scheduler** — but as Cloudflare-native modules, not Convex-coupled.

Repo is bootstrapped by copying the visulima monorepo's root tooling (no `packages/` or `apps/`) and **consuming published `@visulima/*` packages** to skip building common infra (CLI, logger, error display, fs, email).

Sources for limits and references:

- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) — 10 GB SQLite/DO, soft 1k req/s/DO, unlimited DOs/account, 30s CPU
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) — 10 GB/DB, 50k DBs/account (1 TB total on Paid), 1k queries/invocation
- [Zero-latency SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/)

---

## Project name + identity

- **Name**: Cirrus
- **NPM scope**: `@cirrus/*` preferred. Phase 0 verifies availability; fallbacks in priority order: `@cirrusjs/*`, `@cirrus-dev/*`, `@cirrus-cf/*`
    - **Status (2026-05-27)**: registry-side check returned 404 for every probed package under `@cirrus`, `@cirrusjs`, `@cirrus-dev`, `@cirrus-cf` — no packages currently published under any candidate scope. Scope claimability (someone _reserving_ without publishing) requires an authed `npm org create cirrus` or `npm publish` attempt by the maintainer; that's an outstanding manual step before first release.
- **Repo**: `cirrus`
- **Binary**: `cirrus`
- **Tagline**: _Type-safe real-time backend on your own Cloudflare account. Vite-first._
- **Brand direction (proposed, refine in Phase 7)**:
    - Mark: **Triple streak** — three thin parallel horizontal strokes of decreasing length, trailing right. Literal cirrus-cloud abstraction; reads as "speed + layers + edge". Also renderable as ASCII (`≡` motif) in CLI banners.
    - Palette: mono ink `#0B0F19` on white; aerial-blue accent `#7CC4FF` reserved for the wordmark highlight. Deliberately avoids Cloudflare orange so we don't look like a first-party CF product.
    - Wordmark: lowercase `cirrus` in **Geist** or **Inter Tight**, slightly tightened tracking.

## Decisions locked in

| Decision               | Choice                                                | Rationale                                                                                                                                      |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint + runner          | **ESLint + Prettier + @visulima/vis** (visulima base) | Maximum reuse of visulima root tooling; textlint/secretlint/renovate pipelines come free                                                       |
| Frontend bindings v0.1 | **React only**                                        | Largest user base; Solid/Vue/Svelte deferred to v0.2 once API stabilizes                                                                       |
| Default sharding       | **Single global DO (Zeroback parity)**                | Lowest learning curve; opt into `.shardBy()` when scaling. We'll surface a runtime warning when SQLite size crosses 1 GB inside the default DO |
| Vite coupling          | **Vite-first, standalone fallback**                   | CLI works without Vite; Vite plugin is the recommended path                                                                                    |

---

## Scale-proof storage architecture (recommended)

The single-DO model (Zeroback) hits a wall at 10 GB or 1k req/s. The scale-proof design is **tiered storage with declarative shard keys**, all expressed in the schema so codegen routes calls automatically.

### Three tiers

1. **Shard-local (default)** — one Durable Object per shard key, SQLite inside. Strong consistency, single-region write, real-time subscriptions stay in-process. Scales horizontally by creating more DOs (account-unlimited).
2. **Global** — Cloudflare D1 for cross-tenant data (identities, billing, account-wide indexes, audit logs). Eventually consistent reads, supports D1 read replicas where available.
3. **Blob + async** — R2 for files (signed URLs), Cloudflare Queues for background work, Workers KV for edge-cached config / feature flags.

### Schema-driven routing

```ts
// cirrus/schema.ts
export const schema = defineSchema({
    // shard-local: every message lives in the channel's DO
    messages: defineTable({ channelId: v.id("channels"), text: v.string() })
        .shardBy("channelId")
        .index("by_created", ["_creationTime"]),

    // global: identity table in D1, read-replicated
    users: defineTable({ email: v.string(), name: v.string() }).global().index("by_email", ["email"], { unique: true }),

    // shard-local with explicit tenant key
    documents: defineTable({ workspaceId: v.id("workspaces"), body: v.string() }).shardBy("workspaceId"),
});
```

Codegen emits `ctx.db.messages.get(id)` that resolves the shard from `id`'s embedded shard prefix and routes the RPC to the correct DO. Cross-shard queries (`ctx.db.messages.search(...)` across all channels) go through a **Query Coordinator Worker** that fans out and merges.

### Default behavior (no `.shardBy()`)

Tables without `.shardBy()` or `.global()` resolve to a single fixed `__root__` Durable Object — same shape as Zeroback. This is the friendly default; an app stays here until it intentionally scales. To prevent silent footguns we surface a runtime warning (and a dashboard banner in dev) once `__root__` SQLite size crosses **1 GB** (10% of the per-DO ceiling). Migration to sharding is a schema edit + one codegen run, no data-format break.

### Why this beats single-DO when you opt in

- **Throughput**: aggregate req/s scales linearly with shard count.
- **Storage**: 10 GB ceiling moves from "per app" to "per shard".
- **Latency**: hot data stays in-process inside the DO; cold/global reads go to D1 (still <50 ms regionally).
- **Migration story**: a small app can run with `shardBy` defaulting to a single fixed key (effectively single-DO) and re-key later — same code path.

### Trade-offs to be honest about

- **Cross-shard transactions are not ACID** — explicit `act.run()` actions with saga-style compensations, like Convex actions.
- **Routing overhead** — one extra Worker hop for shard discovery; mitigated by caching the routing table in DO storage + KV.
- **Codegen is heavier** — schema must declare `shardBy` upfront. We trade ergonomics for predictability.

---

## Repo bootstrap (from visulima)

**Copy from `/home/prisis/WebstormProjects/visulima/` (skip `packages/` and `apps/`):**

| Source                                                                                                                                                                                 | Purpose                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json` (cleaned, scope `@cirrus/*`)                                                                                                                                            | pnpm workspace root, scripts                                                                                                         |
| `pnpm-workspace.yaml`, `.pnpmrc`                                                                                                                                                       | workspace + catalogs                                                                                                                 |
| `vis.config.ts`, `tsconfig.base.json`, `tsconfig.json`                                                                                                                                 | @visulima/vis orchestration (task running + git hooks) + TS base                                                                     |
| `.nvmrc` (Node 22.14), `packageManager` (pnpm 10.32.1)                                                                                                                                 | toolchain pinning                                                                                                                    |
| `vitest.config.ts`, `vitest.workspace.ts`, `tools/get-vitest-config.ts`                                                                                                                | test infra                                                                                                                           |
| `prettier.config.js`, `commitlint.config.cjs`, `.editorconfig`, `.czrc`                                                                                                                | code style                                                                                                                           |
| `.textlintrc`, `.secretlintrc.cjs`, `.lintstagedrc.js`, `.yamllint.yaml`                                                                                                               | linters                                                                                                                              |
| `labeler-config.yml`, `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/`, `.github/workflows/` (semantic-release, test, codeql, scorecards, labeler, stale-issues, lock-issues, codspeed) | CI (git hooks now driven by @visulima/vis, not husky)                                                                                |
| `.github/renovate.json5`, `.coderabbit.yaml`, `codecov.yml`                                                                                                                            | bots + coverage                                                                                                                      |
| `scripts/`                                                                                                                                                                             | scaffolding helpers (internal generators now live in `.vis/templates/cirrus-*.ts`; the old `plop/` + `plopfile.js` path was dropped) |
| `LICENSE.md` (MIT), `README.md` (rewritten), `AGENTS.md` (rewritten), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`                                                           | repo metadata                                                                                                                        |
| `.coderabbit.yaml`, `.prettierignore`, `.cursorignore`, `.secretlintignore`, `.textlintignore`                                                                                         | exclusions                                                                                                                           |

**Skip / drop from visulima**: `packages/`, `apps/`, `shared/`, `docker-compose.yml`, `rust-toolchain.toml`, `rustfmt.toml`, `build-native.yml`, `cargo-test.yml`, `semantic-release-native-addons.mjs` (no native packages in Cirrus v0).

---

## Package layout

> **Folder naming (updated 2026-05-28)**: package directories dropped the `cirrus-` prefix in commit `15bc804`. Folders are now bare (`packages/server/`, `packages/runtime/`, …); only the npm scope keeps the prefix (`@cirrus/*`). The main server package is `@cirrus/server` (`packages/server/`) — there is no `@cirrus/cirrus`.

```
cirrus/
├── packages/
│   ├── server/              # Main API: defineSchema, defineTable, query, mutation, action
│   ├── values/              # v.* validators (string, number, id, object, array, optional, union)
│   ├── runtime/             # Worker entry: router, RPC dispatch, shard resolver, query coordinator
│   ├── do/                  # ShardDO base class (SQLite, OCC, subscriptions), SessionDO
│   ├── d1/                  # D1 adapter for .global() tables, migration runner
│   ├── codegen/             # Emits _generated/{api,server,dataModel}.ts from schema.ts
│   ├── client/              # Browser SDK: WebSocket, optimistic updates, offline queue
│   ├── react/               # useQuery / useMutation / useSubscription / useAuth (v0.1)
│   ├── vite/                # Vite plugin: wraps @cloudflare/vite-plugin, adds codegen + overlay
│   ├── cli/                 # `cirrus init|dev|deploy|codegen|run|reset|migrate`
│   ├── config/              # Internal: shared wrangler.jsonc validator (consumed by cli + vite)
│   ├── auth/                # better-auth adapter, ctx.auth, OAuth callbacks via HTTP routes
│   ├── mail/                # Resend adapter, TSX email templates (re-exports @visulima/email primitives)
│   ├── storage/             # R2: typed upload(), download(), getSignedUrl()
│   └── scheduler/           # runAfter / runAt + Cloudflare Cron Triggers binding
├── apps/
│   ├── docs/                 # Docs site (Fumadocs or Nextra) — kitcn.dev style
│   └── playground/           # Example: real-time chat (exercises shards, auth, R2, scheduler)
└── (root tooling from visulima)
```

### Visulima packages consumed from npm (no vendoring)

- `@visulima/cerebro` → backbone of the `cli` package
- `@visulima/pail` → runtime logger (Workers-compatible)
- `@visulima/error` + `@visulima/source-map` + `@visulima/inspector` → pretty error overlay in DO runtime and Vite plugin
- `@visulima/vite-overlay` → dev error overlay
- `@visulima/fs` + `@visulima/path` → codegen file discovery
- `@visulima/package` + `@visulima/tsconfig` → config / tsconfig discovery
- `@visulima/colorize` + `@visulima/boxen` + `@visulima/spinner` + `@visulima/tabular` → CLI UI
- `@visulima/fmt` + `@visulima/string` + `@visulima/object` + `@visulima/redact` → logging / formatting / GDPR-safe redaction
- `@visulima/connect` → dev-server HTTP middleware (standalone mode)
- `@visulima/health-check` → `/healthz` endpoint
- `@visulima/email` → mail abstraction layer under the `mail` package
- `@visulima/command-line-args` → shared arg parsing

---

## Implementation phases

### Phase 0 — Repo bootstrap

Copy visulima root files per table above, rewrite `package.json`/`README`/`AGENTS.md` for Cirrus, set up empty `packages/` and `apps/` dirs, wire vis targets, get `pnpm install && pnpm lint && pnpm test` green on a placeholder package.

### Phase 1 — Core runtime (`@cirrus/runtime`, `@cirrus/do`, `@cirrus/d1`)

- `ShardDO` base class with SQLite, OCC, transaction store, subscription manager
- **Use the WebSocket Hibernation API** (`webSocketMessage` / `webSocketClose` handlers, `serializeAttachment`) so idle subscriptions cost nothing. With `compatibility_date >= 2026-04-07` the runtime auto-replies to close frames by default; no flag needed (workerd warns if `web_socket_auto_reply_to_close` is set explicitly).
- Worker entry: parses RPC envelope, resolves shard via `getByName(shardKey)`, forwards
- D1 adapter for `.global()` tables: migration runner, prepared statement cache, **Sessions API (`env.DB.withSession(bookmark)`)** for read-your-writes consistency across replicas (ENAM/WNAM/WEUR/EEUR/APAC/OC); echo bookmark in response header so the client can pin reads
- Query Coordinator for cross-shard fan-out (out-of-scope when default single-DO is in use; lights up automatically once any table opts into `.shardBy()`)
    - **Closed 2026-05-27**: `createQueryCoordinator(...)` in `packages/runtime/src/query-coordinator.ts` — pluggable `ShardRegistry` interface (static impl shipped; DO/KV-backed deferred), wire-serializable `MergeStrategy` (`concat` | `sum` | `topK` with `by`/`k`/`direction` | `first`), bounded worker-pool concurrency (default 16), per-shard `setTimeout` race (default 5s), partial failure surfaced as `FanOutResult { data, ok, failed, errors[] }` rather than thrown. Wired into `RpcEnvelope` via optional `fanOut?: FanOutSpec` (mutually exclusive with `shardKey`). Auth/cookie/`x-d1-bookmark` headers forwarded to every shard. 34 passing tests in `packages/runtime/__tests__/query-coordinator.test.ts` cover merge strategies, timeout, partial failure, concurrency cap, async registry.

### Phase 2 — Schema + codegen (`@cirrus/server`, `@cirrus/values`, `@cirrus/codegen`)

- `defineSchema` / `defineTable` / `.shardBy` / `.global` / `.index`
- `v.*` validators, return-type inference
- Codegen emits `_generated/{api,server,dataModel}.ts` from schema using `@visulima/fs` + ts-morph
- `query` / `mutation` / `action` factories with typed `ctx`

### Phase 3 — Client + React bindings (`@cirrus/client`, `@cirrus/react`)

- WebSocket client with reconnect (jittered backoff), optimistic updates, offline queue
- `useQuery` / `useMutation` / `useSubscription` / `useAuth` for React
- Auto-attach `x-d1-bookmark` for read-your-writes against global tables
- (Solid/Vue/Svelte adapters deferred to v0.2)

### Phase 4 — Vite plugin (`@cirrus/vite`)

- **Layer on top of `@cloudflare/vite-plugin`** (uses Vite Environment API to run Worker code in workerd during dev — mirrors production, supports HMR). Don't reinvent the binding/dev-server plumbing
- Watch `cirrus/schema.ts` → trigger `@cirrus/codegen` and emit `_generated/*.ts` into the project
- Inject `@visulima/vite-overlay` for runtime errors with source-mapped stacks
- Validate `wrangler.jsonc` declares the `ShardDO` binding + D1 + R2 bindings the schema implies; fail loudly with a helpful error if missing. The validator itself lives in the internal `@cirrus/config` package and is reused by the CLI (Phase 5).
- Officially test against TanStack Start and React Router v7 (the framework integrations Cloudflare's plugin currently advertises)

### Phase 5 — CLI (`@cirrus/cli`) — Vite-first, standalone fallback

- `cirrus init` — scaffold via remote template fetch (`-t vite`, `-t standalone`, `-t next`). Templates live at the monorepo root in `/templates/<type>/` and are fetched by **giget** at runtime from `gh:anolilab/cirrus/templates/<type>#alpha`. `--from <path>` falls back to a local templates root for offline use (clean-machine smoke + unit tests rely on this). **Internal** package/function scaffolding is now handled by `vis generate` (templates at `.vis/templates/cirrus-*.ts`), replacing the removed `cirrus new` + plop path; the end-user `init` flow does not depend on it.
- `cirrus dev` — if Vite config present, run `vite` + Miniflare; else run Miniflare with `@visulima/connect` dev server
- `cirrus codegen` — one-shot codegen
- `cirrus deploy` — codegen → `wrangler deploy`
- `cirrus run <fn>` — invoke a function ad-hoc against local or remote
- `cirrus reset` — clear local SQLite + D1
- `cirrus migrate` — apply pending D1 migrations for `.global()` tables

### Phase 6 — Add-ons

- `@cirrus/auth` — better-auth adapter, sessions in `SessionDO`, `ctx.auth.user`, OAuth callbacks mounted as HTTP routes
- `@cirrus/mail` — Resend client, TSX templates rendered server-side, queued via Cloudflare Queues
- `@cirrus/storage` — R2 typed bucket bindings, `await ctx.storage.upload(file)`, signed URLs
- `@cirrus/scheduler` — `ctx.scheduler.runAfter(ms, api.x.y, args)`, `runAt(date, ...)`, Cron Triggers via wrangler config

### Phase 7 — Docs + playground

- Docs site under `apps/docs` using **Fumadocs** (Next.js-based, strong MDX + search + typed nav; matches kitcn.dev style)
- `apps/playground` — real-time chat with sharded channels, better-auth login, R2 avatars, scheduled cleanup. Doubles as smoke test.

---

## Verification

End-to-end checks per phase:

1. **Phase 0** — `pnpm install && pnpm lint && pnpm test` green; semantic-release dry-run succeeds.
    - **Repo-wide ESLint backlog cleared (closed 2026-05-28)**: `eslint .` went from 316 errors → 0 (commit `0ee4ab3`). The shared `@anolilab/eslint-config` deliberately downgrades a large rule set to `warn`/`off` as deferred style refactors; those ~765 warnings stay intentionally deferred and are _not_ a gate. Six `eslint --fix` autofixes were semantically wrong and had to be reverted by hand (caught via per-package test runs): `expect(typeof x).toBe("function")` → `expectTypeOf(...)` (4 files, broke compile on unions), `toBeTruthy()` → `toBe(true)` on a string, `toHaveBeenCalled()` → `toHaveBeenCalledWith()` (zero-arg), and `unicorn/prefer-add-event-listener` rewriting WS `onopen/onclose` (broke the client test mock). These rules are warning-level, so re-running `eslint --fix` will re-break them — disable the specific autofixable rules before any blanket fix pass.
    - **Stale `cirrus-` prefix bug family (closed 2026-05-28)**: commit `15bc804` (drop `cirrus-` folder prefix, kebab-case sources) renamed `packages/cirrus-<name>/` → `packages/<name>/` but left three config/test references pointing at the old paths: (a) three `eslint.config.js` per-package override globs (`cirrus-cli`, `cirrus-codegen`, `cirrus-react`) silently matched nothing, so those packages' rule relaxations were disabled; (b) the cli `codegen.test.ts` + `deploy.test.ts` fixture roots referenced `cirrus-codegen` → 5 ENOENT test failures. All fixed; this PLAN's Package layout section was also corrected to the de-prefixed names.
2. **Phase 1** — Vitest tests using `@cloudflare/vitest-pool-workers` exercise a `ShardDO`: insert/query/subscribe across two DOs from one Worker; assert deltas pushed.
3. **Phase 2** — Snapshot test: given `schema.ts`, codegen output matches fixture (`_generated/api.ts`).
4. **Phase 3** — JSDOM tests for hooks; integration test pairs a Miniflare server with a real WebSocket client and asserts subscription deltas land.
5. **Phase 4** — Manual: `pnpm --filter playground dev`, edit a mutation, see HMR within ~200 ms; throw in a handler, see overlay with mapped source line.
6. **Phase 5** — Smoke: `cirrus init -t vite cirrus-test && cd cirrus-test && cirrus dev` works on a clean Node 22 machine.
    - **Clean-machine smoke (closed 2026-05-27)**: `scripts/clean-machine-smoke.sh` (also `pnpm test:clean-machine`). Packs `@cirrus/cli` + its workspace deps (`@cirrus/codegen`, `@cirrus/config`, `@cirrus/vite`) into tarballs, installs the cli into a tmpdir _outside_ the workspace via `pnpm install --ignore-workspace` with `pnpm.overrides` pointing at the tarballs, then runs `cirrus init -t vite` + `cirrus codegen` and asserts the scaffold + `_generated/{api,server,dataModel}.ts` exist. Does NOT boot `cirrus dev` (needs CF account + long-running process).
    - **Packaging hole the script caught (2026-05-27)**: `packages/cli/package.json` `files` whitelist was missing `templates/`, so a published `@cirrus/cli` tarball would have shipped only `plop-templates/` (used by `cirrus new`) — every `cirrus init` would have failed with "template not found". Fixed by adding `templates` to the whitelist.
    - **Templates moved to monorepo root + giget fetch (2026-05-27)**: `cirrus init` now fetches templates remotely via [`giget`](https://github.com/unjs/giget) from `gh:anolilab/cirrus/templates/<type>#alpha` instead of bundling them inside the cli tarball. Templates were `git mv`'d from `packages/cli/templates/` to `/templates/` at the monorepo root, and `templates/` was removed from the cli's `files` whitelist. A `--from <path>` flag preserves an offline-friendly local-copy path for the clean-machine smoke + unit tests + power users with a pre-cloned tree. (Plop + `cirrus new` were later removed entirely; internal scaffolding now uses `vis generate` — see Phase 5.) Reason for the move: keeping the templates in the cli tarball couples template versioning to cli releases; pulling from the branch lets us iterate templates without re-publishing the cli, and end users always get the templates that match the branch they're tracking.
    - **CI gating (2026-05-27)**: `.github/workflows/test.yml` now sets `CIRRUS_WORKERD_TESTS=1` on both the PR-affected and push/dispatch test steps so the workerd-pool integration suites (`@cirrus/do`, `@cirrus/client`, `@cirrus/scheduler`, `@cirrus/storage`) — previously workstation-only because sandboxed dev environments can't loopback to `cloudflare:test-internal` — run on every PR/push in CI.
7. **Phase 6** — Per-adapter integration test against local stubs (better-auth in-memory, Resend mock, R2 emulator via Miniflare, scheduler clock).
8. **Phase 7** — `cirrus deploy` the playground to a Cloudflare account; load-test with 5 channels × 100 concurrent WS clients to confirm sharding holds (target: ≥3k aggregate msgs/sec).
    - **Compose-level smoke gate (closed 2026-05-27)**: `apps/playground/__tests__/smoke.test.ts` runs `runCodegen` + `validateWranglerProject` against the shipped playground project and asserts no problems. Catches the failure mode a real `cirrus dev` would hit on a clean machine. Live deploy + load test remain a manual gate that needs a real CF account (out of scope for repo tests).
    - **Codegen bug surfaced + fixed by the smoke gate (2026-05-27)**: when a handler return-type referenced `Doc<"table">` from `_generated/dataModel`, ts-morph printed `import("./_generated/dataModel.js").Doc_table` (correct from the function file's view) and `emitApi` inlined it verbatim into `_generated/api.ts` — where the path is one level too deep, causing TS2307. Fix in `packages/codegen/src/emit.ts`: `relocateGeneratedImports` strips the `./_generated/` prefix from `import("…")` qualifiers in rendered return types. Regression test at `packages/codegen/__tests__/emit-api.test.ts`.

---

## Files to be modified

This phase produces a new repository tree. The principal authored files:

- Root: `package.json`, `pnpm-workspace.yaml`, `vis.config.ts`, `tsconfig.base.json`, `README.md`, `AGENTS.md` — all rewritten for Cirrus
- Each `packages/*/`: `package.json`, `tsconfig.json`, `src/index.ts`, `vitest.config.ts`, `README.md`
- `apps/docs/` and `apps/playground/`: standard Vite/Fumadocs scaffolding
- CI: minor edits to `.github/workflows/test.yml` to drop Rust/native steps

The visulima root files are copied verbatim where they don't need changes (lint configs, @visulima/vis hooks + staged linting, secretlint, textlint, renovate).

---

## Open questions / deferred

- Whether to keep `convex.do`'s natural-language template-literal API as an optional `@cirrus/nl` package. **Recommendation: defer to v0.2** — adds 6–8 weeks of work, low confidence on UX.
- Multi-region writes (CRDT layer). **Scheduled next.** DO is single-region per object; D1 read replicas cover read scaling. Multi-region writes need a CRDT layer — engine locked to **Yjs**. Starts once vector search lands; design will mirror the vectors approach (adapter + schema DSL + codegen + wrangler validation, type-only ctx surface until the DO/runtime ctx assembly exists).
- Vector search (Cloudflare Vectorize). **Built 2026-05-28 on a separate workspace/branch — not yet merged to `alpha`**, so `packages/vectors/` is absent from the main tree until the merge lands. Implemented as `@cirrus/vectors` (`createVectors` runtime adapter, bring-your-own-embedder — user supplies `embed(input) => number[] | Promise<number[]>`, framework never couples to a provider). Both DSL shapes shipped:
    - **Shape A** (primary): `.vectorize(field, { index, dimensions, metric, metadata?, embed })` fluent chain on `defineTable`. `metadata` is type-checked against the table's shape.
    - **Shape B** (escape hatch): `defineVectorIndex({ source: { table, select }, metadata?, dimensions, metric, embed })` passed in an **optional second argument** to `defineSchema(tables, vectorIndexes?)` — kept out of the table map to preserve per-table type inference and avoid the reserved-name collision.
    - Upsert timing is caller-chosen per call: default = post-commit (queued via `@cirrus/scheduler`); explicit `ctx.vectors.upsertNow(...)` for synchronous semantics. Delete propagation is automatic (`db.delete` on a vectorized table removes its vector(s)). Vectorize is account-global, so the index lives outside DO storage and queries return ids the caller re-fetches via shard-aware `ctx.db.x.get(id)`.
    - Codegen discovers Shape A via the `.vectorize()` chain and Shape B via the second `defineSchema` arg, hoists both into a flat `SchemaIR.vectorIndexes`, and emits a `VectorIndexName` union into `_generated/dataModel.ts`. The wrangler validator requires a matching `[[vectorize]]` binding (by `index_name`) for every declared index — same pattern as the D1/R2 validators. `ctx.vectors` is wired onto `QueryCtx` (read-only: `query`/`getByIds`) and `MutationCtx`/`ActionCtx` (adds `upsert`/`upsertNow`/`deleteByIds`) as a **type-only** surface; live ctx assembly is deferred until the DO/runtime ctx wiring exists.
