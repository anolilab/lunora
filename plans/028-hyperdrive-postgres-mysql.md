# Plan 028: Hyperdrive (Postgres / MySQL bring-your-own-DB)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a "STOP conditions" item occurs, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 058071c8..HEAD -- packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/config/src/wrangler-validator.ts packages/codegen/src/discover-feature-usage.ts packages/codegen/src/emit.ts packages/d1/src`. If those files have moved on materially from what "Current state" describes (e.g. `WranglerConfig` no longer has the same binding-array shape, or `discover-feature-usage`'s `PROBES`/`FeatureUsage` shape changed), treat as STOP and re-baseline before editing.

## Status

- **Priority**: P2 — high _strategic_ value (the single biggest "bring your existing Postgres/MySQL" lever; Convex has no equivalent, so it's a differentiator not a parity gap), but it deliberately sits _outside_ Cirrus's reactive DO/OCC core and so does not block the core roadmap. Lower than the bindings that feed the core loop (Analytics Engine → Studio), higher than maturing/niche ones (Pipelines).
- **Effort**: L — new `@cirrus/hyperdrive` package, codegen ctx wiring, binding inference + validation + reconcile, driver peer-dep matrix, and substantial docs/guardrails around the determinism/realtime tension.
- **Risk**: HIGH — see the dedicated risk note. External-DB access breaks two invariants the rest of Cirrus relies on (handler determinism and live-query change tracking). Done carelessly this silently corrupts the realtime story.
- **Depends on**: none (binding-config precedents already exist). Pairs well with the determinism advisor lint (`nondeterministicQueryMutation`, `packages/advisor/src/lints/static/nondeterministic-query-mutation`).
- **Category**: feature (new Cloudflare binding support)
- **Planned at**: commit `058071c8`, 2026-06-15

## Verdict

**Build it — but only as an `action`-scoped escape hatch, never as a `ctx.db`-equivalent inside `query`/`mutation`.** Ship `@cirrus/hyperdrive` exposing `createHyperdrive({ binding })` → an ` activeAi`-style `ctx.sql` available **only on `ActionCtx`** (the non-deterministic context), wrapping a user-supplied `postgres`/`pg`/`mysql2` driver fed `env.HYPERDRIVE.connectionString`. The hard constraint, which MUST be stated in the docs, the codegen-emitted JSDoc, and surfaced by an advisor lint: **Hyperdrive queries hit an external database that Cirrus does not own.** They are non-deterministic (so forbidden in `query`/`mutation`, exactly like `fetch`), and writes to that external DB are invisible to the DO/SQLite change-feed, so **live queries / subscriptions will not re-run when external Postgres rows change.** Hyperdrive is the right tool for "read/write my legacy Postgres from an action," and the wrong tool for "make my Postgres reactive." Build the former, refuse to fake the latter.

## The core tension (read before designing anything)

Cirrus's value proposition is a reactive backend: `query` handlers are deterministic and re-execute when their inputs change, driven by the DO's SQLite write log (OCC + hibernated WS subscriptions in `@cirrus/do`). `defineSchema` tables live in that DO (sharded) or in D1 for `.global()`. Hyperdrive points at a database _Cirrus has no visibility into_:

1. **Determinism.** A Postgres `SELECT` is a network call with an external, mutable result — identical to `fetch`. Cirrus already treats `fetch`/`Date.now`/`Math.random` in `query`/`mutation` as a determinism violation (advisor `nondeterministic_query_mutation`; note: not yet runtime-enforced — see `MEMORY.md` "Query/mutation determinism not enforced"). Hyperdrive access in a `query`/`mutation` is the same class of bug and MUST be confined to `action`s.
2. **Realtime.** Live queries track DO/SQLite writes. An `UPDATE` issued over Hyperdrive to an external Postgres produces **no** Cirrus change event, so no subscription re-fires. There is no honest way to make external writes reactive without polling or logical-replication ingestion (explicitly out of scope here — see "Non-goals").
3. **It competes conceptually with the D1/DO core.** A user _could_ try to run their whole app on Hyperdrive+Postgres and bypass `defineSchema` entirely — at which point they lose realtime, optimistic updates, the offline queue, OCC, and the advisor lints, i.e. most of why they'd pick Cirrus. The package's framing must be "**integrate** an existing DB from actions," never "**replace** the Cirrus data layer."

## Current state

- **No Hyperdrive support anywhere.** `packages/config/src/wrangler-validator.ts:65-83` (`WranglerConfig`) enumerates the binding arrays Cirrus knows about — `d1_databases`, `durable_objects`, `r2_buckets`, `vectorize`, `containers`, `workflows`, `tail_consumers`, `ai` — with **no `hyperdrive`** key. `packages/config/src/reconcile-bindings.ts` `WranglerShape` (around line 52+) likewise has no Hyperdrive entry.
- **Binding inference** (`packages/config/src/infer-bindings.ts`) maps `@cirrus/*` imports → capabilities via `capabilityForImportSource` (lines 164-186) and `Capabilities`/`InferredBindings` (lines 117-148). There is no Hyperdrive capability and `@cirrus/hyperdrive` is not in the import map.
- **Feature-usage codegen** (`packages/codegen/src/discover-feature-usage.ts`) has a `PROBES` table (lines ~48+) of `{ moduleSpecifier, contextProperty }` per optional package (`ai → ctx.ai`, `storage → ctx.storage`, etc.). No `hyperdrive` probe; nothing wires a `ctx.sql`.
- **Closest precedent = `@cirrus/d1`** (`packages/d1/src/`): a DB-adapter package that wraps a CF data binding. `d1-client.ts:1-55` shows the wrapper-over-`env.DB` pattern; `D1Client.withSession(bookmark)` (read-your-writes via the **Sessions API**) is the consistency model for _D1's own replicas_ — note it is a D1-specific feature and does **not** transfer to Hyperdrive (Hyperdrive pools/caches connections to _your_ Postgres; read-your-writes is the upstream DB's job, not a bookmark protocol). `d1-ctx-db.ts` shows how a binding becomes a `ctx.*` surface. `index.ts:1-25` shows the named-only export barrel.
- **Determinism advisor** exists (`packages/advisor/src/lints/static/nondeterministic-query-mutation`, exported `index.ts:48`) and already discovers non-deterministic calls — the natural place to also flag `ctx.sql` outside actions.
- **Missing**: the package, the binding plumbing (validate/infer/reconcile), the codegen ctx wiring, the driver peer-dep story, and all the guardrail docs/lints.

## Item breakdown

- [x] **Item 1: `@cirrus/hyperdrive` package skeleton + driver-agnostic client.**
    - Create `packages/hyperdrive/` mirroring `packages/storage/` shape: `package.json` (`"@cirrus/hyperdrive"`, `"type": "module"`, `"sideEffects": false`, FSL-1.1-Apache-2.0, conditional `exports` for `.` and `./package.json`, scripts copied verbatim from storage, catalog deps only — `@cloudflare/workers-types: catalog:cloudflare`, `typescript: catalog:tsc`, `@types/node: catalog:types`, `@visulima/packem: catalog:build`, `vitest: catalog:test`, etc.), `project.json` (`{ "name": "hyperdrive", "tags": ["type:package", "category:add-on"] }`), `tsconfig.json` extending `../../tsconfig.base.json`, `vitest.config.ts`, `.releaserc.json` extending `@anolilab/semantic-release-preset/pnpm`, `README.md`, `LICENSE.md`.
    - `src/types.ts`: structural projection of the Hyperdrive binding — `interface HyperdriveLike { connectionString: string; host: string; port: number; user: string; password: string; database: string }` (mirror the real `Hyperdrive` from `@cloudflare/workers-types`, but keep it structural so unit tests can pass a plain object, exactly like `D1DatabaseLike`).
    - `src/create-hyperdrive.ts`: `createHyperdrive(binding: HyperdriveLike)` returns `{ connectionString, config }`. **Do not bundle a driver** — Postgres/MySQL drivers are heavy and the user picks one. The user passes their own connected driver; the package's job is to surface the connection string + a typed `ctx.sql` _facade_ that delegates. Provide a generic `SqlClient` interface (`query<Row>(text, params): Promise<Row[]>`) and a tiny `fromPostgresJs` / `fromNodePg` / `fromMysql2` adapter set so users can do `ctx.sql = fromPostgresJs(postgres(env.HYPERDRIVE.connectionString))`. Drivers (`postgres`, `pg`, `mysql2`) are **`peerDependencies` marked `optional`**, never `dependencies`.
    - `src/index.ts`: named-only barrel (no default export) re-exporting `createHyperdrive`, the adapter factories, and all public types.
    - Test (`__tests__/create-hyperdrive.test.ts`, plain-Node Vitest — NOT worker-pool): feed a fake `HyperdriveLike`, assert `connectionString` passthrough; feed a fake driver into `fromNodePg`, assert `query` delegates and maps rows. **workerd can't run in this sandbox** — keep these pure-Node; any real-binding test is CI-only and `describe.skipIf(!process.env.CI)`.

- [x] **Item 2: wrangler validation for the `hyperdrive` binding.**
    - Edit `packages/config/src/wrangler-validator.ts`: add `hyperdrive?: ReadonlyArray<{ binding?: string; id?: string; localConnectionString?: string } | null | undefined>` to `WranglerConfig` (around lines 65-83). Add a `validateHyperdriveBindings(wrangler, errors, warnings)` helper following the `validateVectorizeBindings` pattern (lines 96-109): each entry must have a non-empty `binding` (error if missing) and an `id` (warn — empty/placeholder id can't connect; mirror the D1 placeholder-id warning ethos in reconcile). Wire it into the main `validateWranglerConfig` body.
    - Test: extend the validator's `__tests__` with a malformed-entry case (entry missing `binding` → error; entry missing `id` → warning).

- [x] **Item 3: binding inference for `@cirrus/hyperdrive`.**
    - Edit `packages/config/src/infer-bindings.ts`: add `usesHyperdrive: boolean` to `Capabilities` (line 141-148), `NO_CAPABILITIES` (150), `mergeCapabilities` (152-161), and `InferredBindings` (117-138). Add the import-source branch in `capabilityForImportSource` (164-186): `if (source === "@cirrus/hyperdrive") return { ...NO_CAPABILITIES, usesHyperdrive: true }`. Add `IMPORT_HYPERDRIVE_PATTERN = /\bfrom\s+["']@cirrus\/hyperdrive["']/` and include it in `regexCapabilities` (212-221). Emit a **hint** in `describeSignals` (457-508), like the storage/payment hints: `"hint: @cirrus/hyperdrive is imported; add a 'hyperdrive' binding ({ binding, id }) in wrangler.jsonc and run 'wrangler hyperdrive create' to mint the id"`. **Do not auto-write** the binding (the `id` is a remote resource Cirrus can't fabricate — same reasoning as the R2 bucket name and D1 placeholder id).
    - Surface `usesHyperdrive` on the returned `InferredBindings`.
    - Test: extend infer-bindings `__tests__` — a fixture source importing `@cirrus/hyperdrive` flips `usesHyperdrive` and emits the hint string; no binding is written.

- [x] **Item 4: reconcile leaves Hyperdrive as a warning (no auto-provision).**
    - Edit `packages/config/src/reconcile-bindings.ts`: add `hyperdrive?: ReadonlyArray<{ binding?: string; id?: string }>` to `WranglerShape`. **Do not** add a `modify`/`applyEdits` write path. Instead, when `inferred.usesHyperdrive` is true and no `hyperdrive` binding exists, push the Item-3 hint as a returned **warning** (same channel R2/auth-without-DO warnings use). Document in the function JSDoc why Hyperdrive is warning-only (remote `id`).
    - Test: reconcile run with `usesHyperdrive: true` and no existing binding → returns the warning, writes nothing to wrangler.

- [x] **Item 5: codegen wires `ctx.sql` onto `ActionCtx` only.**
    - Edit `packages/codegen/src/discover-feature-usage.ts`: add `hyperdrive` to `FeatureUsage` and a `PROBES.hyperdrive = { moduleSpecifier: "@cirrus/hyperdrive", contextProperty: "sql" }`.
    - In the emitter (`packages/codegen/src/emit.ts`) and the generated `server.ts`/`dataModel.ts` ctx types: when `hyperdrive` usage is detected, add `sql: SqlClient` to the **`ActionCtx`** type **only** — NOT `QueryCtx`/`MutationCtx`. Emit a JSDoc on the property reading, verbatim: _"External database access via Hyperdrive. Non-deterministic — available only in actions. Writes here are NOT tracked by Cirrus live queries; subscriptions will not re-run on external DB changes."_ Remember `@cirrus/codegen` is the **one package where emitted `.js` extensions are mandatory** — generated import specifiers and golden fixtures keep `.js`.
    - Test: a codegen golden fixture where a `cirrus/` action reads `ctx.sql` → assert `ActionCtx` gains `sql` and `QueryCtx`/`MutationCtx` do **not**; assert the warning JSDoc is present. Update existing goldens if the ctx-shape snapshot changes.

- [x] **Item 6: advisor lint — `ctx.sql` outside an action.**
    - Add `packages/advisor/src/lints/static/hyperdrive-outside-action.ts` (mirror `nondeterministic-query-mutation`'s discovery): flag any `ctx.sql(...)` / `ctx.sql.query(...)` reached from a `query` or `mutation` handler. Export it from `packages/advisor/src/index.ts` (named, alphabetical with the other `lints/static/*` re-exports). This is the enforcement teeth behind the determinism rule (runtime enforcement is still absent per `MEMORY.md`, so the lint is the guardrail).
    - Test: advisor fixture with `ctx.sql` in a `query` → lint fires; in an `action` → clean.

- [x] **Item 7: docs + skill, framing Hyperdrive as an action-only integration.**
    - Add a docs page (follow the existing docs-site structure under `apps/`) and, if a setup-skill convention exists (see `cirrus-setup-storage`), a `cirrus-setup-hyperdrive` skill. The page MUST lead with the "integrate, don't replace" framing, the determinism rule, the realtime caveat (live queries don't track external writes), and the `wrangler hyperdrive create` + `{ binding, id }` + `localConnectionString` (local dev) setup. Show the canonical recipe: action reads/writes Postgres via `ctx.sql`, then _writes a projection into a `defineSchema` DO/D1 table_ if it wants that data to be reactive.
    - Add a `pnpm-workspace.yaml` catalog entry only if a new shared driver version is introduced (prefer leaving driver versions to the user; do not hardcode).

### Non-goals (state explicitly in the docs)

- No logical-replication / CDC ingestion of external Postgres into Cirrus tables (would be the only honest path to "reactive external DB"; large separate effort, out of scope).
- No `ctx.sql` in `query`/`mutation` (forbidden by design — Item 6 lints it).
- No bundled driver / no opinionated ORM. The user owns driver choice and lifecycle.

## Verification

```bash
# Build the new package + dependents (the trailing ... builds deps first)
pnpm --filter "@cirrus/hyperdrive..." run build
pnpm --filter "@cirrus/config..." run build
pnpm --filter "@cirrus/codegen..." run build
pnpm --filter "@cirrus/advisor..." run build

# Type-check
pnpm --filter "@cirrus/hyperdrive" run lint:types
pnpm --filter "@cirrus/config" run lint:types
pnpm --filter "@cirrus/codegen" run lint:types
pnpm --filter "@cirrus/advisor" run lint:types

# Unit tests (plain-Node; worker-pool tests are CI-only / skipIf(!CI))
pnpm --filter "@cirrus/hyperdrive" run test
pnpm --filter "@cirrus/config" run test
pnpm --filter "@cirrus/codegen" run test
pnpm --filter "@cirrus/advisor" run test

# Lint
pnpm --filter "@cirrus/hyperdrive" run lint:eslint
```

Expected: all green. New package builds and exports `createHyperdrive` + adapter factories. Config validates/infers the `hyperdrive` binding (validate=error-on-missing-binding, warn-on-missing-id; infer=hint-only, no auto-write). Codegen adds `ctx.sql` to `ActionCtx` only. Advisor flags `ctx.sql` in query/mutation.

> Reminder: a raw `--filter … run test`/`lint:types` does NOT rebuild workspace deps; if you hit stale-`dist` errors (`X is not a function`, "missing export") run `pnpm run build:packages` once or use the `...`-suffixed filter as above.

## STOP conditions

- The drift check shows `WranglerConfig` / `WranglerShape` / `Capabilities` / `PROBES` have been restructured such that the line references no longer map — re-baseline before editing.
- Any design pressure to expose `ctx.sql` on `QueryCtx`/`MutationCtx`, or to auto-provision the `hyperdrive` `id`, or to bundle a driver — STOP and report; these violate the plan's core constraints.
- A worker-pool / real-binding test is required to make a unit test pass — that can't run in this sandbox (`MEMORY.md` workerd-sandbox-limit); mark it CI-only and STOP if it's blocking local green.
- If logical-replication / "make external Postgres reactive" creeps into scope — STOP; that is an explicit non-goal and a separate plan.
