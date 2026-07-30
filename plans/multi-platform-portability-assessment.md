# Lunora Multi-Platform Portability Assessment

## Executive Summary

Lunora is deeply engineered for the Cloudflare Workers platform. Its core value—type-safe, real-time, durable state on the edge—derives from a specific stack: the Workers runtime, Durable Objects (DO) with SQLite and hibernated WebSockets, D1, R2, KV, Queues, Workflows, and the `workerd`/`wrangler` tooling ecosystem. As of mid-2026, **no open-source or third-party platform provides a drop-in replacement for this entire stack**. Supporting additional deployment targets is possible, but it is a **platform-portability project**, not a configuration tweak. It would require a host abstraction layer and, in most cases, alternative implementations of several subsystems.

This document assesses the most credible open-source alternatives and maps the concrete package-by-package changes that multi-platform support would require. It is intended to inform a go/no-go decision and to serve as a reference if the team chooses to pursue plan 114 (multi-provider platform, including its AWS target).

**Status (2026-07-24):** the go decision was taken and plan 114 is under way. `@lunora/platform` (contracts), `@lunora/platform-conformance` (TCK), and `@lunora/shard-engine` (host-neutral engine) exist; `ShardDO`'s transaction and socket-accept paths run through the contracts, and the TCK passes against both the in-memory reference host and the Cloudflare adapters in real workerd. See [Next Steps](#next-steps-if-proceeding) for what is done and what is open.

---

## Candidate Alternatives: Findings

### 1. Rivet

Rivet is an open-source "serverless game backend" and actor platform. It provides Durable-Object-like actors with state, RPC, and networking.

- **Status:** Mature enough for real workloads; growing ecosystem.
- **Model:** Actor-based, but the API and programming model are Rivet-specific. It is not a Cloudflare compatibility layer.
- **Verdict for Lunora:** **Credible alternative runtime, not a drop-in target.** Porting Lunora to Rivet would mean rewriting `@lunora/do`, `@lunora/runtime`, and parts of `@lunora/server` to Rivet's actor model. This is feasible but is a "second runtime" effort, similar to porting to AWS Lambda + DynamoDB or to a Kubernetes operator.

### 2. Other Evaluated Alternatives

| Platform / Project                                       | What it replaces                          | Fit for Lunora                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **workerd (open-source)**                                | Workers runtime                           | Needed for any "self-hosted Workers" target, but it is only the runtime. It does not provide DO orchestration, storage, or the rest of the stack.                                                         |
| **Miniflare**                                            | Local dev / test runtime                  | Already used for local testing. Not a production platform.                                                                                                                                                |
| **Spin (Fermyon)**                                       | WASM-based serverless runtime             | Different runtime model (WASM components). Would require recompiling the runtime and rewriting bindings. High friction.                                                                                   |
| **wasmCloud**                                            | WASM actor platform                       | Actor-based, NATS-backed. Would require a full rewrite of the durable-object and messaging layers.                                                                                                        |
| **Dapr**                                                 | Distributed application runtime / sidecar | Could abstract state, pub/sub, actors, and workflows, but introduces a sidecar model foreign to Lunora's current design. Useful for a Kubernetes-hosted abstraction, not a direct Cloudflare replacement. |
| **Temporal**                                             | Durable workflows                         | Could replace Cloudflare Workflows (`@lunora/workflow`) but not DOs, storage, or the rest of the stack.                                                                                                   |
| **libSQL / Turso**                                       | SQLite database                           | Could replace D1 for global tables, but not the DO-local SQLite semantics.                                                                                                                                |
| **MinIO**                                                | S3-compatible object storage              | Could replace R2 in `@lunora/storage`, but would lose Cloudflare-native signed-URL integration.                                                                                                           |
| **NATS / JetStream**                                     | Queues / pub-sub                          | Could replace Cloudflare Queues (`@lunora/queue`), but semantics differ.                                                                                                                                  |
| **AWS Lambda + DynamoDB + EventBridge + Step Functions** | Full serverless stack                     | Plan 114's AWS half already explores this. It is the most credible "second platform" target and builds on the same plan's abstraction layer.                                                              |
| **Vercel / Netlify / Supabase Edge Functions**           | Edge compute                              | Provide only request/response Workers-like functions. They lack durable state, actors, and most of the storage primitives Lunora relies on.                                                               |

**Bottom line:** There is no "Cloudflare clone." Multi-platform support means selecting one or more alternative platforms and building adapter implementations.

---

## Package-by-Package Cloudflare Dependency Map

The table below lists every package that touches Cloudflare-specific APIs and what would need to change to support another platform.

### Core runtime & server (highest impact)

| Package           | Cloudflare dependencies                                                                                                                                       | Portability effort                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@lunora/runtime` | `Request`/`Response`, `ExecutionContext`, `ExportedHandler`, WebSocket upgrade, DO RPC/stub routing, binding access                                           | High. This is the host contract. Plan 114 proposes abstracting this into `*Like` interfaces.                                        |
| `@lunora/server`  | `QueryCtx`, `MutationCtx`, `ActionCtx` expose runtime-agnostic interfaces, but they assume the runtime provides DO stubs, env bindings, and execution context | Medium. Public user-facing API can stay stable if the internal host contract is abstracted.                                         |
| `@lunora/do`      | `DurableObject`, `DurableObjectStorage` (SQLite), `DurableObjectState`, hibernated WebSockets (`acceptWebSocket`, `serializeAttachment`, etc.), DO alarms     | Very high. The ShardDO/SessionDO model is the heart of Lunora state. A different platform needs its own actor/state implementation. |

### Storage, database, and bindings

| Package             | Cloudflare dependencies                                                                    | Portability effort                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@lunora/d1`        | D1 binding (`D1Database`, `D1PreparedStatement`, `D1Result`)                               | Medium. Replaceable with any SQL backend (Postgres, MySQL, libSQL/Turso) behind a `SqlStore` interface. Plan 114 already uses `SqlStore`. |
| `@lunora/sql-store` | Internal dialect-parameterized SQL core for `.global()` backends                           | Low. This package is already designed to support D1, PlanetScale, and other SQL backends.                                                 |
| `@lunora/storage`   | R2 binding (`R2Bucket`, `R2Object`, signed URLs)                                           | Medium. S3-compatible storage (MinIO, AWS S3) can be adapted behind a bucket interface.                                                   |
| `@lunora/bindings`  | KV, Vectors, Analytics, Pipelines, Images, R2SQL subpaths — all Cloudflare binding facades | Medium–high. Each subpath needs a host adapter; KV and Vectors are the most used.                                                         |

### Messaging, workflows, scheduling

| Package             | Cloudflare dependencies                                                                                 | Portability effort                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@lunora/queue`     | Cloudflare Queues (`Queue`, `queue` consumer binding, `MessageBatch`)                                   | Medium. Replaceable with NATS, SQS, Redis streams, or a self-hosted queue, but delivery semantics must be matched. |
| `@lunora/workflow`  | Cloudflare Workflows (`WorkflowStep`, `WorkflowEntrypoint`)                                             | Medium–high. Temporal, AWS Step Functions, or a durable-task framework could back this.                            |
| `@lunora/scheduler` | DO alarms + Cron Triggers (`SchedulerDO`)                                                               | Medium. Needs a job scheduler abstraction; Cron Triggers are Cloudflare-specific.                                  |
| `@lunora/dispatch`  | Internal runner that calls Lunora functions from server-initiated contexts; bundled into queue/workflow | Medium. Depends on the RPC/contracts defined by `@lunora/runtime`.                                                 |

### Compute extensions

| Package              | Cloudflare dependencies                              | Portability effort                                                                                                                                       |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lunora/container`  | Cloudflare Containers (container DO classes, bridge) | High. No direct equivalent elsewhere; this is a Cloudflare-specific feature.                                                                             |
| `@lunora/hyperdrive` | Cloudflare Hyperdrive binding (`HYPERDRIVE`)         | Medium. On another platform, direct database connections replace Hyperdrive's pooling layer.                                                             |
| `@lunora/browser`    | Cloudflare Browser Rendering                         | High. Browser automation is platform-specific; would require Puppeteer/Playwright on Node or another rendering service.                                  |
| `@lunora/ai`         | Workers AI (`ctx.ai`) + Vectorize (`@lunora/ai/rag`) | Medium–high. AI inference can be retargeted to OpenAI, Anthropic, AWS Bedrock, Ollama, etc. Vectorize can be replaced with pgvector, Pinecone, Weaviate. |

### Auth, mail, flags, payment, etc.

| Package           | Cloudflare dependencies                                      | Portability effort                                                                                                                           |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lunora/auth`    | Better Auth + D1-backed sessions                             | Low–medium. Better Auth is platform-agnostic; only the D1 adapter is Cloudflare-specific. Can use Postgres/MySQL adapter on other platforms. |
| `@lunora/mail`    | Resend adapter, queue-backed sends                           | Low. Resend is external; queue backend is the only Cloudflare tie.                                                                           |
| `@lunora/flags`   | OpenFeature provider; currently reads from Cloudflare config | Low. OpenFeature is designed for multi-provider swapping.                                                                                    |
| `@lunora/payment` | Stripe/Polar adapters                                        | Low. External APIs; queue backend is the only Cloudflare tie.                                                                                |
| `@lunora/x402`    | Experimental agentic payments                                | Medium. x402 is a protocol; implementation depends on the runtime's HTTP/crypto primitives.                                                  |

### Client, framework adapters, and developer tooling

| Package                                                                              | Cloudflare dependencies                                                                    | Portability effort                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `@lunora/client`                                                                     | WebSocket client, fetch, optimistic updates                                                | Low. Browser/Node fetch/WebSocket are standard. Only connection URL discovery is server-coupled.           |
| `@lunora/react`, `@lunora/vue`, `@lunora/solid`, `@lunora/svelte`, `@lunora/angular` | Client-side framework bindings                                                             | Low. No direct Cloudflare dependency.                                                                      |
| `@lunora/astro`, `@lunora/nuxt`                                                      | Framework integrations for single-worker composition                                       | Medium. The integration logic is Cloudflare-specific; other hosts need their own integration packages.     |
| `@lunora/vite`                                                                       | Vite plugin wrapping `@cloudflare/vite-plugin`, codegen, wrangler validator, error overlay | High. A different target needs a different Vite/dev-server plugin.                                         |
| `@lunora/cli`                                                                        | `wrangler`, `deploy`, `dev`, `migrate` subcommands                                         | High. CLI is built around wrangler/Cloudflare workflows.                                                   |
| `@lunora/config`                                                                     | `wrangler.jsonc` validator, `.dev.vars` scaffolder                                         | High. Configuration model is Cloudflare-specific.                                                          |
| `@lunora/codegen`                                                                    | Emits `_generated/*` from `schema.ts`; imports can target `lunorash/*` or `@lunora/*`      | Low. Codegen is mostly platform-agnostic, but generated worker entrypoints and binding references are not. |
| `@lunora/studio`                                                                     | Local admin UI; embedded by CLI/Vite; uses runtime RPCs                                    | Medium–high. Studio queries runtime-specific RPCs (`getIssues`, etc.); needs host-agnostic RPC layer.      |
| `@lunora/testing`                                                                    | `lunoraTest` in-memory harness, `agentHarness`                                             | Medium. Harness simulates the runtime; must implement whatever host contract is abstracted.                |
| `@lunora/seed`                                                                       | Deterministic seeding from `defineSchema`                                                  | Low. Uses runtime storage but can be retargeted.                                                           |
| `@lunora/replica`                                                                    | Local-first replica runtime (`EventSource`, `LocalMirror`, SQLite adapters)                | Low–medium. Local-first logic is mostly platform-agnostic; sync transport depends on the server runtime.   |
| `@lunora/db`                                                                         | TanStack DB binding; durable offline outbox                                                | Medium. Depends on DO/queue-backed outbox.                                                                 |

### Umbrella package

| Package    | Cloudflare dependencies                    | Portability effort                |
| ---------- | ------------------------------------------ | --------------------------------- |
| `lunorash` | Re-exports base packages; CLI bin `lunora` | Low for re-exports; high for CLI. |

---

## Required Abstractions (Interface Changes)

A credible multi-platform Lunora needs a **host contract** that hides Cloudflare-specific APIs from user code and from most internal packages. The following abstractions are the minimum set.

### 1. Runtime / request context

Currently in `@lunora/runtime` and `@lunora/server`:

- `ExecutionContextLike` — already exists.
- Need a stable `LunoraHost` interface that provides:
    - `fetch(request)` dispatch
    - `waitUntil(promise)`
    - `passThroughOnException()` or equivalent
    - WebSocket upgrade helpers
    - Environment/binding bag access (`env: Record<string, unknown>`)

**Interface impact:** Public `QueryCtx` / `MutationCtx` / `ActionCtx` can keep their shape; the `ctx` object is built by the host adapter. Internal types in `@lunora/runtime` change more.

### 2. Durable state / shard host — **shipped in `@lunora/platform`**

The DO model is abstracted behind three contracts (already defined, see `packages/platform/src/`):

- **`ShardHost`** — single-writer execution per shard key: `runSerialized(fn)` (input-gate semantics), `transaction(fn)` (ACID, auto-rollback, no raw BEGIN/COMMIT), `sql: ShardSqlExec` + optional `asyncSql`, `alarms`, `waitUntil`.
- **`SocketHost`** — hibernated WebSocket subscriptions: `accept(socket, attachment, tags?)`, `getSockets(tag?)`, attachment round-trip via `serializeAttachment`/`deserializeAttachment`.
- **`ShardDirectory`** — deterministic placement + RPC dispatch: `idForName(name)`, `get(id)`, optional `getByName`, optional `jurisdiction(hint)` (fail-closed when unsupported).

Socket tagging is deliberately two-tiered, because hosts disagree on when a tag can be set. **Accept-time tags are mandatory** — durable, fixed for the socket's life, and honoured exactly by `getSockets(tag)`. **Mutable tags** (`setTag`/`removeTag`) are the optional tier: a host declares them only if it can retag a live socket. Cloudflare cannot (DO tags freeze at `acceptWebSocket`), so the Cloudflare host omits both rather than shipping a no-op the engine could route on.

**Interface impact:** `@lunora/do` shrinks to the Cloudflare implementation of these contracts; alternative platforms supply their own host packages. User-facing `.shardBy()` and `.global()` remain unchanged.

### 3. SQL store

`@lunora/sql-store` already defines a dialect-parameterized SQL core (`SqlDialect` + `SqlExec`). `@lunora/d1` is the Cloudflare adapter; `@lunora/hyperdrive` already ships Postgres and MySQL dialects — the data layer is genuinely engine-neutral today.

**Interface impact:** Low. Continue the existing pattern: more `SqlDialect` implementations (libSQL, Aurora) behind the same seam.

### 4. Object / KV / vector storage — **canonical types shipped in `@lunora/platform`**

`packages/platform/src/bindings.ts` now carries the canonical `R2BucketLike`, `KVNamespaceLike`, and `VectorizeIndexLike` projections. Per-package copies (`@lunora/storage`, `@lunora/bindings/*`) become type-only re-exports in a later phase — churn-free for consumers.

**Interface impact:** `ctx.storage`, `ctx.kv`, `ctx.vectors` keep the same public methods; host adapters implement the canonical interfaces.

### 5. Queue / scheduler / workflow host — **scheduler shipped, workflow pending**

- `QueueBindingLike` / `QueueMessageLike` / `MessageBatchLike` canonical types are in `@lunora/platform`.
- **`SchedulerHost`** (`schedule`/`cancel`/`cron`, at-least-once, retry policy) is shipped — the provider-neutral restatement of `@lunora/scheduler`'s DO-shaped interface.
- A `WorkflowHost` abstraction for `@lunora/workflow` is still pending (deferred; workflows are the least-portable subsystem).

**Interface impact:** Internal. Public `ctx.queues.<name>` and `defineWorkflow` APIs remain stable.

### 6. Durable key-value storage — **gap, blocks `SessionDO`**

`ShardHost` covers local SQL, transactions, alarms, and serialization — but not the KV-style `storage.put` / `get` / `delete` / `list` surface. `SessionDO` is built entirely on that surface, so it is the one Durable Object that cannot be re-bound to the current contracts. A `ShardKvStore` contract (`get`/`put`/`delete`/`list(prefix)`) is the missing piece; every candidate platform has an obvious backing (DynamoDB, Redis, a table in the local SQL store).

**Interface impact:** internal. `ctx.auth` session handling and `SessionDO`'s public RPC shape stay as they are.

### 7. Auth / secrets / config

- `ctx.secrets` (Cloudflare Secrets Store) needs a `SecretStore` interface.
- `ctx.auth` is already backed by Better Auth; only the D1 adapter is Cloudflare-specific.

### 8. Dev / deploy / CLI

The CLI and Vite plugin assume wrangler. A multi-platform Lunora needs:

- Host-specific dev-server plugins.
- Host-specific deploy commands.
- A host schema in `lunora.config.ts` or `wrangler.jsonc` successor.

---

## Recommendations

1. **Do not treat Rivet as a compatibility layer.** If the team wants a Rivet target, treat it as a separate runtime implementation, similar in scope to an AWS target.

2. **Adopt plan 114 before any new platform target.** The platform abstraction layer is a prerequisite. Without it, every new target requires forking the codebase.

3. **Pick one alternative target first.** AWS (plan 114 §§6–9) is the most credible because it has managed services for every Cloudflare primitive: Lambda + API Gateway for compute, DynamoDB / Aurora for state, SQS/SNS for queues, Step Functions for workflows, S3 for storage, ElastiCache / Redis for KV/session, and Bedrock/SageMaker for AI. Rivet is also credible but smaller ecosystem.

4. **Preserve the public API.** `defineSchema`, `query`, `mutation`, `action`, `.shardBy()`, `.global()`, and `ctx.*` should remain unchanged. Platform differences should be invisible to application code.

5. **Package restructure (naming scheme ratified 2026-07-23):** The platform family is split as:
    - `@lunora/platform` — contracts only (types + `PlatformCapabilities`; zero-dep). **Already created.**
    - `@lunora/platform-cloudflare` — the default host; existing Cloudflare packages (`@lunora/do`, `@lunora/d1`, `@lunora/storage`, `@lunora/queue`, …) gradually fold into it.
    - `@lunora/platform-aws` — the AWS host (plan 114 §7).
    - `@lunora/platform-node` — self-hosted/Node host (also serves local-first dev).
    - `@lunora/platform-conformance` — the behavioral TCK every host must pass.
    - `@lunora/shard-engine` — the host-neutral reactive engine extracted from `@lunora/do`.
    - Never subpath-export hosts from the contracts package (`@lunora/platform/aws`); each host carries its own provider deps and must stay installable in isolation.

6. **Keep the CLI Cloudflare-first for now.** A portable CLI is a large project. Defer it until at least one non-Cloudflare target is proven.

7. **Document the boundary.** Every package should declare whether it is host-agnostic or host-specific. This prevents accidental leakage of Cloudflare APIs into user-facing code.

---

## Alignment with Existing Plans

- **Plan 114 (`plans/114-multi-provider-platform.md`)** is the correct foundation. This assessment confirms the need for the `*Like` host contracts and the package restructure it proposes.
- **Plan 114's AWS half (§§6–9)** is the most concrete next step. AWS is the only alternative platform that offers a complete enough managed-serverless portfolio to host Lunora without major feature loss.
- This document should be read as supporting research for those two plans, not as a replacement.

---

## Next Steps (if proceeding)

### Done

1. ~~Review and ratify plan 114 (Platform Abstraction Layer).~~ Scheme ratified 2026-07-23 (`platform` + `platform-<target>`; engine = `@lunora/shard-engine`).

2. ~~Define the host contracts.~~ `@lunora/platform` ships `ShardHost`, `SocketHost`, `ShardDirectory`, `SchedulerHost`, canonical binding `*Like` types, and `PlatformCapabilities` (`CLOUDFLARE_CAPABILITIES`).

3. ~~Build `@lunora/platform-conformance` — the TCK asserting the host contract.~~ `defineHostContractSuite(name, factory, vitest)` covers `ShardHost` serialization/transactions/alarms, `SocketHost` accept/send/close + attachment round-trip + tagged fan-out, `ShardDirectory` deterministic placement, and `SchedulerHost` schedule/cancel. It runs against **both** hosts — the in-memory reference host and the Cloudflare adapters in real workerd (`packages/do/__tests__/workerd/cloudflare-host.workerd.test.ts`, 14 tests) — which closes plan 114's phase-1 gate ("TCK green on both hosts"). The suite's `it` is injectable precisely so the Cloudflare run can wrap every body in `runInDurableObject`.

    Host variance is expressed as presence-based optional hooks on `ConformanceHost` rather than skipped blocks, so a gap shows up in the suite output instead of vanishing: `createSocket` (what a "socket" is differs per host), `simulateRecycle`/`restoreSocket` (only hosts whose recycle a test can drive), `awaitAlarmFired` (Cloudflare fires alarms by waking a separate `alarm()` invocation, unobservable from inside the shard callback), and an optional `scheduler` (the Cloudflare scheduler lives in `@lunora/scheduler`, not `@lunora/do`).

    Engine-level behaviors (OCC-409 end-to-end, reactive poke ordering, RLS under live subscription) remain deferred until more of the engine is host-neutral.

4. ~~Extract the reactive engine from `@lunora/do` into `@lunora/shard-engine`~~ (move-only; `_generated/` goldens stay byte-identical). Moved:
    - Core engine: `dependency-tracker.ts`, `transaction.ts`, `geo.ts`, `not-found-error.ts`, `search-text.ts`, `where-types.ts`, `reactive-cache.ts`, `socket-pool.ts`, `types.ts` (subscription/socket types), `subscription-delivery.ts`, `rls-guard.ts`, `serialize-sql.ts`, `drizzle.ts` (render helpers), `where-sql.ts`.
    - Query/planning: `query-args.ts`, `rank.ts`, `aggregates.ts`, `aggregate-sql.ts`, `aggregate-tally.ts`, `relations.ts`, `relation-predicates.ts`.
    - Corresponding unit tests (and the reactive-cache bench) moved with them; DO-specific integration tests stayed in `@lunora/do` and import from `@lunora/shard-engine`. The `@lunora/do` barrel re-exports moved symbols so downstream packages keep compiling. Switched `@lunora/shard-engine`'s packem dts compiler to TypeScript (instead of oxc) to avoid isolated-declarations errors on the moved engine files.
    - `@lunora/sql-store` imports `NotFoundError` directly from `@lunora/shard-engine` (added dependency) to avoid a TypeScript re-export-chain issue in its large `ctx-db.ts` mirror.

5. ~~Extract the shared `*Like` schema/writer types~~ into `@lunora/shard-engine/src/schema-types.ts` (`TableDefinitionLike`, `DatabaseWriterLike`, `SchemaLike`, `QueryArgs`, `QueryPage`, `WithInput`, `RelationDefinitionLike`, `TriggerDefinitionLike`, `TriggerEventLike`, `TriggerContextLike`, `SchedulerLike`, `SchedulableWorkflowReferenceLike`, aggregate/rank/pagination types, etc.). `@lunora/do` imports these projections from `@lunora/shard-engine`, and `triggers.ts` re-exports the trigger-family types from the engine package. `SystemDatabaseReader` stayed Cloudflare/DO-specific and remains exported from `@lunora/do/system-reader`.

6. ~~Re-bind `ShardDO` to the host contracts.~~ `packages/do/src/cloudflare-host.ts` implements `createShardHost` / `createSocketHost` / `createShardDirectory` over `DurableObjectState` and `DurableObjectNamespace`, and `ShardDO` now goes through them rather than `state.*`:
    - `runInTransaction` composes `shardHost.runSerialized(...)` around `shardHost.transaction(...)` — the same `blockConcurrencyWhile` + `storage.transaction` pair as before, but expressed in contract terms. There is deliberately **no** raw `BEGIN`/`COMMIT` fallback: workerd forbids it inside a DO.
    - The WebSocket upgrade path calls `socketHost.accept(server, attachment)`, which accepts and stamps the attachment back-to-back so no frame can reach an unstamped socket.
    - `ShardRunner` (in `@lunora/shard-engine`) owns the `handleFetch` / `handleAlarm` seam; `ShardDO.fetch` / `.alarm` delegate through it while the Cloudflare-specific lifecycle is still injected as host handlers.
    - `SocketHandle.id` is stable across hibernation: the adapter mints an id tag at accept and reads it back via `state.getTags(ws)`, since Cloudflare exposes no native socket identifier that survives recycling.
    - Gate: 1139 `@lunora/do` tests (mocks + workerd projects) and the two-host TCK green; `lint:types` green across all 64 projects.

7. ~~Consolidate the package split.~~ The family shipped as four packages and
   two failed the deletion test: `@lunora/platform-cloudflare` had **zero
   consumers** (275 lines wrapping adapters that live in `@lunora/do`, dragging
   `@lunora/do` + `@lunora/scheduler` as deps), and
   `@lunora/platform-conformance`'s only dependency was the contracts package it
   asserts — meaning the TCK could version apart from the contracts.
   Consolidated to **two**: the TCK is now `@lunora/platform/conformance`
   (subpath; `/conformance/suite` stays workerd-pure, the barrel adds the
   `node:sqlite` reference host, root import stays types-only), and the
   composition root (`createShardPlatform`/`createWorkerPlatform`) lives in
   `@lunora/do` beside the adapters it composes, with the `SchedulerHost`
   adapter in `@lunora/scheduler` (it wraps `SchedulerDO`; the scheduler is now
   injected into `createWorkerPlatform`, killing the do→scheduler edge). Mint
   `@lunora/platform-<target>` when a second target exists — one host is a
   hypothetical seam.

### Open

7. ~~**Add a durable key-value contract (`ShardKvStore`).**~~ **Done.** `@lunora/platform` ships `ShardKvStore` (`get`/`put`/`delete`/`list({prefix})`) — the surface `ShardHost` deliberately omits, since a DO that keeps plain records wants ordered key lookup and prefix scans, not a SQL dialect. `SessionDO` is re-bound onto it plus the shared `ShardAlarms` (both built by `createShardKvStore`/`createShardAlarms` in `cloudflare-host.ts`), so the same session logic can run on any host that supplies a `ShardKvStore`. Covered by three new TCK cases (read-back, idempotent delete, exact prefix scan) that pass against both the reference host and the Cloudflare adapter in real workerd, and by a new GC-sweep unit test — the `list`/alarm path had no coverage before. Everything else left in `@lunora/do` is genuinely Cloudflare-specific and stays for now: `ctx-db.ts`, `ctx-db-*.ts`, `relation-fanout.ts`, `introspect.ts`, `shard-do.ts`, `shard-registry-do.ts`, and the relay tier.

8. **`ShardDO` runs on the contracts; `ShardRunner` is load-bearing.** All eight `getWebSockets` sites, all seven `waitUntil` sites, and all thirteen `state.id` reads now go through `SocketHost` / `ShardHost`. What is left on `state` is genuinely Cloudflare-only: `storage`, the hibernation auto-response, and `abort`. `ShardRunner` owns the host-neutral operations — `socketFor`, `sockets`, `background`, `shardKey`, `runInTransaction` — and `ShardDO` delegates 27 call sites to it. Breaking `socketFor` fails 17 tests across 7 files, so the runner is exercised rather than decorative.

    **The hard part was socket identity, and it is worth recording.** Five `WeakMap`s key per-socket state (subscription and shape memos, global-shape snapshots, stream cancellers, whisper rate buckets), plus the relay tier's cohort memos. Enumeration yields the host's `SocketHandle`; the runtime's message/close callbacks yield the provider's own socket. Keying those against each other misses every lookup **silently** — no error, just state that appears to vanish. Both entry points therefore resolve to the host's cached handle at the boundary, so a connection has one identity whichever path reached it. The invariant that makes the raw fallback safe: a socket the host cannot map is one enumeration cannot see either, so nothing else ever keys against it. An intermediate revision that converted only the message path failed seven tests (stream teardown, whisper echo, relay cohort pokes) — this is a real hazard, not a theoretical one.

    Three contract members made it possible: `ShardHost.shardKey` (shard identity for telemetry attribution), `SocketHandle.bufferedAmount` (delivery backpressure — `awaitWsDrain` polls it), and `SocketHost.handleFor` (the raw→handle bridge). Engine helpers are typed on the minimal structural surfaces they use — `ShardSocketLike`, `FrameSink`, `DrainableSink` — so a runtime socket and a `SocketHandle` both satisfy them, and widening a helper stays source-compatible for subclass overrides under parameter bivariance.

    **`ShardDirectory` has a production consumer too.** `@lunora/runtime` resolves every shard through the contract: `resolveShard` / `applyJurisdiction` adapt the Cloudflare-shaped `ShardNamespaceLike` to a `ShardDirectory` and delegate to `@lunora/platform`'s `resolveShard`, and the three previously hand-rolled `namespace.get(idFromName(…))` sites (scheduler completion, dynamic shard registry, health probe) route through it. The runtime uses a local structural adapter rather than `@lunora/do`'s `createShardDirectory` (which takes a real `DurableObjectNamespace`) — coupling the runtime to the Cloudflare host package would be the wrong edge, and the contract is the resolution authority either way.

9. **The SQL hot path is on the contract, and fixing it corrected the contract.** `ShardHost.sql` previously had zero consumers — `shard-do.ts` reached `state.storage.sql` 24 times and the contract not once — so the path the engine actually spends its time in was still bound to Cloudflare's `SqlStorage`. All 24 now route through it, the instrumented `get sql()` included, so per-statement sampling rides the seam instead of bypassing it.

    Doing it exposed that `ShardSqlExec` was wrong **in both directions**: it promised a `rowsAffected` nothing reads, and omitted `one()`, cursor iteration, and `databaseSize` — all of which the engine uses, with `toArray` merely optional. A second host could have satisfied that type and still failed at runtime, which is exactly the failure this contract exists to prevent. `ShardSqlCursor` now requires all three read shapes and the TCK asserts them. **This is the strongest argument for building a second host early: one implementation cannot tell you whether a contract is right.**

    What is left on `state` is genuinely Cloudflare-only: drizzle's Durable Object driver, the PITR bookmark APIs, `abort`, and the hibernation auto-response.

10. **Still open in phase 2: the request router itself.** `handleFetch` / `handleAlarm` remain injected Cloudflare handlers, so a second host can mount the _engine_ and its per-socket machinery but not the _request lifecycle_. Moving the router, subscription refresh, and poke protocol into `ShardRunner` is the remaining L-sized extraction, and `shard-do.ts` is still a ~9,300-line god-file.

    **Not measured:** the `__bench__` suites run under CodSpeed instrumentation, which emits no local timings, and none of them exercise `runInTransaction` — the path that gained closure hops. Plan 114's perf-regression watch is therefore still open; it needs either a bench over the transaction path or a CodSpeed CI baseline.

11. **Codegen is target-aware.** `@lunora/codegen` gained a `target` option (default `"cloudflare"`). It intersects the `discoverFeatureUsage` probe with the target's `@lunora/platform` capability matrix: a used feature the target marks `unsupported` is dropped from the emitted `ctx.*` surface (by flipping its `has*` flag off before emission, reusing the existing conditional-emit machinery) and reported as a `platform_unsupported_feature` diagnostic on `CodegenResult.platformDiagnostics`; the CLI `codegen` command surfaces them like advisories. `emulated`/`native` emit as-is; an unknown target emits the full surface un-gated with a `platform_unknown_target` diagnostic (fail-safe — never omit against a matrix we don't have). The default Cloudflare target marks nothing unsupported, so the gate is the identity and the goldens are byte-identical. This gives `CLOUDFLARE_CAPABILITIES` its first production consumer. (The end-to-end omission against a _real_ second target is unexercised until a non-Cloudflare matrix exists; the gate itself is unit-tested against a synthetic matrix, and the omission mechanism is the same `has*`-flag path the existing goldens already cover.)

12. **Config inference/emission is split behind `DeployDriver`.** `@lunora/config` ships the provider-neutral `ResourceGraph` (shard namespaces, queues, workflows, containers, crons, global database, object storage, key-value store) and the `DeployDriver` contract, with `CLOUDFLARE_DRIVER` as the reference implementation delegating to the same `inferLunoraBindings` / `reconcileWrangler*` functions the CLI called directly before — so it is behavior-preserving by construction. `lunora prepare` now provisions through the driver and logs the neutral requirement summary.

    **A finding this surfaced:** `provision` deliberately does _not_ take a `ResourceGraph`. Writing real host config needs encodings (binding names, DO class wiring, migration tags) that the neutral graph discards, so a driver handed only the graph would have to re-derive them. `infer` is therefore the reporting surface and `provision` the doing surface, each owning its own inference. That says the neutral graph is **not** a sufficient intermediate representation for config emission — a future target needing one must add a host-extension escape hatch rather than pretend the graph already carries the detail.

    **The toolchain surface is done too.** `DriverToolchain` models the five host commands — `deploy`, `dev`, `tail`, `secretList`, `secretPut` — as pure argv builders over neutral requests (`preview`, `environment`, `temporary` are concepts, not wrangler flags). A driver only _describes_ a command; the CLI still owns running it, keeping package-manager resolution (`pnpm exec` / `npx --` / `bun x`) and the injected spawner its tests substitute. All seven wrangler call sites in `@lunora/cli` now build their argv through the driver, and the 684-test CLI suite — which asserts exact spawned argv — passes unchanged, which is the proof the routing is byte-identical.

    **Target selection ships.** `resolveDeployDriver(target)` resolves against a registry, defaulting to `"cloudflare"` so every existing project is unaffected. An unrecognized target **throws** rather than falling back — silently deploying to Cloudflare because `--target aws` was not recognized would ship an app to the wrong provider, the one failure mode this resolution must never have. `lunora deploy` and `lunora logs` accept `target`.

    **Decision on §5.3's open question** ("wrangler validator + `.dev.vars` → `@lunora/config/cloudflare`, or layer the driver on top — decide during execution"): **layer, do not move.** The plan explicitly warns against breaking `@lunora/cli` / `@lunora/vite` imports, and relocating those modules to a subpath would churn every consumer for no behavioral gain while only one target exists. The driver already provides the seam a second target needs; the physical file move can happen when a second target actually forces it.

    **Deliberately not routed:** the remaining `inferLunoraBindings` callers (`deploy`, `doctor`, `env`) need Cloudflare-specific detail the neutral graph discards on purpose — `doctor` reads `containers`, and `deploy`/`env` use `packageNamesFromBindings`, which is about npm packages rather than host resources. Forcing them through `infer` would lose information, so they correctly keep calling the Cloudflare-shaped inference directly.

13. **Create `@lunora/platform-cloudflare`** as the default composition root: re-export the adapters from `@lunora/do`, add the `@lunora/scheduler` host, and run the full four-contract TCK from one place (today's Cloudflare run reports `SchedulerHost` as a gap because `@lunora/do` has no scheduler to offer).

14. **Build `@lunora/platform-aws`** (plan 114 §7) as the first non-Cloudflare target.

15. **Update `lunorash` exports, the Vite plugin, and the CLI** to support host selection (`target` field, default `cloudflare`).
