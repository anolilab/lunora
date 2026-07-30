# Plan 114 — Multi-provider platform: host contracts, engine extraction, and the AWS target

> **Source:** Multi-cloud strategy session (2026-07-03), triggered by AWS shipping
> **AWS Blocks** (`aws-devtools-labs/aws-blocks`, preview June 2026) — AWS's own
> take on "typed backend + infra-from-code + local-first dev". Goal: restructure
> Lunora so the same app, same DX, and same observable behavior can deploy to
> Cloudflare **or** another provider, without changing anything for existing
> Cloudflare users.
>
> **This document merges former plans 114 and 115.** They were always one arc —
> 114 the provider-neutral half, 115 the AWS implementation consuming its seams —
> and splitting them meant every cross-reference had to be maintained twice, which
> is how the host-entry gap in §5.5 ended up recorded in neither. §§0–5 are the
> abstraction work, **largely shipped**; §§6–9 are the AWS target, **not started**.
>
> **Section numbering in §§0–5 is load-bearing** — source comments cite
> `plan §5.1` / `§5.2` / `§5.3`. Do not renumber them.
>
> Findings in §§0–2 come from a full-repo coupling audit (Explore agent,
> 2026-07-03, HEAD ≈ `2b50904e`). **Re-verify all anchors before executing.**
>
> **Positioning:** AWS Blocks validates the DX space but its realtime is
> best-effort pub/sub with no reactive queries, no OCC, no cross-block
> transactions. "The same app, deployed to Cloudflare or AWS, with reactive
> consistency neither platform gives you natively" is a stronger pitch than either
> single-cloud story — **iff** we preserve the behavioral contract (§3), not just
> the API shape.

## Status at a glance

| Part  | Scope                                                               | State                                               |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------- |
| §§0–4 | Audit, seams, behavioral contract, design decisions                 | Settled                                             |
| §5.1  | `@lunora/platform` contracts + capability matrix                    | **Shipped**                                         |
| §5.2  | Engine extraction (`@lunora/shard-engine`, `@lunora/observability`) | **Shipped**                                         |
| §5.3  | Config split + `DeployDriver`                                       | **Shipped**                                         |
| §5.4  | Conformance TCK, both hosts                                         | **Shipped**                                         |
| §5.5  | Codegen target awareness                                            | **Shipped**, except host-entry emission (see there) |
| §5.6  | Docs + parity governance                                            | **Shipped**                                         |
| §§6–9 | AWS target: analysis, hosting strategy, parity matrix, toolchain    | **Not started**                                     |

## 0. Headline audit finding

The codebase is **far less hard-wired to Cloudflare than its feature set
suggests**, because of one existing discipline: **no shipped source file imports
`cloudflare:workers`, and no class `extends DurableObject`.** Every Cloudflare
runtime type is re-declared locally as a structural interface
(`DurableObjectStorageLike`, `D1DatabaseLike`, `ExecutionContextLike`,
`KVNamespaceLike`, …) and injected. The only `@cloudflare/workers-types`
references in shipped `src` are two **type-only** imports used for casts
(`packages/do/src/shard-do.ts:1`, `packages/d1/src/d1-client.ts:2`).

So the lock-in is **semantic** (code assumes DO-shaped guarantees: single-writer
isolate, in-process SQLite, hibernated WebSockets) rather than **syntactic**.
This plan's job is to promote the implicit structural contract into an explicit,
tested, versioned one — and to split the one package (`@lunora/do`) where
engine logic and Cloudflare binding are still fused.

**Caveat found 2026-07-03 (workers-types v5 check):** the "two imports" headline
understates the _ambient_ type-level dependency — ~20 packages load
`@cloudflare/workers-types` globally via their tsconfig `"types"` array,
including nominally platform-neutral ones (`client`, `sql-store`, `payment`,
`auth`, `mail`, `flags`; `workflow`/`queue` even use the `/experimental`
entrypoint). Their `Request`/`Response`/`WebSocket`/crypto globals resolve to CF
types today. Workstream 5.1 should include scrubbing the ambient entry from
packages rated **none/light**, replacing it with `lib: ["DOM"]`-safe or
`@lunora/platform` types — otherwise "platform-neutral" is only true at the
value level. (Catalog is on `^5.20260703.1` — the v5 major only removed dated
entrypoints and keeps `/experimental`, so it was a one-line catalog bump,
orthogonal to this plan.)

## 1. Per-package coupling map (audit, 2026-07-03)

| Package                                                                                         | Coupling                              | What couples it                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lunora/server`, `@lunora/values`, `@lunora/client`, react/vue/solid/svelte, `@lunora/codegen` | **none**                              | Platform-neutral, confirmed. Only doc-comments + local string-union types (`DurableObjectJurisdiction = "eu"\|"us"\|"fedramp"` is local in `packages/server/src/types.ts:25`, not a CF import). Codegen only _emits strings_ referencing CF; it calls no CF API.                                                                    |
| `@lunora/runtime`                                                                               | **light**                             | Worker/DO idioms (fetch/scheduled/queue entry, `idFromName`/`.get`/stub, `env.*`) but entirely via local structural types; `ExecutionContextLike` is local. No `ctx.storage`, no `.storage.sql`.                                                                                                                                    |
| `@lunora/d1`                                                                                    | **light** (D1-specific by definition) | D1 binding surface (`.prepare`/`.batch`/Sessions `withSession`) behind `D1DatabaseLike`; one type-only CF import.                                                                                                                                                                                                                   |
| `@lunora/do`                                                                                    | **DEEP**                              | The real lock-in. Full DO runtime surface: `state.storage.sql` (~20 sites), `blockConcurrencyWhile`, hibernated WebSockets (accept/message/close + `serializeAttachment`), alarms, PITR, `state.storage.transaction()`. Decoupled only structurally.                                                                                |
| `@lunora/config`                                                                                | **DEEP** (by design)                  | It _is_ the wrangler layer: `wrangler.jsonc` validator (`wrangler-validator.ts`, pins `REQUIRED_COMPATIBILITY_DATE`), binding inference (`infer-bindings.ts`), `.dev.vars` grammar (`dev-variables-format.ts`). Declares `wrangler` as a real dep.                                                                                  |
| `@lunora/cli`                                                                                   | **DEEP**                              | Shells out to project-local `wrangler` via `pnpm exec wrangler …`: `deploy` → `wrangler deploy`/`versions upload` (`commands/deploy/handler.ts:832`); `dev` → `wrangler dev` (`commands/dev/handler.ts:163`); also `secret put`, `tail`, `containers push`, `versions rollback`. **Spawn is already injectable** (`util/spawn.ts`). |
| `@lunora/vite`                                                                                  | **DEEP**                              | Wraps `@cloudflare/vite-plugin` directly (`src/index.ts:1` import, `:151` `cloudflare(cloudflareOptions)`), with an existing opt-out (`cloudflare: false`).                                                                                                                                                                         |
| `@lunora/scheduler`                                                                             | **DEEP**                              | `Scheduler` interface over `DurableObjectNamespaceLike` — fundamentally DO-shaped.                                                                                                                                                                                                                                                  |
| `@lunora/storage`, `@lunora/container`, `@lunora/bindings/*`, `@lunora/queue`                   | **light–moderate**                    | Structural `*Like` projections of specific CF bindings (R2, Containers, KV/Vectorize/Analytics/Images/Pipelines/R2SQL, Queues). Replaceable per-binding, but each mirrors one CF primitive's shape.                                                                                                                                 |

## 2. Existing abstraction seams (the porting assets — do not reinvent)

These already-clean adapter interfaces are what makes this plan an extraction,
not a rewrite:

- **SQL dialect seam — the flagship.** `SqlDialect`
  (`packages/sql-store/src/dialect.ts:43`) + `SqlExec` (`:37`) parameterize a
  single drizzle-orm core (`createSqlCtxDb`). **Already ships three dialects:**
  `sqliteDialect` (`packages/d1/src/sqlite-dialect.ts:28`), `postgresDialect` +
  `mysqlDialect` (`packages/hyperdrive/src/global-dialect.ts:66,119`). Proves
  the data layer is genuinely engine-neutral.
- **DO-internal storage seam.** Inside `@lunora/do` the ORM/reactive logic never
  touches `ctx.storage` directly — it goes through an injected
  `SqlExec { exec() }` (`packages/do/src/ctx-db.ts:96`, via `CtxDbOptions.sql`).
  `ShardDO` (`packages/do/src/shard-do.ts:2527`) is the **sole** bind point of
  `state.storage.sql` to it. That single bind point is the seam this plan cuts.
- **`AuthStore`** (`packages/auth/src/store.ts:151`) + nested `SqlExecutor`
  (`packages/auth/src/sql-store.ts:151`); only `d1Executor` (`:314`) is
  CF-specific.
- **`PaymentAdapter`** (`packages/payment/src/adapter.ts:38`, Stripe + Polar) +
  `PaymentStore` (`store.ts:14`) — zero CF coupling.
- **`SqlClient` + `from{PostgresJs,NodePg,Mysql2}`** driver adapters
  (`packages/hyperdrive/src/types.ts:74`); only the Hyperdrive _binding_
  extraction is CF-shaped.
- **`MailTransport`** (`packages/mail/src/types.ts:17`), **`RateLimitStore`**
  (`packages/ratelimit/src/types.ts:100`), **`ObservabilitySink`**
  (`packages/runtime/src/observability-sinks.ts:81`), **`LunoraAi`** over the
  Vercel AI SDK (`packages/ai/src/types.ts:83`) — clean single-purpose seams.
- **CLI spawn injection** (`packages/cli/src/util/spawn.ts`) — the deploy/dev
  commands don't import wrangler, they spawn it; a second deploy driver slots in
  behind the same injection point.

## 3. The behavioral contract that must be preserved (what any host must provide)

Per-shard guarantees, as implemented today (this is the contract the
conformance suite in §5.4 encodes):

1. **Mutation serialization** — single-threaded DO isolate +
   `state.storage.transaction()` (`shard-do.ts:2671`; note at `:2690`: workerd
   forbids raw `BEGIN`/`COMMIT`) + `blockConcurrencyWhile` input gate (`:2716`).
2. **OCC** — compare-and-swap in `runGuardedWrite` (`ctx-db.ts:1497`):
   UPDATE/DELETE carries the read-time `__doc__` snapshot in WHERE, then
   `SELECT changes()`; `0` → `ConflictError(kind:"occ")`. **No server retry
   loop** — 409 to client (deliberate; see the pinned OCC-retry memory).
3. **Reactive subscriptions** — read-set dependency tracking
   (`dependency-tracker.ts`) → in-memory `ReactiveCache` keyed by
   function+args+**identity** (`reactive-cache.ts:396`); changed-table fan-out:
   `flushChangedTables` (`shard-do.ts:5962`) defers via `waitUntil`,
   `refreshSubscriptions` (`:6115`) re-runs only subs whose read-tables
   intersect the changed set. Shape subs use the SQLite `__cdc_log` op-log with
   per-socket cursors + `pokeStart/pokePart/pokeEnd` (`:6466`).
4. **Hibernated WebSockets** — `acceptWebSocket` (`:7351`) + all sub state on
   `serializeAttachment` (`:7369`); in-memory memos are `WeakMap`s rebuilt on
   wake.
5. **Sharding & fan-out** — `resolveShard` → `idFromName`
   (`resolve-shard.ts:65`); cross-shard fan-out merges in
   `query-coordinator.ts` (`fanOut:365`, k-way `rankPage` merge); the elastic
   relay tier (`relay.ts`, `relay-hub.ts`) sheds fan-out invisibly.

Properties 1–4 are cheap on Cloudflare **only because compute and storage share
one single-threaded isolate**. Any alternative host must either reproduce that
colocation (an actor with local SQLite) or accept a coarser reactivity model.
This plan does not decide the AWS answer (the AWS half (§§6–9) does); it makes the contract
explicit so both hosts implement the same one.

## 4. Design decisions

- **D1 — Injection over conditional exports.** AWS Blocks switches
  implementations via custom Node export conditions (`cdk`, `aws-runtime`).
  Lunora already achieves the same via structural typing + DI and via codegen
  sitting between user code and the runtime. Keep DI; use **codegen target
  awareness** (§5.5) as the user-visible switch. Less resolution magic, and the
  emitted `_generated/` stays inspectable.
- **D2 — Contracts get their own package; engine gets extracted.** New
  `@lunora/platform` (types + tiny helpers only, near-zero runtime code) and
  the reactive engine extracted out of `@lunora/do` (working name
  `@lunora/shard-engine`). `@lunora/do` remains the Cloudflare host of the
  engine — public API unchanged, so existing apps and `_generated/` output are
  untouched.
- **D3 — Capability tiers are first-class, not an afterthought.** Full parity
  on day one is impossible (`ctx.browser`, PITR, jurisdictions). The platform
  contract carries a **capability matrix**; codegen enforces it in types per
  target (a `ctx.*` absent on the target simply doesn't exist on the emitted
  ctx types, with a diagnostic pointing at the matrix).
- **D4 — Conformance suite (TCK) is the management backbone.** One behavioral
  suite asserting §3 (serialization, OCC-409 semantics, read-your-writes, poke
  ordering, offline replay, RLS-under-subscription identity) that **every** host
  must pass in CI. `@lunora/testing`'s `lunoraTest` harness plus the workerd
  gate (`LUNORA_WORKERD_TESTS=1`, `packages/runtime/__tests__/workerd/`) is
  ~70% of the scaffolding.
- **D5 — Deploy layer becomes a driver interface, not a rewrite of
  `@lunora/config`.** `@lunora/config`'s binding _inference_ (schema/defineX →
  required resources) is provider-neutral in spirit; only its _emission_
  (wrangler.jsonc reconcile) is CF-specific. Split inference from emission; a
  deploy driver consumes the inferred resource graph and emits provider config
  (wrangler.jsonc today; CDK in the AWS half (§§6–9)).
- **D6 — Relocation is not the porting mechanism.** The recurring question is
  "shouldn't `@lunora/bindings` / `storage` / `scheduler` move into
  `@lunora/platform-cloudflare`, since they wrap Cloudflare primitives?" No —
  and the test is empirical rather than a judgement call. Counting _real_ import
  statements (not doc-comment mentions) of `@cloudflare/*` or `cloudflare:*` in
  each package's `src/`:

    | Package                                                                    | Provider imports in `src/`                   |
    | -------------------------------------------------------------------------- | -------------------------------------------- |
    | `bindings`, `storage`, `browser`, `hyperdrive`, `scheduler`, `d1`, `queue` | **0**                                        |
    | `container`                                                                | 2, already isolated behind the `/do` subpath |

    Those seven are facades over the `*Like` contracts, which is exactly what §8
    assumes: `ctx.kv` becomes DynamoDB _behind `KVNamespaceLike`_, `ctx.storage`
    becomes S3. The facade is the neutral part; only the injected binding differs.
    Moving them would (a) break every app, since these are direct installs —
    `examples/blog` depends on `@lunora/bindings` and imports
    `@lunora/bindings/kv`; (b) invert the layering, making the host adapter a
    public surface when app code never imports it; and (c) force each new host to
    reimplement the facade instead of supplying a binding.

    **The rule:** provider differences are handled by `*Like` injection plus the
    capability matrix (D3), not by moving packages. When a package does carry real
    provider code, isolate that part behind a subpath — `@lunora/container/do`
    holds `LunoraContainer` (which pulls `cloudflare:workers`) while the root stays
    neutral. The dividing line is **"does app code import it?"**: if yes it stays a
    facade; if it is reached only through a contract it belongs in the host package.

## 5. Workstreams

### 5.1 `@lunora/platform` — the host contract package (S–M)

New package (remember the pnpm-overrides gotcha: add
`"@lunora/platform": "workspace:*"` to `pnpm-workspace.yaml` overrides or
installs 404). Contents — **types + conformance fixtures only**, near-zero
runtime:

- `ShardHost` — single-writer execution slot per shard key: `runSerialized(fn)`
  (input-gate semantics), `transaction(fn)` (ACID, auto-rollback, no raw
  BEGIN/COMMIT), `sql: SqlExec` (local, synchronous-ish reads), `alarms`
  (`setAlarm`/`getAlarm`/`deleteAlarm`), `waitUntil`.
- `SocketHost` — `accept(ws, attachment)`, `getSockets(tag?)`,
  `serializeAttachment`/`deserializeAttachment`, send/close; explicit
  contract note that attachment state must survive host recycling
  (hibernation on CF, process restart elsewhere).
- `ShardDirectory` — `idForName(name, opts)` + `get(id)` → stub-like RPC
  surface + placement hints (jurisdiction/region → provider-mapped, may be
  unsupported per capability matrix).
- `SchedulerHost` — the `Scheduler` interface currently DO-shaped in
  `@lunora/scheduler`, restated provider-neutrally (runAfter/runAt/cron,
  at-least-once, dead-letter).
- Binding host interfaces — promote the existing `*Like` types
  (`KVNamespaceLike`, R2, Queues, Vectorize, Analytics, `ExecutionContextLike`,
  `D1DatabaseLike`, …) from their per-package homes into `@lunora/platform`
  as the canonical copies; per-package copies become re-exports (type-only, so
  this is churn-free for consumers).
- `PlatformCapabilities` — the capability matrix type: per-feature
  `"native" | "emulated" | "unsupported"` (+ notes), consumed by codegen (§5.5)
  and docs.
- Ambient-types scrub (per §0 caveat): remove `@cloudflare/workers-types` from
  the tsconfig `"types"` arrays of packages rated **none/light**.

**Non-goal:** no runtime registry/plugin loader. Hosts are ordinary
constructor arguments, as today.

- **Done.** All five contracts ship, plus `PlatformCapabilities`. The binding
  `*Like` promotion is complete and the per-package copies really are
  re-exports — `@lunora/bindings/kv`, `@lunora/storage` and `@lunora/d1` import
  their `*Like` types from `@lunora/platform` rather than redeclaring them, and
  `ExecutionContextLike` is re-exported from `shared/`. `SchedulerHost` grew
  `list` + `deadLetter` during §5.4, because at-least-once was otherwise
  unassertable (see there).
- **Ambient-types scrub: done for the **none** tier and `@lunora/runtime`.**
  `@lunora/d1` keeps `@cloudflare/workers-types` in its tsconfig `"types"` for
  the **test tier only** — its workerd suite calls Cloudflare's typed
  `Response.json<T>()` overload, which is not in lib.dom and which
  `@cloudflare/vitest-pool-workers/types` does not supply. Its `src/` no longer
  imports the provider types at all: the two drizzle-driver casts now target
  drizzle's own `AnyD1Database`. A breadcrumb in `packages/d1/tsconfig.json`
  records this, since a CF import reappearing under `src/` is the regression it
  guards. The remaining 15 packages holding the ambient types are rated
  DEEP or light–moderate (per §1) and keep them by design.

### 5.2 Extract the reactive engine from `@lunora/do` (L, the core workstream)

Move the host-neutral engine into `@lunora/shard-engine` (name bikesheddable):

- `ctx-db.ts` (already `SqlExec`-injected), `dependency-tracker.ts`,
  `reactive-cache.ts`, the `__cdc_log` op-log + poke protocol, `relations.ts`,
  `socket-pool.ts`, relay logic (`relay.ts`, `relay-hub.ts`) — everything that
  today only _happens_ to live beside the DO binding.
- `shard-do.ts` shrinks to the **Cloudflare host**: implements
  `ShardHost`/`SocketHost` over `state.storage` + hibernation APIs and
  instantiates the engine. Target: the two type-only
  `@cloudflare/workers-types` imports end up only here.
- `SessionDO`, `SchedulerDO` follow the same split where cheap; don't force it
  in phase 1.

**Constraints:**

- `@lunora/do`'s public exports, codegen-emitted class names, and wire behavior
  are **frozen** — this is a pure internal re-layering. Golden `_generated/`
  fixtures must stay byte-identical.
- `shard-do.ts` is a known god-file (Wave-4 TECH-01 deferred exactly this
  split); this plan is the design doc TECH-01 asked for. Execute as a
  move-only refactor first (no logic edits), then the host-interface cut.
- Watch the workerd suites: hibernation/eviction tests
  (`evictDurableObject` body-drain gotcha per memory) are the regression net.

**Status — done, with the god-file split taken to its floor rather than to zero.**

- The engine lives in `@lunora/shard-engine` (answering §8.1); the Cloudflare host
  moved to `@lunora/platform-cloudflare`. `shard-do.ts` is down to the **two**
  type-only `@cloudflare/workers-types` references this section targeted.
- The frozen surface held throughout: **305 names**, diffed name-for-name against
  the pre-move build, `api:check` reporting declaration-site relocations and zero
  removals. Codegen goldens byte-identical.
- Host-neutral code that was still in `@lunora/do` afterwards is out: twelve
  modules (~2,800 lines — admin export/import, data migrations, PITR, SQL console,
  settings, TTL sweep, four external-source ingest modules, mail + queue catchers)
  moved to the engine, git recording each as a 95–99% rename. Test count conserved
  exactly: `602 + 653` became `501 + 754`.
- `shard-do.ts` went 9,703 → 8,562 lines by lifting ~1,100 lines of admin-RPC
  argument parsing into `admin-rpc-args.ts`, move-only as prescribed. **It stops
  there deliberately.** What remains is one class of 273 members averaging 18
  lines (largest 319) — no oversized method to break up. Two further cuts were
  measured and rejected: extract-class on telemetry (43 members, 798 lines) would
  have to publish all 11 of its fields because `handleFetchCloudflare`,
  `readAdminWildcardOp`, `dispatchLifecycle`, `recordShapeError` and
  `handleRecordContainerEvent` touch them — a struct behind an indirection, not
  encapsulation; and free-functioning the low-coupling methods nets ~200 real
  lines once the 37 three-line abstract hooks a codegen subclass overrides are
  excluded. `handleFetchCloudflare`/`handleAlarmCloudflare`/`webSocketClose`/
  `webSocketError` cannot leave either — the platform invokes them on the
  instance. The residue is a request entry point legitimately reaching telemetry,
  admin and subscription state, which is the host-interface cut's business rather
  than more moving. Do not re-attempt a mechanical split without redoing those
  two measurements.
- `SessionDO` / `SchedulerDO` splits not done — explicitly "don't force in
  phase 1", and still deferred.
- Observability came out too, as `@lunora/observability`. Its two largest modules
  (`function-metrics`, `issue-explainer`) had arrived without suites of their own
  and now have them, both at 100% on all four metrics; the package's coverage
  ratchet went from a 70/65/68/70 placeholder to 76/84/89/89.

### 5.3 Split `@lunora/config`: inference vs. emission (M)

- Extract the provider-neutral **resource graph** (what the app needs: shard
  namespaces, queues, buckets, KV, crons, containers, secrets, vars) from
  `infer-bindings.ts` into a `DeployDriver`-agnostic model in
  `@lunora/platform` (or a `@lunora/config` subpath).
- Define `DeployDriver`: `infer(project) → ResourceGraph` (shared),
  `reconcile(graph, existingConfig)`, `emit(graph) → files`,
  `deploy/dev/tail/secret` command surfaces (consumed by the CLI through the
  existing spawn injection).
- The wrangler validator + `.dev.vars` machinery becomes
  `@lunora/config/cloudflare` (or stays put with the driver interface layered
  on top — decide during execution; **do not** break `@lunora/cli`/`@lunora/vite`
  imports).

    **Decided: stays put — and this is the one open edge of D6.** `@lunora/config`
    exports only `.` and `./studio-host`; `cloudflare-driver.ts` sits beside the
    neutral `deploy-driver.ts` and `driver-registry.ts` with no subpath boundary.
    Defensible today because the driver _interface_ is the seam and the registry
    makes a second driver additive — but it is the one place provider code lives in
    a nominally neutral package, which is precisely the arrangement D6 rejects
    elsewhere. Left unsplit deliberately: with one driver, `@lunora/config/cloudflare`
    is a seam nothing exercises, the same argument that defers the host-entry switch
    in §5.5. **Revisit in phase 8**, when `@lunora/aws` gives the split a second
    consumer to prove it against.

- `@lunora/cli`: `deploy`/`dev` route through the driver; `--target`/config
  field selects it (default `cloudflare`, so zero behavior change).
- **Done.** `lunora.json` gains a `target` key beside `remote`; `--target` is
  declared on `codegen`, `dev`, `prepare`, `deploy`, and `logs`, its help text
  generated from the driver registry. `resolveProjectTarget(projectRoot,
explicit)` is the single resolution point — flag, then config, then default.
  One point on purpose: codegen tailors the emitted `ctx.*` surface to a target
  while deploy picks the driver that ships it, and resolving those separately
  lets them disagree. The Vite plugin resolves the same way, so `vite build`
  and `lunora deploy` agree without configuring each.
- An unregistered target is **rejected, never defaulted** — all five commands
  resolve through `resolveTargetOrThrow`, including codegen, which resolves no
  driver of its own and would otherwise emit the full Cloudflare surface
  un-gated for a nonexistent target and exit 0.

### 5.4 Conformance suite — `@lunora/platform-conformance` (M)

- A vitest suite parameterized by a host factory, asserting §3 end-to-end:
  serialized mutations (no interleaving observable), OCC snapshot-CAS → 409
  (no retry), read-your-writes, table-fanout + shape-poke ordering
  (`pokeStart/Part/End` framing, per-socket cursor resume), attachment
  round-trip across simulated recycle, RLS identity under live subscription
  (the `cb632cd7` regression), scheduler at-least-once + dead-letter.
- **Split across two suites, and the split is forced rather than chosen.**
  `@lunora/platform/conformance` asserts what a HOST provides; the engine-level
  legs need `createShardCtxDb`/`relay-hub`, which live in `@lunora/shard-engine`,
  and `@lunora/platform` is zero-dependency by contract — importing the engine
  from there would invert the dependency and cycle. So the engine legs ship as
  `@lunora/shard-engine/conformance`, and a host is proven only when it passes
  both.
- **Status.** OCC-409 ✅ (plus the trigger-recursion ceiling, which is a
  _different_ `ConflictKind` and must stay distinct). Shape-poke ordering +
  per-socket cursor resume ✅. RLS identity under live subscription ✅ — pinned
  at the relay tier's uniformity gate, where the failure mode is a cohort
  multicast computed under the anonymous identity reaching an identity-scoped
  subscriber. All ten legs run against **both** hosts: the platform reference
  host (`packages/shard-engine/__tests__/engine-conformance.test.ts`) and real
  workerd through `createShardPlatform`
  (`packages/do/__tests__/workerd/engine-conformance.workerd.test.ts`).
- **Scheduler at-least-once + dead-letter** ✅, after growing the contract. It
  was initially unassertable: `SchedulerHost` was `{schedule, cancel, cron?}` —
  enqueue and cancel only, so at-least-once was promised in the module
  docstring and stated nowhere a test could reach. It now carries an optional
  `list` (pending jobs as `ScheduledJobStatus`, which is where `attempts`
  lives) and `deadLetter` (`list` + `requeue`). These describe RPCs
  `SchedulerDO` already serves — `/list`, `/dead`, `POST /dead/retry` — so the
  contract has a real Cloudflare implementation behind it and not only a
  reference one; `Scheduler` gained `dead`/`deadRetry` to expose them.
- The legs assert the invariants any host must uphold **however** it implements
  retries: a pending job reports `attempts: 0`; the pending and dead-letter
  listings are disjoint in both directions (park and requeue); requeue restores
  a fresh budget; requeue of an unparked id is `false`. Plus the two
  enqueue-side ones: `cancel` answers truthfully on a second call, and two
  identical schedules get independently cancellable ids (a host keying jobs by
  payload silently drops the survivor — a caller that enqueued twice and
  cancelled once is owed one delivery).
- `ConformanceHost.simulateDeadLetter` drives the transition, following
  `simulateRecycle`'s convention. **The retry _policy_ is deliberately not in
  the contract** — how many failures and what backoff before parking is host
  policy, and only the observable outcome is contract-level. Extracting
  `SchedulerDO`'s policy host-neutrally (§7 open question 2) remains open and is
  now an optimization rather than a prerequisite.
- Reference host: the existing in-memory `lunoraTest` harness (it _is_ the
  spec's executable form today).
- CI: run against (a) in-memory reference, (b) workerd/miniflare (gated,
  `LUNORA_WORKERD_TESTS=1`), (c) any future host (the AWS half's Node host).
  Studio/jsdom exclusion conventions from memory apply.

### 5.5 Codegen target awareness (M)

- `lunora.config` (or codegen options) gains `target: "cloudflare" | …`
  (default `"cloudflare"`; absent = today's output, byte-identical goldens).
- **Done**, and reachable — but the first attempt wired 5 of ~9 places and the
  claim that every call site passed a target was wrong. `runCodegen` now
  resolves the target itself from `lunora.json` when the caller passes none, so
  a missed call site emits the project's surface rather than the default one
  silently. The reader lives in `@lunora/codegen` (config depends on codegen,
  not the reverse) and `@lunora/config` delegates to it.
- Error-level diagnostics (`platform_unknown_target`,
  `platform_unsupported_feature`) **fail the command**. Both are declared
  `level: "error"` because each drops or misdirects an emitted surface; printing
  them as warnings with exit 0 was the root cause the target validation had been
  patching around. Surfaced in `codegen`, `prepare`, the dev watcher, and the
  Vite plugin — the last of which had never read `platformDiagnostics` at all.
- Codegen consumes the target's `PlatformCapabilities`: ctx surfaces for
  unsupported features are omitted from emitted types with a diagnostic
  (`platform_unsupported_feature`, advisor-style, pointing at the matrix);
  `"emulated"` features emit as-is.
- Follow the existing feature-probe pattern (`discoverFeatureUsage`) — the
  probe already knows which `ctx.*` the app uses; intersect with the matrix.
- Umbrella (`lunorash`) and granular imports both unaffected for the default
  target.

**What target awareness does NOT yet cover — the other half of D1.** §5.5 gates
the emitted `ctx.*` _surface_ on the target. It does not gate the emitted _host
entry_, and two facts make that visible the moment a second target exists:

1. `packages/codegen/src/emit.ts` emits the `ShardDO` subclass and the worker
   entry **target-blind** — there is no target in that file. `--target aws` would
   still generate a Durable Object.
2. `lunorash` depends on `@lunora/do` unconditionally, and `@lunora/do` depends on
   `@lunora/platform-cloudflare`. So every umbrella project installs the
   Cloudflare host whatever its target says.

Neither is a packaging bug to fix by making `@lunora/platform-cloudflare`
optional: per D2 `@lunora/do` **is** the Cloudflare host, and a Cloudflare host
that optionally depends on Cloudflare is incoherent. The switch belongs where D1
put it — codegen emits the host entry for the selected target, so an AWS project
gets the Node host and never pulls `@lunora/do` at all.

Deliberately not built here. With one host it would be an abstraction nothing
exercises, which is the failure mode this whole plan is organized against — the
seam is only real once phase 6 produces the Node host to switch to.
Doing it then also answers the umbrella question with evidence rather than
guesswork: either `lunorash` grows a host-free entry, or the target templates stop
depending on the umbrella.

### 5.6 Docs + parity governance (S)

- Document the platform contract + capability matrix in `packages/platform/docs/`
  (tracked source convention — generated docs tree is gitignored).
- Add a **"platform parity" section to the plan template**: every new
  `ctx.*`/binding feature states its mapping (or explicit non-support) per
  target. This is the process control that keeps the matrix honest.

- **Done.** `packages/platform/docs/index.mdx` documents the contracts, the
  capability matrix, the conformance split, and how to add to the matrix.
- The parity section landed in a plan template that **did not previously exist** —
  `plans/` had an index (`README.md`) and no template, so there was nothing to add
  the section to. `plans/TEMPLATE.md` now exists and `plans/README.md` points new
  plans at it, with the parity section marked mandatory for anything touching a
  `ctx.*` surface, a provider binding, or a deploy/runtime capability, and an
  explicit "not applicable" required otherwise so silence is never the answer.

## 6. AWS Blocks analysis (what exists, what to borrow)

Repo: `aws-devtools-labs/aws-blocks` (Apache-2.0, TS, preview; docs at
`docs.aws.amazon.com/blocks`). Core model:

- A **Block** = one npm package bundling runtime code + a **local
  implementation** + the **CDK construct** that provisions it.
  `new KVStore(scope, 'todos')` is an in-memory store under `npm run dev`, a
  DynamoDB table at synth, DynamoDB SDK calls in Lambda.
- Switching mechanism: **Node conditional exports with custom conditions**
  (`cdk`, `aws-runtime`) — same import, different file per context.
- **IFC layer** (`aws-blocks/index.ts`): backend entry that is simultaneously
  local server, infra definition, and Lambda handler. `ApiNamespace` = typed
  frontend→backend RPC, no codegen. Optional `index.cdk.ts` escape hatch for
  raw CDK constructs.
- **Sandbox**: `npm run sandbox` = per-developer ephemeral AWS stack with
  Lambda hot-swap (seconds); `sandbox:destroy` tears down.
- Blocks: `KVStore`/`DistributedTable`/`Database` (DynamoDB et al.),
  `FileBucket` (S3), `AuthBasic/AuthCognito/AuthOIDC`, `AsyncJob`/`CronJob`,
  `Agent`/`KnowledgeBase`, `Realtime`, `EmailClient`, observability blocks,
  `Hosting`. Native client codegen (Kotlin/Swift/Dart) from `blocks.spec.json`.
- **Realtime block** = API Gateway WebSocket + DynamoDB;
  `publish`/`subscribe`/`getChannel` over Zod-typed namespaces; **delivery is
  best-effort, no buffering, no query reactivity**. Warning in their docs:
  renaming a Block ID deletes+recreates the resource (data loss) — resource
  identity is a real footgun we must handle better (§4).

**Borrow:** the sandbox concept (per-dev ephemeral stack, hot-swap), the
CDK-escape-hatch shape (user-extendable generated stack), infra-from-code
discipline (we already do this via binding inference — plan §5.3).
**Reject:** conditional-exports switching (codegen + DI already covers it,
plan 114 D1) and their realtime model (far below Lunora's contract).

## 7. Strategy decision — how to host the shard tier on AWS

The entire difficulty concentrates in replacing the ShardDO (§3: single
writer per key, storage colocated with compute, hibernated sockets,
transactions, op-log pokes). Options evaluated:

### 7.1 REJECTED (unless spike surprises): self-host workerd on AWS

Run Cloudflare's OSS runtime (Apache-2.0, supports Workers + DOs) on an
ECS/EC2 fleet. Near-perfect parity, zero engine changes — but you inherit the
control plane Cloudflare does **not** open-source: DO placement/migration,
durable storage replication, and **WebSocket hibernation, which is a platform
feature, not part of OSS workerd**. You rebuild the hard parts underneath
workerd instead of beside it. Keep as a 1-day sizing spike; expect to
document as investigated-and-rejected.

### 7.2 REJECTED: serverless decomposition

Lambda + SQS FIFO (message-group = shard) for serialized mutations + DynamoDB
/Aurora state + API Gateway WS + DynamoDB connection registry. Every reactive
re-run becomes a Lambda invocation reading **remote** storage; read-set
tracking's economics die (§3 note); fan-out = N `PostToConnection` calls;
`TransactWriteItems` changes the OCC shape; hibernated-socket semantics
disappear. Ships something measurably different → violates "same behavior".

### 7.3 RECOMMENDED: stateful single-writer actor fleet (Node host)

An ECS/Fargate (or EC2 ASG) fleet running a **Node host of the extracted
engine** (§5.2):

- **Shard ownership:** lease table (DynamoDB conditional writes) + consistent-
  hash routing; at-most-one active owner per shard key. Lease fencing tokens
  guard against split-brain writes.
- **Storage:** embedded SQLite per shard on local NVMe/EBS, continuously
  replicated to S3 (Litestream-style WAL shipping) for durability; restore-on-
  ownership-move. Keeps reads in-process → read-set tracking, OCC CAS, and
  `transaction()` semantics carry over ~1:1.
- **Sockets:** WebSockets terminate on the same fleet behind an NLB; the
  engine's in-memory socket set and relay tier work as on CF. "Hibernation"
  becomes ordinary idle sockets on a long-lived process + attachment state
  persisted so an ownership move can migrate/resume subscriptions.
- **Stateless work:** `action`s (and optionally cold queries) can run on
  Lambda; only the shard tier is stateful.
- Fits the scale-invisibly principle: all of this is CDK-generated and
  autoscaled; the user sees `lunora deploy --target aws`.

### 7.4 SPIKE FIRST: build §7.3 on an existing OSS actor platform

Before hand-rolling 2.3, spike **Rivet Actors** (positions itself as
open-source Durable Objects; DO-like state/alarms/WebSockets; runs on own
infra) as the `ShardHost` implementation — if its DO-compat is real it
collapses the hardest workstream, and the 114 seam keeps it swappable.
Also evaluated: **Restate** (virtual objects give per-key serialization +
durable state, but KV-shaped state can't hold a SQLite DB per shard →
reactive engine rework; decline unless Rivet fails), **Temporal/DBOS**
(durable execution, wrong shape for realtime; rejected).

### 7.5 LATER (separate plan): Postgres-native backend

Aurora/RDS/Neon with `pg_advisory_xact_lock(hash(shardKey))` for per-shard
single-writer, logical-replication CDC → poke service, table-level
invalidation. Least infra to operate, most behavioral drift (remote reads →
coarser reactivity, different OCC shape). A legitimate **second** AWS backend
for "just RDS" shops, but starting with it means maintaining two consistency
models forever. Out of scope here; file separately if demanded.

## 8. Platform parity — service mapping and capability matrix

| Lunora surface                       | Cloudflare                  | AWS mapping                                                                                                                                                                       | Tier                                    |
| ------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Shard tier (`ctx.db`, subs, shapes)  | Durable Objects (SQLite)    | §7.3 actor fleet (ECS/Fargate + SQLite + S3 WAL) or Rivet (§7.4)                                                                                                                  | native (via our tier)                   |
| `.global()` tables                   | D1 + Sessions API           | Aurora Postgres / RDS (dialects **already exist**: `postgresDialect`/`mysqlDialect` in `packages/hyperdrive/src/global-dialect.ts`); read-your-writes via a session/bookmark shim | native                                  |
| WebSocket transport                  | CF edge + hibernation       | NLB → actor fleet (sockets colocated)                                                                                                                                             | emulated (no hibernation billing model) |
| `ctx.kv`                             | Workers KV                  | DynamoDB (or ElastiCache) behind `KVNamespaceLike`                                                                                                                                | native                                  |
| `ctx.storage` (R2)                   | R2                          | S3 (R2 is S3-compatible; mostly config) + presigned URLs                                                                                                                          | native                                  |
| `ctx.queues`                         | Queues                      | SQS (FIFO where ordering declared); consumer = Lambda or fleet worker                                                                                                             | native                                  |
| `@lunora/workflow`                   | CF Workflows                | Step Functions **or** fleet-native durable execution — own design pass; Step Functions' step semantics ≠ CF's memoized `step.do`                                                  | emulated                                |
| `@lunora/scheduler`                  | SchedulerDO + Cron Triggers | EventBridge Scheduler → invokes shard tier; cron via EventBridge rules                                                                                                            | native                                  |
| `ctx.ai`                             | Workers AI (AI SDK v6)      | Bedrock via `@ai-sdk/amazon-bedrock` — nearly free, `@lunora/ai` is provider-agnostic already                                                                                     | native                                  |
| `ctx.vectors`                        | Vectorize                   | S3 Vectors / OpenSearch Serverless                                                                                                                                                | emulated                                |
| `ctx.mail`                           | Resend transport            | SES `MailTransport` (~20 lines per audit)                                                                                                                                         | native                                  |
| `ctx.containers`                     | CF Containers               | ECS tasks (`defineContainer` → task defs)                                                                                                                                         | emulated                                |
| `ctx.sql` (Hyperdrive)               | Hyperdrive binding          | RDS Proxy; driver adapters (`fromNodePg`/`fromPostgresJs`/`fromMysql2`) unchanged                                                                                                 | native                                  |
| `ctx.analytics`                      | Analytics Engine            | Kinesis Firehose → Timestream/Athena                                                                                                                                              | emulated                                |
| `ctx.pipelines` / `ctx.r2sql`        | Pipelines / R2 SQL          | Firehose / Athena                                                                                                                                                                 | emulated                                |
| `ctx.images`                         | Cloudflare Images           | S3 + Serverless Image Handler / Lambda@Edge                                                                                                                                       | emulated                                |
| `ctx.browser`                        | Browser Rendering           | no clean managed equivalent                                                                                                                                                       | **unsupported** (v1)                    |
| `ctx.flags`                          | Flagship provider           | OpenFeature stays; AWS AppConfig provider slot-in                                                                                                                                 | native                                  |
| `ctx.secrets`                        | Secrets Store               | AWS Secrets Manager / SSM Parameter Store                                                                                                                                         | native                                  |
| Jurisdiction pinning                 | DO jurisdictions            | region pinning via placement hints (coarser)                                                                                                                                      | emulated                                |
| PITR                                 | DO storage PITR             | S3-versioned WAL snapshots (coarser granularity)                                                                                                                                  | emulated                                |
| Auth (`@lunora/auth`)                | D1-backed AuthStore         | `AuthStore`/`SqlExecutor` over Aurora/RDS (only `d1Executor` is CF-specific)                                                                                                      | native                                  |
| Payments / ratelimit / observability | adapters                    | already provider-neutral (`PaymentAdapter`, `RateLimitStore`, `ObservabilitySink` → CloudWatch sink)                                                                              | native                                  |

The 8 hardest replications, per the coupling audit: single-writer-per-key with
lock-free local state; storage colocated with compute; hibernated WS at scale;
in-process `getWebSockets()` enumeration; `storage.transaction()` semantics;
the DO-shaped scheduler; the wrangler/vite toolchain trio; relay tier +
jurisdiction pinning. §7.3 answers the first five with one component (the
actor fleet); the rest are the toolchain (§9) and scheduler (§8 row) work.

## 9. Toolchain — `@lunora/aws` deploy driver

Implements plan 114's `DeployDriver` (§5.3):

- **Emission:** inferred resource graph → a **generated CDK app** (synthesized
  into the project, user-extendable via an `index.cdk.ts`-style escape hatch —
  the one aws-blocks idea worth copying directly). Resource **identity must be
  stable** across renames where possible (learn from their Block-ID data-loss
  footgun: derive physical names from schema identity + explicit migration
  path, warn via advisor lint on rename).
- **CLI:** `lunora deploy --target aws` → `cdk deploy` through the existing
  spawn injection (`packages/cli/src/util/spawn.ts`); `lunora sandbox` /
  `sandbox destroy` = per-dev ephemeral stack with Lambda/fleet hot-swap;
  `secret put` → Secrets Manager; `tail` → CloudWatch Logs tail.
- **Local dev:** the Node actor host **is** the local dev server for
  `target: "aws"` — better prod parity than miniflare-for-AWS, and it double-
  serves as the conformance-suite host (§5.4) and a workerd-free test
  runner for the whole repo. `@lunora/vite` gains an AWS mode that skips
  `@cloudflare/vite-plugin` (the `cloudflare: false` opt-out already exists at
  `packages/vite/src/index.ts:151`) and mounts the Node host.
- **Config:** no `wrangler.jsonc`; the driver reconciles a
  `lunora.aws.jsonc` (or CDK context) equivalent; `.dev.vars` grammar is
  provider-neutral and carries over.

## 10. Phasing & ordering

Phases 0–4 are the abstraction layer and have shipped; phases 5–10 are the AWS
target. Every phase needs a gate that can fail.

| Phase | Work                                                                                                                                                                                                                                                 | Gate                                                                                                       | State       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| 0     | `@lunora/platform` types + capability matrix (§5.1); pnpm overrides entry                                                                                                                                                                            | `lint:types` green repo-wide; no runtime change                                                            | **Done**    |
| 1     | Conformance suite vs. in-memory + workerd hosts (§5.4)                                                                                                                                                                                               | TCK green on both; suite reviewed as _the_ contract                                                        | **Done**    |
| 2     | Engine extraction (§5.2), move-only then interface cut                                                                                                                                                                                               | TCK + full `@lunora/do` suite + workerd gate green; goldens byte-identical                                 | **Done**    |
| 3     | Config inference/emission split + `DeployDriver` (§5.3)                                                                                                                                                                                              | CLI `deploy`/`dev` behavior unchanged on CF; config tests green                                            | **Done**    |
| 4     | Codegen target flag + capability enforcement (§5.5); docs (§5.6)                                                                                                                                                                                     | default-target goldens byte-identical                                                                      | **Done**    |
| 5     | **Spikes (timeboxed):** (a) Rivet-as-`ShardHost` 2–3 days; (b) workerd-self-host sizing 1 day; (c) Litestream-style SQLite WAL→S3 restore drill 1–2 days                                                                                             | Written verdict per spike; pick §7.3 hand-rolled vs. Rivet-backed                                          | Not started |
| 6     | **Node actor host** of the extracted engine (single process: leases, local SQLite, sockets); no AWS yet. **Must also land the host-entry emission §5.5 defers**                                                                                      | Passes the TCK 100%; repo suites runnable on it without workerd; `--target` selects the emitted host entry | Not started |
| 7     | **Distribution:** lease table + fencing, consistent-hash routing, S3 WAL replication + ownership-move restore, NLB socket path                                                                                                                       | TCK green under forced ownership-moves + fault injection (kill -9 owner mid-mutation → no lost/dup write)  | Not started |
| 8     | **`@lunora/aws` deploy driver:** CDK emission, `deploy`/`sandbox`/`secret`/`tail`, Vite AWS mode + local Node-host dev. Also revisit §5.3's decision to leave `cloudflare-driver.ts` unsplit in `@lunora/config` — this phase is its second consumer | Playground app deploys + runs e2e on a real AWS account; sandbox create/destroy < 2 min                    | Not started |
| 9     | **Binding add-ons** per §8 mapping (KV/S3/SQS/SES/Bedrock/Secrets first; scheduler via EventBridge)                                                                                                                                                  | Per-binding conformance tests; capability matrix published; codegen enforces unsupported surfaces          | Not started |
| 10    | **Parity hardening:** `.global()` read-your-writes shim, relay tier on fleet, region pinning, PITR-equivalent snapshots; docs + template (`init --target aws`)                                                                                       | Full TCK + e2e matrix green on both clouds in CI (sandbox account)                                         | Not started |

Phase 6 is the first that needs a second host to exist, and it is where §5.5's
deferred host-entry emission stops being theoretical — see §5.5 for why the fix is
codegen (D1) rather than an optional `@lunora/platform-cloudflare` dependency (D2).

Workflows (`@lunora/workflow` → Step Functions vs. fleet-native) is **explicitly
deferred** to its own plan — the step-memoization semantics don't map 1:1 and
deserve a dedicated design.

## 11. Risks & STOP conditions

### Abstraction layer

- **STOP** if the engine extraction forces observable wire/protocol changes or
  non-byte-identical `_generated/` goldens — re-scope, don't improvise.
- **STOP** if `ShardHost.transaction` cannot express both workerd's
  `storage.transaction()` and a plain-SQLite BEGIN path without leaking
  provider conditionals into the engine — the interface is wrong; redesign.
- **Risk:** god-file split churn conflicting with parallel work on
  `shard-do.ts` (relay phase 4, plan 077 follow-ups). Mitigate: move-only
  commit lands fast; coordinate baseline.
- **Risk:** capability-matrix types leaking into `@lunora/server`'s public
  types. The server package must stay coupling-rating **none**; only codegen
  and platform packages know about targets.
- **Perf regression watch:** the extraction must not add indirection on the
  mutation/read hot path (the `SqlExec` seam already exists, so this should be
  free — verify with the `__bench__` suites).

### AWS target

- **STOP (phase 2)** if lease-fencing cannot rule out split-brain double-writes
  under partition in the fault-injection gate — the consistency story is the
  product; do not ship "usually single-writer".
- **STOP (phase 0/1)** if the engine (post-114-extraction) still needs CF-only
  semantics the Node host can't express — feed back into 114's interfaces
  rather than forking the engine.
- **Risk — operational surface:** an actor fleet is servers; we own upgrade,
  autoscale, and restore paths. Mitigation: CDK-managed, TCK + fault drills in
  CI, and the managed-control-plane option (Lunora Cloud deploying into the
  user's AWS account, SST-Console-style) as a product decision layered on the
  same driver — not a replacement for self-serve.
- **Risk — latency profile differs** (NLB hop, no edge PoPs). Publish honest
  numbers; don't claim CF-edge latency on AWS.
- **Risk — cost of parity drift over time.** Controls: capability matrix is
  code (codegen-enforced), TCK runs both hosts in CI, and the plan-template
  "platform parity" section (§5.6) gates every new feature.
- **Dependency risk (if Rivet path chosen):** external roadmap coupling —
  acceptable only behind the `ShardHost` seam with the hand-rolled fallback
  design kept current.

## 12. Open questions

### Answered during execution

1. Package name for the engine: `@lunora/shard-engine` vs. folding into
   `@lunora/do` with the host in a subpath (`@lunora/do/cloudflare`). The
   subpath variant avoids a new package (and the overrides gotcha) but keeps
   the misleading "do" name for neutral code.
2. Does `@lunora/scheduler` restate its interface in platform (thin) or move
   wholesale? Its `SchedulerDO` is a natural second engine-extraction candidate
   but can lag.
3. Where does the relay tier's placement logic (jurisdiction pinning,
   `resolve-shard.ts:50`) sit — engine (with host-provided placement hints) or
   host? Leaning: host provides `place(hint) → directory opts`, engine stays
   policy-free.
4. Is the umbrella package (`lunorash`) extended with `lunorash/platform`?
   Probably yes, mechanical.

### Open for the AWS target

1. Rivet vs. hand-rolled (phase 0 decides). Secondary: if Rivet, self-hosted
   only or also their cloud?
2. Fleet runtime: ECS/Fargate (simpler ops, slower ownership moves) vs. EC2
   ASG with local NVMe (faster SQLite, more ops). Lean Fargate first.
3. `.global()` on AWS: Aurora Serverless v2 vs. Aurora DSQL vs. RDS — pick per
   read-your-writes + connection-model needs (Sessions-API bookmark shim).
4. Does `lunora init` grow `--target aws` templates in v1, or is AWS
   migrate-an-existing-app only at first?
5. Sandbox account strategy for CI e2e (cost ceiling, teardown guarantees).
6. Native-client codegen (aws-blocks ships Kotlin/Swift/Dart) — out of scope
   here, but the `blocks.spec.json` idea overlaps with our OpenRPC surface;
   revisit after GA.
