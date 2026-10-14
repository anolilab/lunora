# Plan 490 — Lazy function registry (Worker startup CPU scales with procedure count)

**Baseline:** `947c714aa` (2026-10-13); email-guard prerequisite re-checked against `3e8806fd3` (2026-10-14)
**Status:** TODO — design and measurements only; nothing in this plan is implemented. The
email-guard prerequisite (§8) has shipped (#1159). Measurement scripts are not committed; §6 says
what to add.

## 0. Headline finding

A Worker with N procedures cannot deploy once evaluating its global scope exceeds
Cloudflare's 1 s startup CPU limit (error 10021). The mechanism is confirmed in this
repo: `_generated/functions.ts` statically imports every function module, so evaluating
the Worker evaluates every procedure's builder chain, validators and the **transitive
imports of every module** whether or not a request ever calls them.

Measured on a synthetic app (see §5), the registry's own O(N) floor is small
(~50 µs/procedure). What makes a real app fail is the **module graph the registry reaches**
(auth, rate limiter, agent clients, zod, …), which a static registry forces into startup.

Measured on a real about-1,000-function / ~130-table app (§5.1): the registry-only part of the graph
is 1,340 of 4,088 modules (33 %; 347 of its 534 `lunora/` modules, 65 %). Deferring it with
lazy loaders cut startup by **~31 % (median 421 → 290 ms, min 364 → 267) in wrangler's own
single-file bundle**, about two thirds of the 46 % upper bound (registry emptied). A lazy
registry does not remove the ~220 ms floor (auth core, zod, kysely, GC) or the O(tables)
generated metadata.

## 1. Where the static imports are and what looks up a function

Emit side (`packages/codegen/src/emit/functions.ts`):

- `renderFunctionRegistry` builds one `import * as lunora_<file>_<n> from "../<file>.js"`
  per user module (functions, then migrations, mutators, shapes).
- `emitFunctions` writes `export const LUNORA_FUNCTIONS: Record<string, RegisteredLunoraFunction>`
  — `"<ns>:<fn>": alias.fn as unknown as RegisteredLunoraFunction` — plus
  `LUNORA_LIFECYCLE_HOOKS`, `LUNORA_MIGRATIONS`, `LUNORA_SHAPES`, `LUNORA_MUTATOR_PATHS`,
  `dispatchLunoraFunction`, `createCaller` (`callRegistered`).
- It also emits **AOT-compiled arg validators at module scope**:
  `installCompiledValidatorMap(alias.fn.args, (source) => {…})` for every function
  (466 blocks / ~10k generated lines for 466 eligible procedures in the synthetic 700-proc
  app). This mutates the live `.args` object, so it hard-requires the module to be evaluated.

Consumers of the map (all in generated output):

| Site                                                             | Reads                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit/shard-dispatch.ts:78` `handleRpc`                          | `kind`, `visibility`, `lifecycle`, `handler`                                                                                                  |
| `emit/shard-dispatch.ts:42` `dispatchRun` (`ctx.run*`)           | `kind`, `handler`                                                                                                                             |
| `emit/shard-dispatch.ts:244` `isMutationFunction`                | `kind` (sync)                                                                                                                                 |
| `emit/shard-dispatch.ts:257` `executeSubscription`               | `kind`, `visibility`, `handler`                                                                                                               |
| `emit/shard-dispatch.ts:278` `executeStream` (sync return)       | `kind`, `visibility`, `durable`, `handler`                                                                                                    |
| `emit/shard.ts:645` `isCacheableQuery` (sync)                    | `kind`, `visibility`, `perDispatch`                                                                                                           |
| `emit/shard.ts:651` `isPaidFunction` (sync)                      | `x402`                                                                                                                                        |
| `emit/shard.ts:825` `runReactor`                                 | `kind`, `handler`                                                                                                                             |
| `emit/shard-context.ts:105` `buildCtx` (sync)                    | `kind`                                                                                                                                        |
| `emit/shard-shapes.ts:32,112,119`                                | `LUNORA_SHAPES`, `LUNORA_MUTATOR_PATHS`                                                                                                       |
| `emit/shard-admin.ts:65`                                         | `LUNORA_MIGRATIONS`                                                                                                                           |
| `emit/app-worker-options.ts:321` → `createWorker({ functions })` | `kind`, `visibility`, **`args`** (admin `GET …/functions`, `runtime/src/introspection-admin-routes.ts:113` → `describeArguments(entry.args)`) |
| `emit/functions.ts` `callRegistered` / `dispatchLunoraFunction`  | `kind`, `handler`                                                                                                                             |

Procedures carry no import-time side effects: the builder (`packages/server/src/builder/index.ts`)
returns a plain `{ kind, args, handler, visibility, perDispatch?, x402?, durable?, lifecycle? }`
object and registers nothing globally. RLS and `crpc`/`.use()` middleware are closed over by
`handler` at the call site where the builder chain is written, so they travel with the module
and need no separate attachment step. **That is what makes laziness feasible.**

## 2. Feasibility: yes, with one design constraint

Dispatch by path → `import()` the owning module on first call → cache per isolate. Proven
on workerd (spike, not committed): a hand-patched `functions.ts` whose entries delegate to
`(await import("../modX.js"))[name].handler(ctx, args)` served a query and a
transaction-wrapped mutation correctly through a Durable Object (`wrangler dev --local`).
Dynamic `import()` of a chunk inside a DO request works.

### The design constraint: sync predicates need facts that only exist after load

`kind`, `visibility`, `lifecycle` are already in `FunctionIR` and can be emitted as a static
manifest. But three fields are **runtime-derived** from the builder chain and are read in
**synchronous** hooks:

- `perDispatch` — set from a runtime tag on `.use()` middleware values (`per-dispatch-tag.ts`),
  read by `isCacheableQuery`.
- `x402` — `.x402({ price })`, read by `isPaidFunction`.
- `durable` — stream option, read by `executeStream` (which returns synchronously).
- `args` — validator map, read by admin introspection.

Two ways through; recommend (A):

- **(A) Ensure-loaded at ingress.** Add one async base-class hook, e.g.
  `protected async prepareFunction(path)`, awaited at the DO ingress points that precede those
  predicates (RPC handler, subscription register/re-run, stream open, paywall checks, reactor,
  lifecycle). The generated override `await`s the loader and fills a per-isolate `loaded`
  map; the existing sync predicates then read `loaded[path]`. Semantics unchanged; the cost is
  one `await` on first use per function per isolate. Needs ~8 call sites in
  `packages/do/src/shard-do.ts` (`isPaidFunction` is called at 5086, 6993, 11583, 12946;
  `isCacheableQuery` at 7312; `isMutationFunction` at 7337; `isCustomMutator` at 7238).
- (B) Statically discover `perDispatch`/`x402`/`durable`. Fragile: `perDispatch` is a runtime tag
  on a middleware _value_, not visible in source. Not recommended.

`args` for introspection: emit static argument descriptors from `FunctionIR.args` (codegen
already renders them for OpenAPI/`api.ts`), instead of reading the live validator map.

## 3. What must stay eager

- DO class exports (`ShardDO`, `ShardRegistryDO`, `SchedulerDO`, workflow/container classes) and
  the `fetch`/`queue`/`scheduled`/`email` entry — wrangler needs the names at upload.
- The schema (`../schema.js`): `createShardDO` needs it at construction; 19 ms in the reported
  profile, and it defines the tables. Keep eager.
- `LUNORA_LIFECYCLE_HOOKS` (path arrays; IR-derived), `LUNORA_CRONS`, cron triggers, queue
  registry: these name **paths** or are user-written modules, not function bodies. Cron/queue
  consumers dispatch by path, so they benefit from the same loader. Workflow classes
  (`../workflows.js`), containers, agents (`../agents.js`), `http.ts` routes and `queues.ts`
  are imported by value in generated output (`emit/shard-runtime.ts` 75/180/271/378) and stay
  eager in phase 1; they are a phase-2 candidate (HTTP routes are the awkward one: the router
  needs the route table to match a request).
- `LUNORA_MUTATOR_PATHS`, `LUNORA_SHAPES`: shapes run `assertShapesDeclareReadPolicies` at
  module scope (`shard-shapes.ts:112`) and mutators must be recognised before dispatch, so
  both stay eager in phase 1 (typically a handful of entries).

## 4. Other concerns checked

- **Determinism / loading inside a DO request.** Module evaluation happens inside the
  request's dispatch. Builder chains are pure; the only observable difference is _when_
  top-level user code runs. A module that reads `Date.now()`/`Math.random()` at module scope
  now does so on first call, not at isolate start (already nondeterministic across isolates).
  Mutations are transaction-wrapped by `runMutationTransaction` after the handler is resolved,
  so the load sits **outside** the span if `prepareFunction` is awaited first (recommended).
  Open: confirm an `await import()` before the input gate is released does not widen the
  interleaving window for concurrent RPCs on one DO (add a workerd test).
- **Live-query subscriptions that name an unloaded function.** `executeSubscription` is already
  async; it awaits `prepareFunction` first. After a hibernation wake-up the DO restores
  subscriptions from attachments and re-runs by path, loading on demand. The first re-run
  after a cold wake pays the module-eval cost (once per isolate).
- **`executeStream` returns synchronously.** It must either become async in the base class
  or the ingress hook must have loaded the function before it is called. (A) covers it.
- **Compiled arg validators.** `installCompiledValidatorMap(...)` must move into the loader
  (install immediately after import, before first dispatch). Otherwise it silently forces
  every module to evaluate and the whole change is a no-op.
- **`createCaller` / `ctx.run*` / `ctx.scheduler`.** All dispatch through `callRegistered` /
  `dispatchRun`, which already `await`; add `await prepare(path)` there. Types do not change.
- **Generated types.** None change: `api.ts`, `internal.ts`, `dataModel.ts`, the `Caller`
  interface are derived from `FunctionIR`, not from `LUNORA_FUNCTIONS`' value type.
- **Architecture / OpenAPI / OpenRPC / advisor.** All are produced at codegen time from the
  AST (`run-codegen.ts`, `spec-artifacts.ts`, `architecture.ts`), not by importing the
  modules, so correctness is unaffected. Only _serving_ them changes (§7).
- **Bundlers.** In wrangler's single-file esbuild bundle a dynamic `import()` becomes a
  lazy-init wrapper: module _evaluation_ is deferred, the script is still parsed. On the real app
  that was enough (§5.1: −31 %). On a synthetic app of cheap modules the wrappers cost about
  what they save, so it is a regression there (§5). Real code splitting (esbuild `--splitting`
  with `no_bundle`) gave **no** additional gain on the real app (§5.1) and costs more files; do
  not make it a prerequisite. Whether rolldown's chunked output saves _parse_ time is
  unmeasured (the `check startup` "Active" figure may not include compile time).

## 5. Measurements

Method: synthetic app = `templates/standalone` + N generated procedures (query / mutation /
internalMutation, realistic `v.*` validators, indexed reads) over T tables with two
indexes each; `wrangler check startup` (wrangler 4.149), median/min "Active" ms over 11–15
runs. **The machine was under load (load average ~15) so absolute numbers are noisy
(±15 ms); only large differences are meaningful.** Unminified. Not comparable to the
reported app in absolute terms (its procedures import far more).

Scaling with procedure count, single-file wrangler bundle, no shared heavy import:

| Procedures / tables | Bundle (raw) | Active (min–median ms) |
| ------------------- | ------------ | ---------------------- |
| 50 / 10             | 1.5 MiB      | 22–27                  |
| 200 / 40            | 2.2 MiB      | 16–34                  |
| 700 / 138           | 4.6 MiB      | 48–64                  |

→ roughly linear, ~0.05 ms per procedure plus tables; the registry floor alone is ~35 ms at
700 procedures. It does **not** by itself reach 1 s.

**Unfavourable results (no shared heavy import, 700/138) — a lazy registry does NOT help here:**

| Build                                                                       | Active (min / median ms)                        |
| --------------------------------------------------------------------------- | ----------------------------------------------- |
| eager, wrangler single-file                                                 | 48 / 64                                         |
| lazy, wrangler single-file (esbuild init wrappers; bundle grew 4.6→4.8 MiB) | 98 / 123 (**worse**)                            |
| eager, esbuild `--splitting`                                                | 35–40 / 54                                      |
| lazy, esbuild `--splitting`                                                 | 29–41 / 36–89 (flipped sign between two rounds) |

→ with cheap modules the lazy path is within or below noise, and in the single-file bundle it
is a regression (wrapper cost + the whole script still parsed). The synthetic result therefore
only says the registry pays when function modules pull in expensive imports; on a real app the
single-file bundle was enough (§5.1), so do not read the synthetic rows as "needs chunking".

Same 700/138 app, every function module also imports a shared module that statically imports
`@lunora/auth` (stand-in for auth/rate-limiter/zod/agent graphs):

| Build                                                            | Active (min / median ms) |
| ---------------------------------------------------------------- | ------------------------ |
| eager registry, wrangler single-file                             | 127 / 171                |
| lazy registry, wrangler single-file (esbuild lazy-init wrappers) | 71 / 86                  |
| eager registry, esbuild `--splitting` (no_bundle upload)         | 86 / 110–127             |
| **lazy registry, esbuild `--splitting`**                         | **26 / 32**              |

→ on this synthetic graph, with real splitting the lazy registry removes ~75–80 % of startup CPU;
with the single-file bundle about half (the real app, §5.1, showed single-file already sufficient). The remaining ~30 ms is the framework floor plus generated metadata.
Run-to-run spread was large (e.g. eager single-file max 418 ms against a 171 ms median), so
treat anything under ~2× as unproven.

### 5.1 Real app (about 1,000 functions, ~130 tables, 11.1 MiB minified bundle)

`wrangler check startup`, Active ms, interleaved runs of every variant on the same (busy,
load ~16) machine, n = 7, min / median:

| Variant                                                                                                                     | min / median  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------- |
| single-file, eager (today)                                                                                                  | 364 / 421     |
| single-file, registry emptied (upper bound: imports + `LUNORA_FUNCTIONS = {}` + validator installs deleted; bundle 8.4 MiB) | 175 / 227     |
| **single-file, lazy loaders** (`() => import()` per module, startup-only stubs; bundle 11.0 MiB)                            | **267 / 290** |
| esbuild `--splitting`, eager                                                                                                | 387 / 465     |
| esbuild `--splitting`, lazy loaders                                                                                         | 369 / 519     |

→ a lazy registry captures about two thirds of the achievable win in the default bundle.
Splitting is not required, and by itself (eager) is no better than the default bundle.
These stubs have a dummy `kind` and only prove the _startup_ effect; they cannot serve traffic.
A second, independent report (best of 5, quiet machine, minified) measured main 343 / 371 ms vs
registry deleted 204 / 222 ms, and that deleting only the 616 `installCompiledValidatorMap`
blocks changes nothing (333 / 435): **the cost is evaluating the function modules, not installing
the compiled validators**, so a lazy registry must defer the module import.

Registry-only reachability (esbuild metafile, source bytes, imports resolved with the workerd
conditions): of 4,088 modules / 29.2 MiB, **1,340 modules / 5.95 MiB are reachable only through
`_generated/functions.ts`**: 361 app modules (347 under `lunora/`, of 534 — 65 %) and 979
dependency modules (largest: `@smithy/core`, `@bufbuild/protobuf`, `e2b`, `@connectrpc/connect`,
`@aws-sdk/client-s3`, `tldts`). The other 187 `lunora/` modules stay loaded because other code
(the generated `app.ts`, `server.ts`, shared builders such as a `crpc` module that imports a
rate limiter that imports app modules) imports them. So the registry change only defers modules
whose ONLY static importer is the registry; the shared graph is the remaining floor, and that
is why the three levers (registry, lazy `app.ts` auth, lighter shared builders) compound.

Cheaper levers, measured as upper bounds (payload replaced by an empty value) on top of the
lazy+split build — all within noise individually, ~8–15 ms together:

| Lever                                                                                                                                                                                  | Result                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `shard.ts` metadata (`LUNORA_ADVISORIES` 1.4 MiB, `LUNORA_ADVISOR_PROCEDURES` 0.4 MiB, `TABLE_COLUMNS`, `TABLE_INDEXES`) is already `JSON.parse("…")` but still parsed at module scope | stubbing: 38 vs 32 ms (noise) |
| `openapi.ts` is an object literal (0.6 MiB at 138 tables) evaluated at module scope                                                                                                    | stubbing: 41 vs 32 ms (noise) |
| both                                                                                                                                                                                   | 24 vs 32 ms (min 10 vs 25)    |

→ worth doing because they are O(tables) and cheap (§6 step 4), but they are not what
decides whether a large app deploys.

Real-app attribution (reported, unminified profile): `@lunora/auth` barrel ~71 ms inclusive,
better-auth/core ~35, `@simplewebauthn/*` ~25, rate-limiter 48, agent modules ~100, zod ~60 self,
`@lunora/values` ~28, schema 19, rls policies 18, lazy-init helper 170–190 self. All of these
are reachable only from function modules except `schema` and the generated-app auth import.

## 6. Proposed work (if approved)

0. **Bundler is not a prerequisite (corrected).** An earlier draft said real code splitting
   was required. The real-app run (§5.1) shows the default single-file wrangler bundle already
   gets most of the win; splitting added nothing. Keep chunking as a follow-up to measure
   _parse_ time once a real chunked (rolldown) artifact is available.
1. **Codegen — manifest + loaders** (`emit/functions.ts`). Lazy compiled validators: emit one
   shim per user module, `_generated/fn/<namespace>.ts`, that imports the module, runs the
   `installCompiledValidatorMap(m.fn.args, …)` calls for its functions and re-exports the
   namespace; the loader is `() => import("./fn/<namespace>.js")`. The first `import()` of a
   module therefore installs its validators exactly once before any dispatch, and the 616
   closures plus ~10k generated lines leave `functions.ts` (1.1 MiB of source in the real app).
   Detail: replace the `import * as` block with
   `const MODULES = { "<file>": () => import("../<file>.js") }`; emit a static
   `LUNORA_FUNCTION_MANIFEST` of `{ kind, visibility, lifecycle }` per path; emit static
   argument descriptors; move `installCompiledValidatorMap(...)` into a per-module
   `afterLoad`. `LUNORA_FUNCTIONS` becomes a per-isolate cache filled by `loadFunction(path)`.
   Keep an `eager: true` codegen/config opt-out and keep today's output for apps below a
   threshold (golden-fixture churn stays confined to new option).
2. **`@lunora/do`**: add `protected async prepareFunction(path)`; await it at the ingress
   points listed in §2; keep the sync predicates.
3. **`@lunora/runtime`**: make the `functions` introspection option accept descriptors.
4. **Cheap levers (independent, land first):** (a) lazy `JSON.parse` for admin-only metadata
   (memoised getters for advisories / advisor procedures / columns / indexes / schema snapshot);
   (b) emit `openapi.ts` / `openrpc.ts` / `architecture.ts` as `JSON.parse` strings behind a
   memoised getter, or as a dynamic `import()` served on the admin route only;
   (c) generated app: `import type` only at module scope for `@lunora/auth`, load via
   `await import("@lunora/auth")` — see §8.
5. **Budget check** next to `worker-size.json`: see §9.

Estimated size: step 1–2 are a multi-file change across `codegen`, `do`, `runtime`; the
emitted shape is covered by golden fixtures and `shard-do` tests. Not small; ship behind the
opt-in first.

## 7. Risks / open questions

- The `executeStream` sync contract and the `isCacheableQuery` memo (reactive cache hit skips
  the dispatch callback; `perDispatch` unknown until load → the first call must load before
  deciding). (A) handles it; needs tests.
- Error timing: a syntax/eval error in one module surfaces on its first call rather than at
  boot. `lunora build`/`deploy` should smoke-load every module (`--check`) so a broken module
  is not found by users.
- Cold-path latency: first call per function per isolate pays module eval. Measure p99.
- Single-file esbuild gives a smaller win and wraps modules; document that the Vite/rolldown
  chunked output is the recommended path for large apps, and test wrangler `find_additional_modules`.
- `createWorker`'s HTTP router and `queues.ts`/`workflows.ts`/`agents.ts` remain eager.

## 8. `@lunora/auth` at the generated-app level (cheap lever)

`_generated/app.ts` statically imports `authDiscoveryPathsFor, createAuth, createAuthAdmin,
createAuthAuditReader, createDoAuthWiring, d1Executor, ensureMigrated,
handleAuthDiscoveryRequest, handleAuthRequest, lunoraD1Adapter` (`emit/app-imports.ts`).
All uses are inside the per-request path, but **not only inside `initAuth`**:

- `initAuth` (`emit-app.ts:100-115`): `createAuth`, `lunoraD1Adapter`, `ensureMigrated` — D1 mode
  only, awaited before `buildWorker` on `fetch`.
- `buildWorkerOptions` (`emit/app-worker-options.ts:180-280`), a **synchronous** function called from
  `buildWorker` on the first `fetch`, `scheduled`, `serverQuery`, `queue` **or `email`**:
  `createDoAuthWiring` + `authDiscoveryPathsFor` (DO-backed mode — no `initAuth` runs
  at all), `handleAuthRequest`, `handleAuthDiscoveryRequest`, `createAuthAdmin`,
  `createAuthAuditReader`, `d1Executor`.

So the names **are** needed outside `initAuth`; a lazy form must make the module available
before `buildWorker`, on _all_ of those entries, not just `fetch`: e.g. `let authModule`,
`const loadAuth = () => (loading ??= import("@lunora/auth").then(m => (authModule = m)))`,
awaited at the top of `fetch`/`scheduled`/`serverQuery`/`queue`/`email` (and in `initAuth`),
and the sync code reads `authModule!`. Only `import type` stays at module scope.

**Exact generated shape** (`emit/app-imports.ts`, `emit-app.ts`, `emit/app-worker-options.ts`):

```ts
// module scope: types only
import type { AuthNamespaceLike, LunoraAuth, LunoraAuthOptions } from "@lunora/auth";
type AuthModule = typeof import("@lunora/auth");

// in assemble(), next to `let auth`
let authModule: AuthModule | null = null;
let authModuleLoad: Promise<AuthModule> | null = null;
const loadAuthModule = (): Promise<AuthModule> => (authModuleLoad ??= import("@lunora/auth").then((module) => (authModule = module)));

// initAuth: const { createAuth, ensureMigrated, lunoraD1Adapter } = await loadAuthModule();
// every entry that can call buildWorker (fetch, scheduled, serverQuery, queue, email):
//   worker ??= buildWorker(env, await loadAuthModule());   // `??=` short-circuits: no await once built
// buildWorker = (env, auth: AuthModule) => createWorker(this.buildWorkerOptions(env, getAuth, auth))
// buildWorkerOptions(env, getAuth, auth): auth.createDoAuthWiring(...), auth.authDiscoveryPathsFor(...),
//   auth.handleAuthRequest(...), auth.handleAuthDiscoveryRequest(...), auth.createAuthAdmin(...),
//   auth.createAuthAuditReader(auth.d1Executor(...))
```

For a framework-hosted app, `withFrameworkWorker(host, (hostEnv) => this.buildWorkerOptions(...))`
runs per request inside the framework, so it reads the cached `authModule!` (loaded by the entry
awaiting `loadAuthModule()` first). DO-backed auth mode never runs `initAuth`, so the entries
must `await loadAuthModule()` unconditionally, not only on the D1 path. The `LunoraAuthDO` class
export from the user's `src/server.ts` and the app's own imports of the barrel (e.g. its
`src/server.ts`, `crpc`) are separate edges the generator cannot change.

**Prerequisite (shipped in #1159).** `@visulima/disposable-email-domains` and
`@visulima/free-email-domains` used to run `fileURLToPath(import.meta.url)` at module scope, so
dynamically importing the `@lunora/auth` barrel (which esbuild wraps in a lazy-init function whose
importers run every statement, including `emailGateDatabaseHooks` → `email-guard`) threw on
Workers. #1159 bumps both packages to versions that resolve the disk loader lazily, so evaluating
the barrel is free of side effects. Re-verify with a `wrangler dev --local` boot of an app that
imports the barrel dynamically before relying on it.

### Why a lazy `lunora/auth.ts` alone shows no gain (reconciling a reported measurement)

A report that making an app's own auth module lazy produced **no** startup gain (median
692 ms vs 554 ms over 5 runs, ±100 ms noise) is consistent with the above, not a
contradiction. In the synthetic app `@lunora/auth` is reachable _only_ through function
modules; in a real app there are at least two more edges: the generated `app.ts` imports the
barrel statically, and shared builder modules (`lib/crpc.ts`) import it too. Cutting one edge
leaves the barrel eager through the others, and in a single-file bundle the wrappers added by
dynamic imports cost about what they save. So **three things have to land together** before a
real app sees the full gain: (1) the lazy function registry, (2) the generated-`app.ts`
lazy auth load above, (3) lighter shared builders / `server.ts` (an app's own `crpc`, rate-limiter
and `src/server.ts` also import the barrel).

## 9. Startup budget next to the size baseline (design; not implemented)

Prototyped against a synthetic app (300 procedures / 60 tables): the eager-reachable module and
byte counts were identical across runs, adding a heavy static import to the shared module raised
them from ~1.2k to ~1.3k modules and from ~6.6 to ~8.9 MiB, and replacing the shared static import
with a dynamic one dropped them to ~0.5k modules and ~3.6 MiB. The text below is the design.

CPU time is too noisy to fail CI on (observed: median 171 ms with a 418 ms max; a median that
moved 36→88 ms between rounds on the same build). Gate on a **deterministic** signal; show CPU
as advisory only.

`scripts/check-worker-size.js` already materializes `templates/standalone` and runs
`lunora build`. Add a sibling `worker-startup.json` + `scripts/check-worker-startup.js`:

1. Materialize a **synthetic fixture** (committed generator; the one used for §5), e.g.
   300 procedures / 60 tables, with a shared module importing `@lunora/auth`/zod. The
   `templates/standalone` app (4 procedures) cannot see this class of regression.
2. **Failing check:** from the build's metafile (`bundle-meta.json` that `lunora build
--out-dir` already writes), compute the **eager-reachable graph** — modules and bytes
   reachable from the entry **ignoring dynamic-import edges** — and fail when module count or
   bytes exceed a committed baseline + allowance. This regresses loudly (a new static import of a
   heavy package from the generated app, or reverting the lazy registry) and never flakes.
3. **Advisory only:** run `wrangler check startup` (median of 9) and print it; no failure.
4. Separate CI job, like the size gate (never `postinstall`: a failing postinstall turns every job
   red). Register in `lint.yml` in the three places the size job is wired.
5. `lunora build` could print the profiled startup time and warn when it exceeds a fraction
   of the 1 s limit. The scale factor between a laptop profile and Cloudflare is **unknown**: the
   only evidence is a ~0.7 s local profile that failed upstream, implying at least ~1.4×. Treat
   any factor (e.g. 2×) as a heuristic and say so in the message.
