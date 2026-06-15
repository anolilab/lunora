# Plan 035: Analytics Engine (write-side telemetry → Studio logs/advisors)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a "STOP conditions" item occurs, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 058071c8..HEAD -- packages/config/src/wrangler-validator.ts packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/codegen/src/discover-feature-usage.ts packages/codegen/src/emit.ts packages/advisor/src/index.ts packages/studio/src`. If `WranglerConfig`'s binding-array shape, the `PROBES`/`FeatureUsage` map, or the studio feature-gating surface have materially diverged from "Current state", treat as STOP and re-baseline.

## Status

- **Priority**: P1 — Analytics Engine is cheap, GA, and the natural write-side substrate for Lunora's observability story (Studio logs/advisors). Convex ships first-class function logs + usage dashboards; Lunora's Studio already has the _display_ surface (logs, advisors), so wiring a durable, queryable metrics sink closes a real parity gap with low cost.
- **Effort**: M — a small `@lunora/analytics` helper, codegen `ctx.analytics` wiring, binding validate/infer/reconcile, and a Studio query path against the SQL API. No new DO/runtime invariants.
- **Risk**: MEDIUM — `writeDataPoint` is fire-and-forget and sampled; the schema (blobs/doubles/indexes positional columns) is rigid and easy to misuse. The Studio SQL-API read path needs an account-scoped API token (a secret, not a binding) and is rate-limited — that auth/quirk surface is where the risk lives.
- **Depends on**: none. Synergises with the Studio logs feature and `@lunora/advisor` runtime lints.
- **Category**: feature (new Cloudflare binding support)
- **Planned at**: commit `058071c8`, 2026-06-15

## Verdict

**Build it.** Add `@lunora/analytics` exposing `createAnalytics({ binding })` → `ctx.analytics.writeDataPoint({ blobs, doubles, indexes })`, codegen-wired onto every ctx (write is cheap and safe everywhere, including queries — it's a side-effect-only telemetry emit, not a determinism hazard for _reads_, but see the determinism note below). The high-leverage half is the **read** path: a typed wrapper over the Analytics Engine **SQL API** that the Studio uses to render real usage/latency panels and that `@lunora/advisor` runtime rules (hot-shard, index-utilization) can feed from. Ship the write helper first (Items 1-5), then the Studio/SQL read integration (Items 6-7).

## Determinism note

`writeDataPoint` is a _write-only_, fire-and-forget side effect with no return value consumed by the handler, so emitting a data point does **not** make a `query`/`mutation` non-deterministic in the way `fetch`/`Date.now`/`Math.random` (which feed _reads_) do. It is still a side effect; to stay conservative and match Convex's "queries are pure reads" model, **default to wiring `ctx.analytics` on `MutationCtx` + `ActionCtx`** and gate it behind an opt-in for `QueryCtx`. Decide this explicitly in Item 5; do not silently allow telemetry writes from queries without a flag.

## Current state

- **No Analytics Engine support anywhere.** `packages/config/src/wrangler-validator.ts:65-83` (`WranglerConfig`) lists `d1_databases`, `durable_objects`, `r2_buckets`, `vectorize`, `containers`, `workflows`, `tail_consumers`, `ai` — **no `analytics_engine_datasets`** key.
- **Binding inference** (`packages/config/src/infer-bindings.ts`): `Capabilities` (lines 141-148) / `InferredBindings` (117-138) / `capabilityForImportSource` (164-186) have no analytics entry; `@lunora/analytics` is not in the import map.
- **Reconcile** (`packages/config/src/reconcile-bindings.ts`): `WranglerShape` has no `analytics_engine_datasets`. Unlike R2/Hyperdrive, an AE dataset binding has **no remote id to mint** — `analytics_engine_datasets: [{ binding, dataset }]` is fully self-describing (the `dataset` name is user-chosen and created lazily on first write), so this binding _can_ be auto-reconciled like the DO bindings, not just hinted.
- **Feature-usage codegen** (`packages/codegen/src/discover-feature-usage.ts`): `PROBES` (lines ~48+) maps optional packages → `ctx.*`; no `analytics` probe. `FeatureUsage` (lines 23-39) feeds **both** codegen ctx-wiring and the **Studio nav gating** (`buildStudioFeatures`) — so an `analytics` flag here is what would light up a Studio "Analytics/Usage" panel.
- **Studio** (`packages/studio/src/`): has `features/`, `app/`, `components/`, `hooks/`, `lib/` — already renders logs + advisors. The display surface for AE-backed panels exists; the missing piece is a data source. The Studio is embedded by the CLI/Vite via `@lunora/config`'s studio-host (`packages/config/src/studio-host/`).
- **Advisor** (`packages/advisor/src/index.ts`): exports runtime lints `hotShard` (line 37), `indexUtilization` (38), `constraintValidator` (36) plus the `Advisor*` data types — these are the consumers that would query AE for live scan-attribution metrics.
- **Closest binding precedent**: the DO/D1 reconcile path in `reconcile-bindings.ts` (auto-writes self-describing bindings) for the _write_ side; for the _read_ side there is **no precedent for calling a Cloudflare REST/SQL API from Studio** — this is new surface and the riskiest part (Item 6).
- **Missing**: the package, binding plumbing, codegen ctx wiring, and the Studio SQL-API read path + token handling.

## Item breakdown

- [x] **Item 1: `@lunora/analytics` package skeleton + `createAnalytics` write helper.**
    - Create `packages/analytics/` mirroring `packages/storage/` shape exactly: `package.json` (`"@lunora/analytics"`, ESM, `"sideEffects": false`, FSL-1.1-Apache-2.0, conditional exports for `.` and `./package.json`, scripts copied from storage, catalog-only deps — `@cloudflare/workers-types: catalog:cloudflare`, `typescript: catalog:tsc`, `@types/node: catalog:types`, `@visulima/packem: catalog:build`, `vitest: catalog:test`), `project.json` (`{ "name": "analytics", "tags": ["type:package", "category:add-on"] }`), `tsconfig.json`, `vitest.config.ts`, `.releaserc.json`, `README.md`, `LICENSE.md`.
    - `src/types.ts`: structural `AnalyticsEngineDatasetLike { writeDataPoint(event: { blobs?: (string | ArrayBuffer | null)[]; doubles?: number[]; indexes?: (string | ArrayBuffer)[] }): void }` (mirror the real `AnalyticsEngineDataset`, kept structural for plain-object test doubles — same approach as `D1DatabaseLike` in `packages/d1/src/d1-client.ts:11-16`).
    - `src/create-analytics.ts`: `createAnalytics(binding: AnalyticsEngineDatasetLike)` → `{ writeDataPoint(event) }`. Enforce/document the AE limits (max 20 blobs, 20 doubles, **1 index** — Cloudflare's per-data-point cap; reject/warn on overflow). Optionally provide an ergonomic `track(name, { dims, metrics })` that maps a named-field object to positional `blobs`/`doubles`/`indexes` and records the field→column mapping in a returned `schema` descriptor (so the read side can reconstruct named columns — AE's SQL API only exposes `blob1..blob20`/`double1..double20`/`index1`).
    - `src/index.ts`: named-only barrel.
    - Test (`__tests__/create-analytics.test.ts`, plain-Node Vitest — **not** worker-pool): fake dataset records the event object; assert positional mapping and limit enforcement. workerd can't run here — keep pure-Node; real-binding tests CI-only via `skipIf(!process.env.CI)`.

- [x] **Item 2: wrangler validation for `analytics_engine_datasets`.**
    - Edit `packages/config/src/wrangler-validator.ts`: add `analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string } | null | undefined>` to `WranglerConfig` (lines 65-83). Add `validateAnalyticsBindings` (pattern of `validateVectorizeBindings`, lines 96-109): each entry needs a non-empty `binding` (error if missing); `dataset` defaults to the binding name on Cloudflare's side, so a missing `dataset` is a **warning** ("dataset defaults to binding name; set it explicitly to avoid drift"), not an error. Wire into `validateWranglerConfig`.
    - Test: malformed-entry case in the validator `__tests__` (missing `binding` → error; missing `dataset` → warning).

- [x] **Item 3: binding inference for `@lunora/analytics`.**
    - Edit `packages/config/src/infer-bindings.ts`: add `usesAnalytics` to `Capabilities` (141-148), `NO_CAPABILITIES` (150), `mergeCapabilities` (152-161), `InferredBindings` (117-138). Branch in `capabilityForImportSource` (164-186): `@lunora/analytics → { usesAnalytics: true }`. Add `IMPORT_ANALYTICS_PATTERN` and include it in `regexCapabilities` (212-221). Also add an `env.AE`-style usage probe mirroring `ENV_AI_PATTERN`/`ENV_DB_PATTERN` (line 74-75) **only if** a conventional binding name is settled (prefer keying off the `@lunora/analytics` import + `ctx.analytics`, since the binding name is user-chosen). Signal in `describeSignals` (457-508).
    - Test: fixture importing `@lunora/analytics` flips `usesAnalytics`.

- [x] **Item 4: reconcile auto-writes the `analytics_engine_datasets` binding.**
    - Edit `packages/config/src/reconcile-bindings.ts`: add `analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string }>` to `WranglerShape`. Because the binding is **self-describing (no remote id)**, follow the DO/D1 auto-write path (`modify`/`applyEdits`, idempotent, comment-preserving): when `usesAnalytics` and no entry exists, write `{ binding: "ANALYTICS", dataset: "<app>_events" }` (choose a stable default binding/dataset name; document it). Idempotent by name like the existing reconcile entries.
    - Test: reconcile with `usesAnalytics: true` and no existing binding writes exactly one entry; a second run is a no-op (idempotency assertion, matching existing reconcile tests).

- [x] **Item 5: codegen wires `ctx.analytics` (mutations + actions; queries gated).**
    - Edit `packages/codegen/src/discover-feature-usage.ts`: add `analytics` to `FeatureUsage` (and its JSDoc note that it also feeds Studio nav gating, like the other entries) and `PROBES.analytics = { moduleSpecifier: "@lunora/analytics", contextProperty: "analytics" }`.
    - In `packages/codegen/src/emit.ts` + generated ctx types: add `analytics: AnalyticsClient` to **`MutationCtx` and `ActionCtx`**. For `QueryCtx`, gate behind an explicit opt-in (see "Determinism note") — default off. Emit JSDoc: _"Analytics Engine telemetry sink. Fire-and-forget and sampled; do not read it back in-handler."_ Keep the codegen `.js`-extension rule (this is the one package where emitted `.js` is mandatory) and update golden fixtures.
    - Test: codegen golden where a mutation reads `ctx.analytics` → `MutationCtx`/`ActionCtx` gain `analytics`; `QueryCtx` does not (without the opt-in). Update existing ctx-shape goldens.

- [x] **Item 6: Studio + SQL-API read path (the load-bearing half).**
    - Add the read client. Decide placement: a `src/sql-api.ts` in `@lunora/analytics` (so both Studio and advisor can import it) wrapping the AE **SQL API** (`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`, body = SQL text, `Authorization: Bearer <token>`). The client needs `accountId` + an **API token** — this is a _secret_, not a binding; it must come from `.dev.vars`/env, **never** auto-scaffolded with a real value (mirror the `@lunora/payment` secret-hint ethos in `infer-bindings.ts:83-89`). Surface a hint in inference: "set `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Analytics Read) in `.dev.vars` to enable Studio analytics panels."
    - In `packages/studio/src/features/`: add an analytics/usage feature gated by the `FeatureUsage.analytics` flag (via `buildStudioFeatures`), querying the SQL-API client for top panels (request volume per function, p50/p95 latency, hot shards). Reuse existing logs/advisors UI primitives in `packages/studio/src/components/`.
    - Test: unit-test the SQL-API client with a mocked `fetch` (plain-Node): asserts URL/headers/body shape and result parsing; no live network. Studio component tests follow the existing studio test conventions; skip anything needing a live worker (sandbox limit).

- [x] **Item 7: advisor runtime rules consume AE metrics.** Shipped as `loadAnalyticsRuntimeMetrics` in `@lunora/advisor` (`packages/advisor/src/ae-metrics.ts`): a structural `AnalyticsMetricsSource` (the `createAnalyticsSqlClient` `query(sql)` shape) reconstructs the `shardTraffic`/`tableScans`/`indexHits` lint inputs from AE (un-sampled `sum(_sample_interval)` per documented `AE_METRIC_EVENTS` contract), degrading each metric to `[]` on a failed query. Studio's `deriveRuntimeAdvisories` gains an optional `analyticsMetrics` input that prefers a non-empty AE array over the in-DO counter and falls back when absent. Tests: `packages/advisor/__tests__/ae-metrics.test.ts` (6) + 2 studio override/fallback cases.
    - Wire `hotShard` / `indexUtilization` (`packages/advisor/src/index.ts:37-38`) to accept an AE-derived metrics source via the Item-6 SQL client, so runtime advisors can be backed by real scan-attribution data instead of (or in addition to) the planned in-DO counters. Keep it optional — the advisors must still function with no AE token configured (degrade to static/in-DO signals). Add a focused test that, given a stubbed metrics source, the runtime lint produces the expected finding.

### Non-goals

- No custom dashboard/charting engine in Studio beyond the existing primitives (reuse logs/advisors UI).
- No real Cloudflare API calls in tests (token-gated, rate-limited; always mock `fetch`).
- No automatic creation of the API token (it's a secret the user provisions).

## Verification

```bash
pnpm --filter "@lunora/analytics..." run build
pnpm --filter "@lunora/config..." run build
pnpm --filter "@lunora/codegen..." run build
pnpm --filter "@lunora/studio..." run build
pnpm --filter "@lunora/advisor..." run build

pnpm --filter "@lunora/analytics" run lint:types
pnpm --filter "@lunora/config" run lint:types
pnpm --filter "@lunora/codegen" run lint:types
pnpm --filter "@lunora/studio" run lint:types
pnpm --filter "@lunora/advisor" run lint:types

pnpm --filter "@lunora/analytics" run test
pnpm --filter "@lunora/config" run test
pnpm --filter "@lunora/codegen" run test
pnpm --filter "@lunora/studio" run test
pnpm --filter "@lunora/advisor" run test

pnpm --filter "@lunora/analytics" run lint:eslint
```

Expected: new package builds and exports `createAnalytics` + the SQL-API client. Config validates (`binding` required, `dataset` warn) and auto-reconciles a self-describing `analytics_engine_datasets` entry. Codegen adds `ctx.analytics` to mutations/actions (queries gated). Studio shows a feature-gated analytics panel backed by mocked SQL-API in tests. Advisor runtime lints accept an AE metrics source and degrade gracefully without a token.

> Reminder: `--filter … run test`/`lint:types` does not rebuild deps — use the `...` suffix or `pnpm run build:packages` once if you hit stale-`dist` errors.

## STOP conditions

- Drift check shows `WranglerConfig` / `PROBES` / `FeatureUsage` / `buildStudioFeatures` restructured past the cited references — re-baseline.
- A test requires a live Cloudflare SQL-API call or a live worker — STOP; mock `fetch` and mark worker tests CI-only (sandbox can't run workerd).
- Any path auto-scaffolds a real `CLOUDFLARE_API_TOKEN` value into `.dev.vars` — STOP; tokens are user-provisioned secrets (hint only).
- The Studio panel hard-fails (rather than degrading) when no AE token is configured — STOP; the analytics panel must be optional.
