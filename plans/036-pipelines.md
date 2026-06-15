# Plan 036: Pipelines (R2-backed streaming ingestion)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a "STOP conditions" item occurs, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 058071c8..HEAD -- packages/config/src/wrangler-validator.ts packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/codegen/src/discover-feature-usage.ts packages/storage/src`. If `WranglerConfig`'s binding-array shape or the `PROBES`/`FeatureUsage` map have diverged materially from "Current state", treat as STOP and re-baseline. **Also verify Pipelines is still a live, supported Cloudflare product with a stable `pipelines: [{ binding, pipeline }]` binding + `env.PIPE.send([...])` API before building** — this is a newer/maturing product and the binding/API shape is the most likely thing to have moved.

## Status

- **Priority**: P3 — honestly low. Pipelines is a newer, still-maturing Cloudflare product; it overlaps heavily with Analytics Engine (Plan 035) for "emit events from a worker," and the durable-ingestion-to-R2 use case is niche for the typical Lunora app. Convex has no analogue, so there's no parity pressure. Do Plan 035 (Analytics Engine) first; this is a follow-on once a concrete user need (high-volume event archival to R2 / downstream warehouse) appears.
- **Effort**: S — the binding surface is tiny (`env.PIPE.send([...])`), the package is a thin send-helper, and it leans on the existing `@lunora/storage` (R2) story for the sink. Most of the effort is the same binding-plumbing boilerplate as Plans 028/035.
- **Risk**: MEDIUM — chiefly _product_ risk (maturing API may break) rather than implementation risk. `send` is fire-and-forget; back-pressure/batching semantics are Cloudflare-owned and under-documented.
- **Depends on**: pairs with `@lunora/storage` (Plan-less existing package — the R2 sink). Shares all binding-plumbing patterns with **Plan 035 (Analytics Engine)**; build 035 first and copy its config/codegen structure.
- **Category**: feature (new Cloudflare binding support)
- **Planned at**: commit `058071c8`, 2026-06-15

## Verdict

**Build it lean, later, and be honest about its niche.** Ship a minimal `@lunora/pipelines` exposing `createPipeline({ binding })` → `ctx.pipeline.send(records)`, codegen-wired onto `MutationCtx`/`ActionCtx` (a write-only, fire-and-forget side effect — same determinism stance as Analytics Engine's `writeDataPoint`; **not** on `QueryCtx`). Reuse the binding validate/infer/reconcile and codegen patterns established by Plan 035 verbatim. Do **not** over-invest: no schema/transform DSL, no consumer-side R2 reader (the R2 output is consumed by the user's downstream tooling, or via `@lunora/storage`). If Plan 035 (Analytics Engine) is unbuilt, build that first — it covers the common "emit metrics" case more cheaply, and Pipelines only earns its place for durable, high-volume, R2-archived event streams.

## Pipelines vs Analytics Engine (decide which to reach for)

- **Analytics Engine** (Plan 035): low-latency, sampled, queryable via SQL API. Best for _metrics/observability_ (request counts, latencies, hot shards) → feeds Studio panels.
- **Pipelines**: durable, unsampled, batched ingestion that lands records in **R2** for downstream batch processing / warehousing. Best for _event archival / ETL_, not live dashboards.
- Lunora should offer both but steer users: "metrics → `ctx.analytics`; durable event archive → `ctx.pipeline`." State this in the docs so the two don't get conflated.

## Current state

- **No Pipelines support anywhere.** `packages/config/src/wrangler-validator.ts:65-83` (`WranglerConfig`) has no `pipelines` key (it lists `d1_databases`, `durable_objects`, `r2_buckets`, `vectorize`, `containers`, `workflows`, `tail_consumers`, `ai`).
- **Binding inference** (`packages/config/src/infer-bindings.ts`): no pipelines capability; `@lunora/pipelines` not in `capabilityForImportSource` (lines 164-186); `Capabilities`/`InferredBindings` (lines 117-148) unaware.
- **Reconcile** (`packages/config/src/reconcile-bindings.ts`): `WranglerShape` has no `pipelines`. A `pipelines: [{ binding, pipeline }]` entry references a **named pipeline resource that must be created out-of-band** (`wrangler pipelines create`) — like Hyperdrive's `id`, the `pipeline` name is a remote resource Lunora can't fabricate, so this is **hint-only, not auto-write** (contrast with Analytics Engine, which is self-describing and auto-writeable).
- **Feature-usage codegen** (`packages/codegen/src/discover-feature-usage.ts`): `PROBES` (lines ~48+) has no `pipeline` entry; `FeatureUsage` (lines 23-39) unaware.
- **Closest precedents**: `@lunora/storage` (`packages/storage/src/`) for the R2 sink relationship and as the package-shape template; `@lunora/d1` (`packages/d1/src/d1-client.ts:11-34`) for the structural-binding-projection pattern (`D1DatabaseLike`); **Plan 035** for every config/codegen step (this plan is deliberately a slimmer twin).
- **Missing**: the package, binding plumbing (validate/infer/reconcile, all hint-only for the remote `pipeline` name), and codegen ctx wiring.

## Item breakdown

- [ ] **Item 1: `@lunora/pipelines` package skeleton + `createPipeline` send helper.**
    - Create `packages/pipelines/` mirroring `packages/storage/` shape: `package.json` (`"@lunora/pipelines"`, ESM, `"sideEffects": false`, FSL-1.1-Apache-2.0, conditional exports for `.` + `./package.json`, scripts copied from storage, catalog-only deps — `@cloudflare/workers-types: catalog:cloudflare`, `typescript: catalog:tsc`, `@types/node: catalog:types`, `@visulima/packem: catalog:build`, `vitest: catalog:test`), `project.json` (`{ "name": "pipelines", "tags": ["type:package", "category:add-on"] }`), `tsconfig.json`, `vitest.config.ts`, `.releaserc.json`, `README.md`, `LICENSE.md`.
    - `src/types.ts`: structural `PipelineLike<Record> { send(records: Record[]): Promise<void> }` (mirror the real `Pipeline` binding, kept structural for plain-object test doubles — same approach as `D1DatabaseLike`). Make the record type a generic so users get typed payloads.
    - `src/create-pipeline.ts`: `createPipeline<Record>(binding: PipelineLike<Record>)` → `{ send(records: Record[]): Promise<void> }`. Thin passthrough; optionally a `sendOne(record)` convenience and a documented note that `send` is fire-and-forget/batched by Cloudflare (callers should `await` it inside actions, or use `ctx.waitUntil`-style deferral in mutations if the runtime exposes one — check `@lunora/runtime` before assuming).
    - `src/index.ts`: named-only barrel.
    - Test (`__tests__/create-pipeline.test.ts`, plain-Node Vitest — **not** worker-pool): fake binding records the `send` payload; assert passthrough + typing. workerd can't run in the sandbox — keep pure-Node; real-binding tests CI-only via `skipIf(!process.env.CI)`.

- [ ] **Item 2: wrangler validation for the `pipelines` binding.**
    - Edit `packages/config/src/wrangler-validator.ts`: add `pipelines?: ReadonlyArray<{ binding?: string; pipeline?: string } | null | undefined>` to `WranglerConfig` (lines 65-83). Add `validatePipelineBindings` (pattern of `validateVectorizeBindings`, lines 96-109): each entry needs a non-empty `binding` (error if missing) and a `pipeline` name (warn — without it the binding can't resolve a remote pipeline). Wire into `validateWranglerConfig`.
    - Test: validator `__tests__` malformed-entry case (missing `binding` → error; missing `pipeline` → warning).

- [ ] **Item 3: binding inference for `@lunora/pipelines` (hint-only).**
    - Edit `packages/config/src/infer-bindings.ts`: add `usesPipelines` to `Capabilities` (141-148), `NO_CAPABILITIES` (150), `mergeCapabilities` (152-161), `InferredBindings` (117-138). Branch in `capabilityForImportSource` (164-186): `@lunora/pipelines → { usesPipelines: true }`. Add `IMPORT_PIPELINES_PATTERN` and include in `regexCapabilities` (212-221). Emit a hint in `describeSignals` (457-508): `"hint: @lunora/pipelines is imported; run 'wrangler pipelines create <name>' and add a 'pipelines' binding ({ binding, pipeline }) — the pipeline resource can't be auto-provisioned"`.
    - Test: fixture importing `@lunora/pipelines` flips `usesPipelines` and emits the hint; no binding written.

- [ ] **Item 4: reconcile leaves Pipelines as a warning (no auto-provision).**
    - Edit `packages/config/src/reconcile-bindings.ts`: add `pipelines?: ReadonlyArray<{ binding?: string; pipeline?: string }>` to `WranglerShape`. **No `modify`/`applyEdits` write path** — the `pipeline` name is a remote resource (like Hyperdrive's `id` in Plan 028). When `usesPipelines` and no binding exists, return the Item-3 hint as a warning (same channel as R2/Hyperdrive). Document why in the JSDoc.
    - Test: reconcile with `usesPipelines: true` and no existing binding → returns warning, writes nothing.

- [ ] **Item 5: codegen wires `ctx.pipeline` (mutations + actions only).**
    - Edit `packages/codegen/src/discover-feature-usage.ts`: add `pipeline` to `FeatureUsage` and `PROBES.pipeline = { moduleSpecifier: "@lunora/pipelines", contextProperty: "pipeline" }`.
    - In `packages/codegen/src/emit.ts` + generated ctx types: add `pipeline: PipelineClient` to **`MutationCtx` and `ActionCtx`** only (write-only fire-and-forget side effect; NOT `QueryCtx` — same stance as Analytics Engine). Emit JSDoc: _"Pipelines ingestion sink (durable, R2-backed). Fire-and-forget and batched; do not read it back in-handler."_ Keep the codegen `.js`-extension rule (the one package where emitted `.js` is mandatory) and update golden fixtures.
    - Test: codegen golden where a mutation reads `ctx.pipeline` → `MutationCtx`/`ActionCtx` gain `pipeline`, `QueryCtx` does not. Update existing ctx-shape goldens.

- [ ] **Item 6: docs — Pipelines vs Analytics Engine, and the R2 sink.**
    - Add a docs page (follow `apps/` docs-site structure) leading with the "Pipelines vs Analytics Engine" decision matrix (from the section above), the `wrangler pipelines create` + `{ binding, pipeline }` setup, and how the R2 output relates to `@lunora/storage`. Be explicit that Pipelines is **newer/maturing** and lower-priority than Analytics Engine. Add a `lunora-setup-pipelines` skill only if the setup-skill convention warrants it (see `lunora-setup-storage`).

### Non-goals (state in docs)

- No transform/schema DSL over pipeline records (Cloudflare owns transform config).
- No consumer-side R2 reader for pipeline output (use `@lunora/storage` or the user's downstream tooling).
- No `ctx.pipeline` on `QueryCtx`.
- Do not duplicate metrics/observability use cases — steer those to `ctx.analytics` (Plan 035).

## Verification

```bash
pnpm --filter "@lunora/pipelines..." run build
pnpm --filter "@lunora/config..." run build
pnpm --filter "@lunora/codegen..." run build

pnpm --filter "@lunora/pipelines" run lint:types
pnpm --filter "@lunora/config" run lint:types
pnpm --filter "@lunora/codegen" run lint:types

pnpm --filter "@lunora/pipelines" run test
pnpm --filter "@lunora/config" run test
pnpm --filter "@lunora/codegen" run test

pnpm --filter "@lunora/pipelines" run lint:eslint
```

Expected: new package builds and exports `createPipeline`. Config validates (`binding` required, `pipeline` warn) and treats Pipelines as hint-only in infer/reconcile (no auto-write). Codegen adds `ctx.pipeline` to mutations/actions only.

> Reminder: `--filter … run test`/`lint:types` does not rebuild deps — use the `...` suffix or `pnpm run build:packages` once if you hit stale-`dist` errors.

## STOP conditions

- The drift check reveals Cloudflare's Pipelines binding/API has changed (no longer `pipelines: [{ binding, pipeline }]` / `env.PIPE.send([...])`), or the product has been deprecated/renamed — STOP and re-scope; this is the maturing-product risk called out in Status.
- `WranglerConfig` / `PROBES` / `FeatureUsage` restructured past the cited line references — re-baseline.
- A test requires a live worker or live Pipelines resource — STOP; keep tests pure-Node and mark real-binding tests CI-only (workerd can't run in the sandbox).
- Plan 035 (Analytics Engine) is unbuilt and the user's actual need is metrics/observability — STOP and redirect to Plan 035 rather than building Pipelines for that case.
- Scope creep into transform DSL or consumer-side R2 reading — STOP; both are explicit non-goals.
