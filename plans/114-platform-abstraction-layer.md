# Plan 114 — Platform abstraction layer: extract host contracts for multi-provider support

> **Source:** Multi-cloud strategy session (2026-07-03) triggered by AWS shipping
> **AWS Blocks** (`aws-devtools-labs/aws-blocks`, preview June 2026) — AWS's own
> take on "typed backend + infra-from-code + local-first dev". Goal: restructure
> Lunora so the same app, same DX, and same observable behavior can deploy to
> Cloudflare **or** another provider (AWS first — see **plan 115**), without
> changing anything for existing Cloudflare users.
>
> This plan is the **provider-neutral half**: what to move into new packages and
> which interfaces to formalize/harden. Plan 115 is the AWS implementation that
> consumes these seams. 114 is valuable standalone (Node-host testing without
> workerd, cleaner package boundaries) even if 115 never ships.
>
> Findings below come from a full-repo coupling audit (Explore agent,
> 2026-07-03, HEAD ≈ `2b50904e`). **Re-verify all anchors before executing.**

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
This plan does not decide the AWS answer (plan 115 does); it makes the contract
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
  (wrangler.jsonc today; CDK in plan 115).

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
  `LUNORA_WORKERD_TESTS=1`), (c) any future host (plan 115's Node host).
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

### 5.6 Docs + parity governance (S)

- Document the platform contract + capability matrix in `packages/platform/docs/`
  (tracked source convention — generated docs tree is gitignored).
- Add a **"platform parity" section to the plan template**: every new
  `ctx.*`/binding feature states its mapping (or explicit non-support) per
  target. This is the process control that keeps the matrix honest.

## 6. Phasing & ordering

| Phase | Work                                                                     | Gate                                                                                    |
| ----- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 0     | `@lunora/platform` types + capability matrix (5.1); pnpm overrides entry | `lint:types` green repo-wide; no runtime change                                         |
| 1     | Conformance suite vs. in-memory + workerd hosts (5.4)                    | TCK green on both; suite reviewed as _the_ contract                                     |
| 2     | Engine extraction (5.2), move-only then interface cut                    | TCK + full `@lunora/do` suite (~990 tests) + workerd gate green; goldens byte-identical |
| 3     | Config inference/emission split + `DeployDriver` (5.3)                   | CLI `deploy`/`dev` behavior unchanged on CF; config tests green                         |
| 4     | Codegen target flag + capability enforcement (5.5); docs (5.6)           | default-target goldens byte-identical; new target-flag goldens added                    |

Phases 0–2 are the prerequisite for plan 115 phase 1; phases 3–4 gate 115's
toolchain phases. Ship each phase independently on `alpha`.

## 7. Risks & STOP conditions

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

## 8. Open questions (answer during execution)

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
