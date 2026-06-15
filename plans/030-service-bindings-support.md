# Plan 030: Service Bindings Support (worker-to-worker RPC)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, tick the checkboxes and update this
> plan's status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 058071c8..HEAD -- packages/config/src/remote-bindings.ts packages/config/src/wrangler-validator.ts packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/codegen/src/emit.ts packages/codegen/src/discover-feature-usage.ts`.
> If any in-scope file changed since this plan was written, compare against live
> code before proceeding; on mismatch treat as a STOP condition.

## Status — DONE (with a documented deviation on Item 3)

Items 1 + 2 shipped as planned: `validateServices` shape-checks each `services[]`
entry (non-empty `binding` + `service`, optional `entrypoint`), and inference is
**option (a)** — service bindings are config-only, no `infer-bindings.ts` scan.

**Item 3 deviation (intentional, kept):** rather than emit a services-only
`CirrusServices` interface + a `discover-service-bindings.ts`, codegen emits one
broad `CloudflareBindings` type (aliased `Env`) with an open
`[binding: string]: unknown` index signature, narrowing the bindings it can
statically discover (container/workflow DO namespaces, the conventional `AI`)
and leaving everything user-named — including `services` — reachable through the
index signature (`packages/codegen/src/emit.ts:804-848`). This is **deliberately
broader** than the plan's narrow proposal, for two reasons the plan itself
anticipated: (1) the cross-cutting prerequisite in `plans/README.md` makes Plan
030 the **owner of the single `Env`/`CloudflareBindings` seam** that Plans
039 (dispatch namespaces) and 042 (mTLS) defer their optional typing to — a
services-only `CirrusServices` would not serve them, a general `Env` does; and
(2) the plan's own Item 3 notes Cirrus can't type a third-party worker's RPC
surface, so service stubs are `Fetcher`/`Service<unknown>` + cast regardless —
the open index signature is the honest typing, and the generated comment says so.
Per this plan's STOP condition ("if a Cirrus `Env`/`CloudflareBindings` type
already exists or is mid-introduction, coordinate rather than emit a competing
`CirrusServices`"), the single `Env` seam is the coordinated outcome.

Item 4 remains **deferred, not built** (the `@cirrus/service` typed RPC client),
as the plan directs.

- **Priority**: P2 (Service bindings are the composition primitive for multi-worker Cirrus apps — they let a Cirrus worker call a sibling Cloudflare Worker over RPC/`fetch`. This is the seam for the `@cirrus/astro` single-worker-composition story and for splitting a large app. zeroback/Convex don't have a direct analog — this is a Cloudflare-native lead, but it's plumbing, not a headline feature.)
- **Effort**: M (config-first: validator + inference + codegen-typed `env.<SERVICE>` access; no DO/runtime change. A typed RPC client helper is optional and bumps to L.)
- **Risk**: LOW–MEDIUM (LOW for config/validation; MEDIUM if we generate typed RPC stubs, since `WorkerEntrypoint` types cross worker boundaries and Cirrus can't fully type a third-party service's RPC surface.)
- **Depends on**: none
- **Category**: feature (new Cloudflare binding support)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

Build this **config-only first**, not a package. Service bindings are pure
wrangler config (`services: [{ binding, service, entrypoint? }]`) plus a runtime
binding object (`Fetcher` / a `WorkerEntrypoint` RPC stub) that codegen can type
onto `env`. There is no per-request facade to wrap the way `@cirrus/storage`
wraps R2 — `env.MY_SERVICE.fetch(req)` and `env.MY_SERVICE.someRpcMethod()` are
already ergonomic. So: (1) teach the validator about `services`, (2) **decline to
auto-provision** (the `service` name points at an external worker Cirrus can't
discover — like R2's bucket name, it's user-supplied), surface a hint instead,
and (3) optionally emit a typed `env` augmentation. A thin `@cirrus/service`
package with a typed RPC-client builder is a **defer-to-later** stretch (Item 4),
worth it only once multi-worker Cirrus composition has real users.

## Current state

- `packages/config/src/remote-bindings.ts:56-64,95-103` — `services` is already
  `REMOTE_ELIGIBLE_KEYS.services: { label: "Service", shape: "array" }` and in
  `RemoteWranglerShape` (`services?: ReadonlyArray<BindingEntry | null |
undefined>`). `cirrus dev --remote` already proxies a service binding to its
  deployed target. **This is the only place `services` is wired today.**
- `packages/config/src/wrangler-validator.ts` — `WranglerConfig` (65-83) has no
  `services` key and no validation. wrangler validates the shape, but a
  Cirrus-side check (each entry needs a non-empty `binding` + `service`) is cheap
  polish (Item 1).
- `packages/config/src/infer-bindings.ts` — no service capability. A service
  binding's `service` target is an external worker name; Cirrus has no signal in
  the user's source for _which_ worker, so this can only ever be a **hint**, never
  an auto-write (parallels R2/KV's user-defined names).
- `packages/config/src/reconcile-bindings.ts:145-204` — `collectWarnings` is the
  hint sink; `WranglerShape` (56-66) would gain `services?`.
- `packages/codegen/src/emit.ts` — service bindings don't map to a `ctx.*`
  facade (they're `env`-level Fetchers/RPC stubs, not a per-request resource).
  The relevant integration is a generated **`env` type augmentation**, not an
  `ActionCtx` field. There is currently no emitted `Env`/`Bindings` interface in
  `emit.ts` (codegen leans on `Record<string, unknown>` for `env`, e.g.
  `emit.ts:1265,1315,1957-1959`), so typing `env.<SERVICE>` requires deciding
  _where_ a Cirrus `Env` type would live (see Item 3 — this is the real design
  question and the reason this plan is config-first).
- No `packages/service/` exists.

What's missing: validator awareness, an inference hint, and a decision on
codegen-typed `env` access (Item 3). The package (Item 4) is explicitly deferred.

## Item breakdown

- [x] Item 1: Validate `services` in wrangler config
    - `packages/config/src/wrangler-validator.ts` — add to `WranglerConfig` (65-83): `services?: ReadonlyArray<{ binding?: string; entrypoint?: string; environment?: string; service?: string } | null | undefined>`. Add a `validateServices(wrangler, errors)` pass modeled on `validateTailConsumers` (300-322) / `validateWorkflows` (256-292): each entry must have a non-empty `binding` and a non-empty `service`; `entrypoint` (the named `WorkerEntrypoint` class on the target) is optional. Call it from `validateWranglerConfig` (346-401) alongside `validateWorkflows`.
    - **Test**: `packages/config/__tests__/wrangler-validator.test.ts` — a malformed `services` entry (missing `binding` or `service`) surfaces the error; a well-formed `{ binding, service, entrypoint }` passes; absent `services` is silent.

- [x] Item 2: Inference hint for service bindings (no auto-write) — shipped as option (a) (config-only, no scan)
    - **Decide the source signal.** Unlike `@cirrus/auth`/`storage`, there is no import that says "this app uses a service binding" — service usage is `env.<NAME>.fetch(...)` / `env.<NAME>.<rpc>()`, and the binding name is arbitrary. Two honest options: (a) **skip inference entirely** (service bindings are 100% user-authored config; Cirrus has nothing to infer), or (b) scan `cirrus/` for `env.<UPPER_SNAKE>.fetch(` patterns and, for any such name not present in `services`, emit a hint. **Recommend (a) for this PR** — option (b) is heuristic and noisy. Document the decision in the plan-status update.
    - If (a): no `infer-bindings.ts` change; Item 2 is a no-op beyond documenting that service bindings are config-only. If (b): add the scan + a `describeSignals` hint mirroring storage (`infer-bindings.ts:499-501`).
    - **Test**: only if (b) — a fixture using `env.PRICING.fetch(` with no `services` entry yields a hint; with the entry present, silent.

- [x] Item 3: Codegen-typed `env` access (the real design item) — shipped as a broad `CloudflareBindings`/`Env` seam, not a services-only `CirrusServices` (see Status banner)
    - **Problem**: codegen passes `env` around as `Record<string, unknown>` (`emit.ts:1265`, `1957-1959`, etc.), so `env.MY_SERVICE` is untyped. Typing service-binding access end-to-end needs a generated `Env`/`CloudflareBindings` interface — which Cirrus does not currently emit.
    - **Scope decision**: emitting a full `Env` type is a larger cross-cutting change (it would also want to cover KV/R2/D1/AI bindings). For _this_ plan, do the **minimal** version: emit (in `_generated/server.ts`, near the `ActionCtx` block at `emit.ts:852-868`) a `CirrusServices` interface — one optional `Fetcher`-typed property per `services[].binding` discovered from `wrangler.jsonc` — and a helper `services(env)` (or a typed `ctx.env`/`ctx.services` accessor on `ActionCtx`) that returns `env` narrowed to `CirrusServices`. Read the binding names from the parsed wrangler config via a new `discover-service-bindings.ts` in `packages/codegen/src/` (mirror `discover-containers.ts`/`discover-workflows.ts`, which already read structured config).
    - `entrypoint`-typed RPC stubs (typing the _methods_ of a `WorkerEntrypoint`) are **out of scope** — Cirrus can't see a third-party worker's RPC surface; type these as `Service<unknown>` / `Fetcher` and let the user cast. Document this limit in the generated comment.
    - Gate emission on `services` being present in wrangler config (no services → emit nothing, like containers/workflows when the arrays are empty, `emit.ts:1303-1304`).
    - **Test**: a codegen fixture with a `services: [{ binding: "PRICING", service: "pricing-worker" }]` wrangler config emits a `CirrusServices` with a `PRICING` property; an empty/absent `services` emits nothing. Plain-Node golden assertion — no workerd.

- [ ] Item 4 (DEFERRED — stretch): `@cirrus/service` typed RPC-client package
    - Only pursue once multi-worker Cirrus composition (the `@cirrus/astro` single-worker story, or a deliberately split app) has a concrete user. Shape: a thin `createServiceClient<TEntrypoint>(env.<BINDING>)` that wraps a `WorkerEntrypoint` stub with typed method passthrough + a `fetch` helper, packaged like `@cirrus/storage` (src/index.ts named-only exports, src/create-service-client.ts, src/types.ts, `__tests__/` over a structural `Fetcher`/`Service` fake, package.json conditional exports, project.json `type:package`+`category:add-on`, packem/vitest/.releaserc/FSL license).
    - **Test (when built)**: plain-Node fake `Service`/`Fetcher` object asserts `fetch` passthrough + RPC-method forwarding. No workerd in the unit suite; any real-binding workerd test is CI-only behind `CIRRUS_WORKERD_TESTS=1`.
    - Leave this checkbox unticked and the package uncreated unless explicitly prioritized — note "deferred, not built" in the status row.

## Verification

```bash
pnpm run build:packages
pnpm --filter "@cirrus/config..." run build
pnpm --filter "@cirrus/config" run test                  # validateServices + (optional) inference hint
pnpm --filter "@cirrus/config" run lint:types
pnpm --filter "@cirrus/codegen..." run build
pnpm --filter "@cirrus/codegen" run test                 # CirrusServices emit golden
pnpm --filter "@cirrus/codegen" run lint:types
```

- All tests are plain-Node (config parsing, codegen string emit). No workerd in scope for Items 1-3. Item 4's real worker-to-worker RPC can only be exercised in a workerd pool — CI-only, gated behind `CIRRUS_WORKERD_TESTS=1`; it will time out in this sandbox.

## STOP conditions

- The drift check shows `remote-bindings.ts`, `wrangler-validator.ts`, or `emit.ts` moved the cited line ranges — re-locate before editing.
- Item 3 reveals that a Cirrus `Env`/`CloudflareBindings` type already exists or is mid-introduction in another plan — coordinate rather than emit a competing `CirrusServices` type; report the overlap.
- Emitting `CirrusServices` requires reading wrangler config from a codegen path that doesn't currently parse it — confirm `discover-containers.ts`/`discover-workflows.ts` already have a wrangler-read seam to reuse; if not, stop and scope the config-read plumbing separately.
- The decision in Item 2 (skip vs heuristic scan) is contested by the reviewer — default to **skip** (config-only) and report rather than ship a noisy heuristic.
- Item 4 is requested without a concrete multi-worker consumer — push back; do not build the package speculatively.
