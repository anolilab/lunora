# Plan 027: Cloudflare KV (Workers KV) Support

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, tick the checkboxes and update this
> plan's status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 058071c8..HEAD -- packages/config/src/remote-bindings.ts packages/config/src/wrangler-validator.ts packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/codegen/src/emit.ts packages/codegen/src/discover-feature-usage.ts packages/storage/`.
> If any in-scope file changed since this plan was written, compare against live
> code before proceeding; on mismatch treat as a STOP condition.

## Status

- **Priority**: P2 (KV closes a real Convex/zeroback parity edge — ephemeral caches, feature flags, session blobs — but Lunora already has DO-SQLite for durable state, so KV is a convenience layer, not a load-bearing gap.)
- **Effort**: M (thin package + codegen `ctx.kv` typing + config inference; no DO work.)
- **Risk**: LOW (KV is a leaf binding; `kv_namespaces` is already validator-/remote-known; no runtime/DO surface to break.)
- **Depends on**: none
- **Category**: feature (new Cloudflare binding support)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

Build it as a **thin `@lunora/kv` package** mirroring `@lunora/storage`: a typed
`createKv(env.<BINDING>)` facade with JSON get/put/list helpers plus a
codegen-wired `ctx.kv` on `ActionCtx`. KV's bucket-binding name is user-defined
(exactly like R2), so it cannot be auto-provisioned into `wrangler.jsonc` — keep
the package opt-in and surface a reconcile **hint** (mirroring `usesStorage`)
rather than writing a binding. Config already half-knows KV (`remote-bindings.ts`
proxies `kv_namespaces` in remote dev), so this is additive and low-risk. Do NOT
gate it behind sharding or DO state — KV's value is precisely the cases where a
DO round-trip is overkill (edge caches, flags).

## Current state

- `packages/config/src/remote-bindings.ts:56-64` — `REMOTE_ELIGIBLE_KEYS`
  already lists `kv_namespaces: { label: "KV", shape: "array" }`, and
  `RemoteWranglerShape` (lines 95-103) declares `kv_namespaces?:
ReadonlyArray<BindingEntry | null | undefined>`. So `lunora dev --remote`
  already proxies KV to the deployed namespace. **This is the only place KV is
  wired today.**
- `packages/config/src/wrangler-validator.ts` — `WranglerConfig` (lines 65-83)
  does **not** include `kv_namespaces`; there is no KV validation. (Not strictly
  required — wrangler validates the binding shape itself — but a Lunora-side
  cross-check is optional polish, see Item 4.)
- `packages/config/src/infer-bindings.ts` — no KV capability. `Capabilities`
  (lines 141-148), `capabilityForImportSource` (164-186), and `InferredBindings`
  (117-138) have no `usesKv`. KV's binding name is user-defined, so — like
  `@lunora/storage` (lines 499-501) — it can only ever be a **hint**, never an
  auto-write.
- `packages/config/src/reconcile-bindings.ts:154-158` — `collectWarnings`
  emits the storage hint pattern this plan reuses for KV.
- `packages/codegen/src/emit.ts` — `ActionCtx` (lines 864-868) is where
  package-backed `ctx.*` facades are woven (`storage`, `ai`, `payments`,
  `containers`). KV would add an `ActionCtx`-only field, gated like `ai`
  (emit fragments at `emit.ts:1249-1293` are the template).
- `packages/codegen/src/discover-feature-usage.ts:48-56` — `PROBES` is where a
  `kv: { contextProperty: "kv", moduleSpecifier: "@lunora/kv" }` probe is added
  so the studio nav + codegen gating sees KV usage.
- No `packages/kv/` exists. `@lunora/storage` is the package template (`src/index.ts`,
  `src/create-storage.ts`, `src/types.ts`, `__tests__/`, `package.json` with
  conditional exports, `project.json` tags `type:package`+`category:add-on`,
  `packem.config.ts`, `vitest.config.ts`, `.releaserc.json`, FSL-1.1-Apache-2.0
  `LICENSE.md`).

What's missing: the package, the `ctx.kv` codegen typing, the config inference
hint, and (optional) the validator entry.

## Item breakdown

- [x] Item 1: Scaffold the `@lunora/kv` package
    - Run `vis generate lunora-package --name=kv --description='Typed Workers KV namespaces for Lunora: JSON helpers and ctx.kv'` to create `packages/kv/`, then conform it to the `@lunora/storage` shape.
    - `packages/kv/src/types.ts` — define `KVNamespaceLike` (the structural subset of Cloudflare's `KVNamespace`: `get`/`getWithMetadata`/`put`/`delete`/`list`, with the `type`/`cacheTtl`/`expiration`/`expirationTtl`/`metadata` options). Do NOT import `@cloudflare/workers-types` at runtime — declare a structural `*Like` interface so the package stays runtime-agnostic and unit-testable in plain Node (mirrors `R2BucketLike` in `packages/storage/src/types.ts`). Also export `LunoraKvOptions`, `KvPutOptions`, `KvListOptions`, `KvListResult<T>`, and the public `Kv` facade interface.
    - `packages/kv/src/create-kv.ts` — `createKv(namespace: KVNamespaceLike, options?: LunoraKvOptions): Kv`. Methods: `get<T>(key)` / `getRaw(key)` / `getWithMetadata<T, M>(key)` (JSON-parse by default, with a typed `text`/`arrayBuffer`/`stream` escape hatch), `put<T>(key, value, opts?)` (JSON-stringify by default; pass `expirationTtl`/`expiration`/`metadata` through), `delete(key)`, `list(opts?)`. Add an optional `keyPrefix` in `LunoraKvOptions` and a `scopeKey(prefix, key)` helper mirroring `scopeKey` exported from `@lunora/storage` (`packages/storage/src/index.ts:3`) for multi-tenant key namespacing.
    - `packages/kv/src/index.ts` — **named exports only** (no default; >1 export): `export { createKv, scopeKey } from "./create-kv"` and `export type { ... } from "./types"`. No `.js` extensions (bundler resolution).
    - `package.json`: copy `packages/storage/package.json` — `"license": "FSL-1.1-Apache-2.0"`, `"type": "module"`, `"sideEffects": false`, conditional `exports` (`"."` → `types`/`import`, plus `"./package.json"`), the same `devDependencies` (`@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`, `@visulima/packem`, `wrangler`, all `catalog:*` — never hardcode versions), and the same `scripts`. `description`: "Typed Workers KV for Lunora: JSON helpers and ctx.kv". `keywords`: lunora, cloudflare, workers, kv.
    - `project.json`: `{ "name": "kv", "tags": ["type:package", "category:add-on"] }`.
    - `packem.config.ts`, `prettier.config.js`, `tsconfig.json`, `eslint.config.js`, `.releaserc.json`, `LICENSE.md` — copy verbatim from `packages/storage/`.
    - **Test**: `packages/kv/__tests__/create-kv.test.ts` — plain-Node Vitest over an in-memory `KVNamespaceLike` fake (a `Map`-backed stub). Assert: JSON round-trip via `get`/`put`, `getWithMetadata`, `list` pagination/cursor, `delete`, `keyPrefix` scoping, raw vs JSON modes, and that `put` forwards `expirationTtl`/`metadata`. No workerd needed.

- [x] Item 2: Codegen-typed `ctx.kv` on `ActionCtx`
    - `packages/codegen/src/emit.ts` — add an `emitKvFragments(hasKv)` helper mirroring `emitAiFragments` (`emit.ts:1249-1293`): a `build` fragment (`const kv = config.kv?.(env) ?? createKv(env.<DEFAULT_KV_BINDING>)` with a throwing stub when no binding resolves), a `configField` (`kv?: (env: Record<string, unknown>) => Kv;`), a `contextField` woven into `ActionCtx` (lines 864-868, alongside `aiActionField`/`paymentsActionField`), and the import lines (`import { createKv } from "@lunora/kv"; import type { Kv } from "@lunora/kv";`).
    - Gate it on the discovered `kv` feature flag (Item 3). Like `ai`/`payments`, expose `ctx.kv` on **ActionCtx only** — KV is a network call and must not run inside deterministic query/mutation handlers (see the determinism note in CLAUDE.md / advisor `nondeterministic_query_mutation`).
    - **Decide the default binding name**: KV namespace bindings are user-defined, so codegen can't assume one the way `env.AI`/`DB` are fixed. Use the conventional `env.KV` as the default with the `config.kv` thunk as the override (matches the `ai` pattern: `config.ai?.(env) ?? env.AI`). Document this in the generated comment.
    - **Test**: extend the codegen golden/emit tests under `packages/codegen/__tests__/` — assert that with the `kv` flag set, the generated `server.ts` contains the `ctx.kv` field on `ActionCtx` and the `@lunora/kv` import, and with it unset, neither appears. Follow the existing `ai`/`payments` emit assertions.

- [x] Item 3: Wire KV into feature discovery
    - `packages/codegen/src/discover-feature-usage.ts` — add `kv: boolean` to `FeatureUsage` (lines 23-38) and `kv: { contextProperty: "kv", moduleSpecifier: "@lunora/kv" }` to `PROBES` (lines 48-56). This flips when a `lunora/` source imports `@lunora/kv` or reads `ctx.kv`. Plumb the flag through to `emitKvFragments` in `run-codegen.ts`/`emit.ts` exactly as `ai` is plumbed.
    - If the studio nav gating consumes `FeatureUsage` (`buildStudioFeatures`), decide whether KV gets a nav page — likely **not** in this PR (no studio KV browser yet); just ensure the new flag doesn't break the existing `StudioFeaturesResult` shape. If `StudioFeaturesResult` (`@lunora/do`) is a closed type, either extend it or keep `kv` codegen-only and out of the studio features object.
    - **Test**: a discovery test fixture with a `lunora/` file importing `@lunora/kv` (and one reading `ctx.kv`) asserts `usage.kv === true`; a fixture with neither asserts `false`.

- [x] Item 4: Config inference hint (no auto-write)
    - `packages/config/src/infer-bindings.ts` — add `usesKv: boolean` to `Capabilities` (lines 141-148), `NO_CAPABILITIES` (150), `mergeCapabilities` (152-161), `capabilityForImportSource` (`@lunora/kv` → `{ ...NO_CAPABILITIES, usesKv: true }`, lines 164-186), `regexCapabilities`/`IMPORT_KV_PATTERN` (211-221), and `InferredBindings` (117-138). Surface a hint in `describeSignals` (456-508) like the storage hint (499-501): "@lunora/kv is imported; add a kv_namespaces binding (binding names are user-defined) and pass env.<BINDING> to createKv()." <!-- gitleaks:allow -->
      <!-- gitleaks:allow -->    - `packages/config/src/reconcile-bindings.ts` — extend `collectWarnings` (145-204) with the matching KV warning, suppressed when a `kv_namespaces` entry already exists (mirror the `hasR2Bucket` suppression at lines 149/154-158). Add `kv_namespaces?: ReadonlyArray<{ binding?: string }>` to `WranglerShape` (56-66). **Do NOT** add a `reconcileKv` writer — the binding name is user-defined, so KV is hint-only, exactly like R2.
    - **Test**: extend `packages/config/__tests__/` (the infer-bindings / reconcile-bindings suites) — a project importing `@lunora/kv` with no `kv_namespaces` produces the hint; one with a `kv_namespaces` entry already present is silent; reconcile never writes a `kv_namespaces` block.

- [x] Item 5: (Optional polish) validator awareness
    - `packages/config/src/wrangler-validator.ts` — add `kv_namespaces?: ReadonlyArray<{ binding?: string; id?: string }>` to `WranglerConfig` (65-83) and a `validateKvNamespaces` pass (mirror `validateTailConsumers`, 300-322) that flags an entry missing a non-empty `binding`. Low value (wrangler validates the shape itself), so this item is optional — implement only if Items 1-4 land clean and there's appetite. **Test**: a validator unit test with a malformed `kv_namespaces` entry surfaces the error.

## Verification

```bash
pnpm run build:packages                                  # ensure deps' dist is fresh first
pnpm --filter "@lunora/kv..." run build                  # build pkg + its deps
pnpm --filter "@lunora/kv" run test                      # plain-Node fakes — must pass locally
pnpm --filter "@lunora/kv" run lint:types
pnpm --filter "@lunora/kv" run lint:eslint
pnpm --filter "@lunora/codegen..." run build
pnpm --filter "@lunora/codegen" run test                 # ctx.kv emit + discovery
pnpm --filter "@lunora/config..." run build
pnpm --filter "@lunora/config" run test                  # infer/reconcile KV hint
```

- All `@lunora/kv` unit tests are plain-Node (Map-backed `KVNamespaceLike` fake); no workerd. Any workerd-pool smoke test (real KV binding via Miniflare) MUST be gated behind `LUNORA_WORKERD_TESTS=1` (see `packages/storage/vitest.config.ts:37`) and is **CI-only** — it will time out in this sandbox.

## STOP conditions

- The drift check shows `packages/config/src/remote-bindings.ts`, `reconcile-bindings.ts`, `infer-bindings.ts`, or `packages/codegen/src/emit.ts` changed since 058071c8 in a way that moves the cited line ranges — re-locate before editing.
- `@lunora/storage`'s package shape (exports/scripts/devDeps) differs from what's documented here — match the live storage package, not this plan's snapshot.
- `StudioFeaturesResult` (`@lunora/do`) cannot accept a new `kv` field without a breaking change to the studio — keep KV codegen-only (skip studio nav) and report.
- Adding `ctx.kv` to `ActionCtx` forces a non-trivial change to `QueryCtx`/`MutationCtx` typing (it must NOT appear there) — stop and confirm the ActionCtx-only gating works before proceeding.
- A catalog entry for any new dependency is missing (would force a hardcoded version) — stop and add the catalog entry first.
