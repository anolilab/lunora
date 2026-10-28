# Findings

Framework defects and surprises found while building and measuring `apps/bench`.
Each entry has a repro. Nothing here is fixed on this branch except where the
bench works around it in its own code, which the entry says.

The core and the size-only customer rows were measured at `cf2cc3f75` on
`feat/bench-app` (base `saas-kit` @ `d7133735c`), wrangler 4.149, macOS on a
quiet machine (load average ~2), packages built with `build:prod`. The heavy-SDK
customer rows and the cold-start and chunked results are newer; they are given
below with their own commit and load.

## Startup: what the bench measures

`node scripts/startup.mjs [--preset customer] --runs 9`: 9 interleaved runs per
mode on the frozen `lunora build` bundle (wrangler single-file esbuild, minified).

| Size                           | Mode  | Active ms med / min / max | Eager modules / all | Eager source | Registry-only modules (app of lunora/) | Bundle (gz)    |
| ------------------------------ | ----- | ------------------------- | ------------------- | ------------ | -------------------------------------- | -------------- |
| core (80 fn / 21 tables)       | eager | 75.4 / 73.9 / 82.0        | 2,479 / 2,625       | 14.3 MiB     | 19 (17 of 39)                          | 7.8 (2.1) MiB  |
| core                           | lazy  | 91.6 / 89.7 / 96.7        | 2,461 / 2,641       | 14.2 MiB     | 1                                      | 7.9 (2.1) MiB  |
| 40 domains, no heavy SDKs      | eager | 105.7 / 104.7 / 114.7     | 2,749 / 2,895       | 19.1 MiB     | 289 (287 of 309)                       | 12.3 (2.2) MiB |
| 40 domains, no heavy SDKs      | lazy  | 112.3 / 108.6 / 117.9     | 2,461 / 3,141       | 18.6 MiB     | 1                                      | 12.8 (2.3) MiB |
| customer (999 fn / 131 tables) | eager | 158.0 / 156.1 / 164.7     | 3,529 / 3,674       | 21.8 MiB     | 1,069 (307 of 329)                     | 13.2 (2.5) MiB |
| customer                       | lazy  | 114.6 / 113.8 / 116.3     | 2,461 / 3,940       | 18.7 MiB     | 1                                      | 13.7 (2.5) MiB |

The `customer` rows have 5 runs at `6e38c7888` (load 2.3 → 2.7). That preset is
40 domains with `--heavy-share 0.5`; the "no heavy SDKs" rows are the earlier
preset, now `--domains 40`.

Plan 490 §5.1's real app (about 1,000 functions, ~130 tables, 11.1 MiB minified)
measured, on a machine at load ~16:

- **eager:** 364 / 421 ms (min / median);
- **lazy loaders:** 267 / 290 ms (−31 %);
- **graph:** 4,088 modules / 29.2 MiB, of which 1,340 modules / 5.95 MiB were
  registry-only (361 app modules and **979 dependency modules**).

**Without heavy SDKs, the customer size matched the real app's size but not its
profile.** The generated domains imported only `lib/crpc`, zod and
`@lunora/values`, which were already eager, so the registry had nothing heavy to
defer. Lazy loading made that app 6 % slower, which matches plan 490 §5's
synthetic app.

**With heavy SDKs, the preset has the real app's profile.** Half of the domains
now have an action module on an SDK that only the registry reaches. Lazy loading
then saves **27 %** (real app: 31 %). Of the eager graph, 30 % is registry-only
(real app: 33 %). The largest registry-only packages are `@smithy/core`,
`@bufbuild/protobuf`, `@connectrpc/connect`, `@aws-sdk/client-s3`, `e2b` and
`tldts`, the same names as in the real app. The lazy eager graph stays at the
core's 2,461 modules, so none of the SDKs leak into startup.

Calibration, against the real app:

| Metric                          | Bench customer    | Real app (§5.1)   |
| ------------------------------- | ----------------- | ----------------- |
| Functions / tables              | 999 / 131         | ~1,000 / ~130     |
| Eager modules (all)             | 3,529             | 4,088             |
| Registry-only modules           | 1,069 (30 %)      | 1,340 (33 %)      |
| of which dependency modules     | 762               | 979               |
| Registry-only bytes             | 3.97 MiB          | 5.95 MiB          |
| Registry-only `lunora/` modules | 307 of 329 (93 %) | 347 of 534 (65 %) |
| Bundle, minified                | 13.2 MiB          | 11.1 MiB          |
| Eager Active, median            | 158 ms (load ~2)  | 421 ms (load ~16) |
| Lazy Active, median             | 115 ms (−27 %)    | 290 ms (−31 %)    |

The remaining gaps are left as they are, because closing them would mean
overfitting:

- **Absolute Active ms is about 2.7× lower.** Part of that is load (~2 against
  ~16). Part is the real app's ~100 ms of agent modules, which the bench does not
  model: it has one agent.
- **The app-module split differs.** In the real app, 187 `lunora/` modules stayed
  eager through shared builders that import app modules. The bench's `crpc`
  imports none, so 93 % of its app modules are registry-only, against 65 %.
- **About 220 fewer dependency modules.** The real app's exact SDK set is not
  known beyond the package names listed above.

**Where the bench's startup goes** (eager graph source bytes, core):

| Package                         | Source   |
| ------------------------------- | -------- |
| `@cloudflare/playwright`        | 3.1 MiB  |
| zod                             | 1.1 MiB  |
| better-auth                     | 1.0 MiB  |
| stripe                          | 1.0 MiB  |
| ai                              | 0.7 MiB  |
| kysely                          | 0.65 MiB |
| unused `@better-auth/*` plugins | 0.74 MiB |

Findings 1 and 2 are the two that a lazy registry cannot reach.

## Chunked builds: rolldown vs the single-file bundle

`node scripts/chunked.mjs`: 7 interleaved `wrangler check startup` runs per
artifact; Active ms median / min / max; JS modules and bytes of the frozen upload.

| Artifact                      | core (load 1.9 → 2.5)  | customer (load 1.7 → 1.8) | Modules core / customer | JS bytes, customer |
| ----------------------------- | ---------------------- | ------------------------- | ----------------------- | ------------------ |
| esbuild single file, eager    | 75.8 / 75.0 / 76.9     | 163.1 / 159.9 / 165.5     | 1 / 1                   | 13.16 MiB          |
| esbuild single file, lazy     | 91.4 / 90.9 / 93.5     | 114.1 / 113.7 / 119.2     | 1 / 1                   | 13.66 MiB          |
| rolldown chunks, eager        | **does not boot**      | 104.6 / 103.2 / 108.6     | 32 / 60                 | 12.57 MiB          |
| rolldown chunks, lazy         | **47.8** / 46.3 / 51.3 | **55.6** / 54.4 / 55.8    | 65 / 391                | 12.88 MiB          |
| rolldown, strict order, eager | 133.7 / 132.6 / 133.9  | 202.3 / 199.5 / 203.4     | 39 / 62                 | 12.76 MiB          |
| rolldown, strict order, lazy  | 125.2 / 124.3 / 126.2  | 153.7 / 153.4 / 154.5     | 72 / 390                | 13.09 MiB          |

Core at `a6af40122`, customer at `00cde8ca9`; both rolldown builds are
`vite build --minify` (Vite 8.3.5).

- **A chunked lazy build starts 3× faster than the eager single file:** 55.6
  against 163.1 ms on the customer preset, and 48 against 76 ms even on the core.
  With chunks, a module behind `import()` is uploaded but never compiled or run at
  startup. In a single file it is at least parsed, and it carries esbuild's
  lazy-init wrappers. Plan 490 §5.1 measured esbuild `--splitting` on the real app
  and saw no gain. That result does not carry over to rolldown chunks.
- **These numbers do not justify shipping chunked lazy builds yet:**
    - The default rolldown output's evaluation order is not safe. The eager core
      does not boot (finding 15). The order-safe `strictExecutionOrder` output is
      the slowest artifact here.
    - A parallel branch (`test/lazy-input-gate`) found that a real `import()` in a
      chunked or uploaded-module build yields to the event loop, which broke Durable
      Object request ordering. This branch does not include that fix, and the
      chunked lazy artifacts were not exercised at runtime here, only profiled at
      startup.
- **Active may not count compile time.** Whether `wrangler check startup`'s
  Active includes V8 parse and compile time is not documented. If it does not,
  neither the single file's parse of deferred code nor the chunks' compile of
  imported modules is counted, so the real difference could be larger or
  smaller.

## Cold start

See finding 18: the cost a lazy registry moves to first calls is small (about
+11 ms over 60 first calls on the customer preset, ~16 ms p95 for a heavy-SDK
action).

---

## 1. Builder-wired integrations put their SDK on the startup path (high)

`defineApp().browser((env) => createBrowser({ binding, launch }))` is the form
codegen documents. It needs `launch` from `@cloudflare/playwright` as a
module-scope import in the Worker entry. That puts 276 modules / 3.1 MiB into
every isolate's startup, for a feature only an action uses.

The same shape applies to:

- `.hyperdrive()` (postgres);
- `.payment()` (stripe, 1 MiB);
- the MCP route (`@modelcontextprotocol/sdk` + ajv, 0.44 MiB);
- the x402 charge gate.

The entry file imports these, so neither the lazy registry nor `authModule.ts`
can defer them.

**Repro:**

1. Run `node scripts/startup.mjs --modes eager` on the core.
2. In `lunora/server.ts`, replace `launch` with
   `async (...a) => (await import("@cloudflare/playwright")).launch(...a)`.
3. Re-run.

Result: Active **75.4 → 66.0 ms (−12 %)**, eager modules 2,479 → 2,201, eager
source 14.3 → 11.25 MiB. That run was not interleaved, but the module and byte
counts are deterministic.

**Suggestion:** document the deferred-`launch` form, or have the capability
selectors accept an async factory that the runtime awaits on first `ctx.<cap>`
use. Plan 490 §8's "lighter shared builders" lever should cover the entry file
too.

## 2. `@lunora/auth/plugins` pulls unused better-auth plugins into startup (medium)

The app uses only `organization`, `admin`, `passkey`, `twoFactor` and
`uiConfig`. Even so, `packages/auth/dist/plugins.mjs` statically imports the
following, and they land in the eager graph:

- `@better-auth/oauth-provider`
- `@better-auth/scim`
- `@better-auth/api-key`
- `@better-auth/mcp`
- `@better-auth/cimd`

Together they are 14 modules / 753 KiB that the app never calls. `uiConfig` lives
only in that barrel, so an app cannot import around it. This is the "auth barrel"
cost in plan 490 §5.1.

**Repro:** build the core. In `.bench/out-eager/bundle-meta.json`, the importer of
`@better-auth/scim/dist/index.mjs` is `packages/auth/dist/plugins.mjs`.

**Suggestion:** one subpath per plugin (`@lunora/auth/plugins/scim`, …), or mark
the barrel's re-exports side-effect free so esbuild drops the unused ones.

## 3. Advisors don't see rate limits applied in a shared builder module (medium)

`tasks:create` is `orgMutation.use(...)`, and `orgMutation` is
`mutation.use(rateLimit(...))` in `lunora/lib/crpc.ts`. Codegen nevertheless
reports `public_mutation_without_ratelimit` for every such procedure: 15 at core
size. It also reports `privileged_fanout_from_public_procedure` for
`onboarding:start`.

At the customer preset, codegen prints **2,344 advisories**. That is enough noise
that a real one goes unread. (Most of those 2,344 are `cross_module_table_write`,
which comes from the generator declaring its tables through a schema extension;
that part is the bench's doing, not a defect.)

**Repro:** `pnpm --filter @lunora/bench run codegen` lists
`public_mutation_without_ratelimit — Public mutation create (tasks/index)`.

**Suggestion:** resolve `.use()` through imported builder bindings, which is the
`crpc` pattern plan 490 §5.1 describes, or let a builder declare that it is
rate-limited.

## 4. `rls()` does not type-check on the generated `QueryCtx` / `MutationCtx` (medium)

The documented form `query.use(rls(definePolicies([...])))` fails `tsc`:

- `rls<Context extends RlsContextIn>` requires `db: DatabaseWriterLike`;
- the generated reader facade lacks `aggregate`, `count`, `delete` and other
  writer members;
- `RlsContextIn` is not exported, so a generic helper cannot name the constraint.

`examples/clerk-auth`, `examples/workos-auth` and the playground all cast:
`rls(p) as unknown as Middleware<QueryCtx, QueryCtx>`. The bench does the same,
once, in `lib/crpc.ts`.

**Repro:** `export const x = query.use(rls(definePolicies([]))).query(async () => null);`
makes `tsc` report TS2345 (`'Middleware<RlsContextIn, RlsContextIn>' is not assignable …`).

## 5. A bad capability config breaks every action, not just its own surface (medium)

`createBrowser({ allowedHosts: ["*.github.com"] })` throws `allowedHosts entry
"*.github.com" contains "*"`. Because the `.browser()` factory runs for every
action context, the throw also failed the onboarding workflow's **mail** step,
which never touches `ctx.browser`. It failed 5 attempts with that browser error.

`templates/saas/lunora/server.ts` already works around the same class of bug for
Stripe with lazy getters.

**Repro:** set that `allowedHosts`, call `onboarding:start`, and inspect the
instance at `/cdn-cgi/local/explorer/api/workflows/onboarding/instances/<id>`.

**Suggestion:** build capability facades lazily on first property access, so a
misconfigured capability fails only the calls that use it. Or validate the
config at `build()`, so it fails loudly at startup.

## 6. `.route()` documents prefix matching, but the runtime matches exact paths (medium)

The generated JSDoc says: `Key is "METHOD path", "path", or a path prefix matched
by the runtime`. `explicitRouteFor` in `packages/runtime/src/create-worker.ts`
does only `customRoutes["METHOD path"] ?? customRoutes[path]`.

The `storage` registry item's `/storage/*` route therefore cannot be mounted with
`.route("/storage/", …)`: every signed URL 404s. The bench mounts it on the
`httpRouter` wildcard instead (`lunora/http.ts`).

**Repro:** `.route("/storage/", handler)`, then `curl /storage/x` returns 404.

## 7. Presence rooms are caller-named in the registry item and templates/saas (medium, security)

In `registry/presence/presence.ts` (and its byte-identical copy
`templates/saas/lunora/presence/index.ts`), `heartbeat` and `listPresent` take
`roomId` from the caller with no membership check. On any shard a caller can
reach, a signed-in or anonymous user can read any room's roster: user ids,
session ids and awareness data. They can also join any room.

**In templates/saas** the shard gate confines this. Rows are written on the
tenant's shard (`shardKey: organizationId`), and `authorizeShard` admits only the
caller's active organisation and `__root__`. Other tenants' rooms are therefore
unreachable. The `__root__` shard is still open to every signed-in user, though,
and any room created there is shared by everyone.

**In a single-shard app** (the item's default use), nothing confines it.

**Repro** (single shard):

1. User A heartbeats `{ roomId: "doc-1", sessionId: "s" }`.
2. User B calls `presence:listPresent({ roomId: "doc-1" })`.
3. B receives A's row.

**Suggested fix for the item:** take a room authorizer in the copied file
(`authorizeRoom(ctx, roomId)`, defaulting to "the caller belongs to the room",
or derive room ids from a server-side membership), and refuse when it fails.
The bench copy requires the active organisation and a room id of `<org>` or
`<org>:…` (`lunora/presence/index.ts`). It was verified locally: a foreign room
returns `FORBIDDEN`.

## 8. Workflow `ctx.run` returns `Promise<unknown>` (low)

`WorkflowRunFunction = <F extends FunctionReference>(fn: F, args?, opts?) =>
Promise<unknown>` (`packages/workflow/src/types.ts:275`). The typed reference's
return type is discarded, so every result needs a cast (`lunora/workflows.ts`).

**Suggestion:** return the reference's result type.

## 9. Only the playground guards against a stale `LUNORA_ORIGIN_URL` (medium)

Scheduler, workflow and agent callbacks dispatch to `LUNORA_ORIGIN_URL`. The
playground's `vite.config.ts` refuses to start when that variable names another
port. `@lunora/vite` does not, so no other app has the guard.

The bench's first `.dev.vars` had the main checkout's `:5173`, while this
worktree serves `:40973`. Every onboarding workflow step was then dispatched into
**another checkout's running playground**, which returned 404 and was retried 5
times. Nothing pointed at the cause.

**Repro:** set `LUNORA_ORIGIN_URL` to another running dev server and call
`onboarding:start`.

**Suggestion:** move `staleDevOrigin` into `@lunora/vite`, so every app refuses
the mismatch. The bench copies the playground's guard for now.

## 10. templates/saas has `.shardBy()` tables but no shard registry (low)

The saas template binds only `SHARD`. Without `.shardRegistry()` and a
`SHARD_REGISTRY` Durable Object, the builder's own JSDoc says that cross-shard
export, CDC sync and migrations refuse a `.shardBy()` table. The bench adds both.

## 11. The API spec choice is not project configuration (low)

`_generated/openrpc.ts` exists only when every entry point asks for it:

- the Vite plugin option `apiSpec`;
- `lunora codegen --api-spec`;
- `lunora build --api-spec` (refused when a framework build runs; read from a
  marker file otherwise).

A plain `lunora codegen` deletes it, and the MCP route's import then breaks `tsc`
and the build. The bench passes `both` in all three places.

## 12. First request logs a better-auth "Database schema mismatch" error (low)

`resolveIdentity` uses the kit's second auth instance (`getAuth`). On a fresh
`.wrangler` state, that instance runs before `.auth()`'s `ensureMigrated`, so the
first `GET /` logs `ERROR [Better Auth]: Database schema mismatch — Missing tables
user, session, …` twice. Later requests are fine.

**Repro:** `rm -rf .wrangler && pnpm dev`, then open the page.

## 13. Smaller items (low)

- `lunora build` refuses a placeholder D1 `database_id` and offers no override, so
  a measurement build needs a fake UUID (the bench uses
  `00000000-0000-4000-8000-000000000000`).
- Every bundle prints esbuild's `ignored-bare-import` warning for
  `packages/wire/dist/packem_shared/stableWireKey-*.mjs`, which imports
  `./isPlainObject-*.mjs` for side effects in a `sideEffects: false` package.
- `registry/auth/registry.json` `docs` says "Mount handleAuthRequest in your Worker
  entry (see the README)". The README does not mention it, and `defineApp().auth()`
  is the path.
- Registry copies do not pass the repo's own app ESLint preset (for example,
  `storage` line 202 `different-types-comparison`). The bench excludes them from
  lint.
- The `storage` item's error text (``Pass `resolveIdentity` to `createWorker` ``)
  trips the repo's secret scanner (kingfisher.generic.4) once copied.
  `registry/**` is excluded from the scan, so this was never seen. The bench copy
  carries a `secret-scanner:allow`.
- `@anolilab/eslint-config`'s zod plugin rewrites `import { z }` to
  `import * as z`, which `import/no-namespace` then rejects.
- `lunora dev` logs "set one provider's secret pair" for `@lunora/payment` at
  error level, although the kit runs fine without it.

## 14. A `vite build` silently redirects every later wrangler command to `dist/` (high, for measurement)

After a `vite build`, `@cloudflare/vite-plugin` leaves `.wrangler/deploy/config.json`
(`{"configPath":"../../dist/<worker>/wrangler.json"}`). From then on, `wrangler
deploy --dry-run`, `wrangler check startup` and `lunora build --no-framework-build`
all use the Vite output in `dist/` instead of `wrangler.jsonc` and the source.
Nothing in their output says so.

On this branch, one `vite build` made every later startup bench measure a stale
rolldown build of the core. That build does not boot (finding 15), so the bench
failed with wrangler's generic "bindings that cannot be reproduced locally"
message. Builds that do boot would have produced numbers for the wrong artifact.

**Repro:**

1. `vite build`.
2. `lunora build --no-framework-build --out-dir out`.

`out/` then holds the Vite build's `index.js` and chunks, not `server.js`.

**Bench workaround:** `buildWorker` (`scripts/worker-startup-measure.js`) refuses
to run while the redirect exists, and `chunked.mjs` removes the redirect after each
Vite build.

**Suggestion:** have `lunora build --no-framework-build` ignore or refuse the
redirect, since the flag says no framework build is involved.

## 15. Rolldown's default output of the core app does not boot (high, for the Vite deploy path)

`vite build` of the core app (with or without `--minify`) fails at module
evaluation: `Uncaught Error: tsyringe requires a reflect polyfill`.

- `@simplewebauthn/server` (from `passkey()`) imports `@peculiar/x509`, which
  imports `reflect-metadata` (CommonJS) and then `tsyringe` (ESM).
- In rolldown's output, the hoisted `tsyringe` module runs before the CJS polyfill
  it depends on.

The lazy core build boots, and so do both customer builds. Whether a build boots
therefore depends on the shape of the graph, so an unrelated change can break a
deploy.

rolldown's `output.strictExecutionOrder: true` fixes it, at a high cost. Active
becomes 1.9–2.8× that of the default output, and slower than the esbuild bundle:
134 against 76 ms on the core, 202 against 163 ms on the customer preset (see
"Chunked builds" above). Only local `wrangler check startup` and `wrangler dev`
were run; no deploy was attempted.

**Repro:** `node scripts/chunked.mjs --preset core` reports `rolldown-eager`
as failed. `wrangler dev --local` on that output prints the tsyringe error.

**Suggestion:** have `@lunora/vite` set `strictExecutionOrder` for the worker
environment, or add a smoke-load of the Vite output to `lunora build`/`deploy`
(today it covers only lazy esbuild builds), so the failure shows up before
upload.

## 16. `ctx.env` is undefined without `lunora/env.ts`, and the types allow reading it (medium)

`ActionCtx.env` is typed `Record<string, unknown> | undefined`. It is populated
only when the app declares a `defineEnv` contract in `lunora/env.ts`. The common
`ctx.env as unknown as { KEY?: string }` therefore compiles and reads nothing. The
bench had two such reads:

- **The generated S3 action.** It failed with
  `Cannot destructure property 'S3_ACCESS_KEY_ID' of 'ctx.env'`.
- **`authAction`'s `getAuth(ctx.env as unknown as AuthEnv)`.** This one worked
  only because `getAuth` memoises the instance that `resolveIdentity` had already
  built in the same isolate. Locally, the Worker and the Durable Object share an
  isolate. A Durable Object isolate that never served a Worker request would
  have thrown.

The bench now declares `lunora/env.ts`, and nothing reads `authApi`. The
`@lunora/server` `env.ts` docblock says Workers receive their secrets "on
`ctx.env` in actions", which holds only with a contract.

**Suggestion:** without a contract, either type `ctx.env` as `undefined` or emit
an advisory on any `ctx.env` read. Otherwise, populate it with the raw `env`.

## 17. A hand-written function reference to a wrong path compiles and fails at runtime (low)

Registry keys flatten directories with `_` and drop `index`. `lunora/assistant/
index.ts`'s `searchTasks` is `assistant:searchTasks`, and a generated domain's
`queries.ts` `list` is `domains_<key>_queries:list`.

The support agent's tools dispatched
`{ __lunoraRef: "assistant/index:searchTasks" }`. That compiles, because
`AgentFunctionReference` is structural, and fails with `FUNCTION_NOT_FOUND` on
every call. Neither tool had ever worked.

**Fixed in the bench:** the tools use `internal.assistant.*`.

**Suggestion:** have the agent tool `run` accept only generated references, or
have codegen check `__lunoraRef` literals against the registry.

## 18. Lazy loading costs little at the first call (measurement)

`node scripts/cold-start.mjs --preset customer`: 20 isolates per mode, 60
functions, 2 warm rounds, at `b309bc448`, load 2.1 → 2.7, 0 failures. Figures are
ms p50 / p95 / p99.

| Metric                          | eager                 | lazy                  |
| ------------------------------- | --------------------- | --------------------- |
| boot (start → ready)            | 586 / 594 / 596       | 595 / 608 / 608       |
| first response (`saas:me`)      | 643 / 652 / 655       | 617 / 628 / 628       |
| cold → first response           | 1,228 / 1,242 / 1,248 | 1,212 / 1,229 / 1,235 |
| first call per function, all    | 4.0 / 9.0 / 23.6      | 4.2 / 10.9 / 16.8     |
| first call, heavy-SDK action    | 3.4 / 8.9 / 24.0      | 3.5 / 15.9 / 17.7     |
| first call, plain query         | 4.2 / 9.0 / 23.4      | 4.4 / 9.2 / 11.5      |
| all 60 first calls, per isolate | 287 / 323 / 330       | 298 / 345 / 349       |
| warm call                       | 3.5 / 8.6 / 10.0      | 3.5 / 8.6 / 12.7      |

- **Lazy moves startup CPU to first calls, and the cost there is small.** The
  ~43 ms saved at startup reappears as about +11 ms (median) across all 60 first
  calls. The heavy-SDK actions pay most of it: their p95 rises from 9 to 16 ms.
  No first call exceeded ~18 ms p99 in lazy mode.
- **The first response is ~25 ms faster in lazy mode.** It is the only
  wall-clock figure that moves, and it moves by about the startup CPU difference.
- **One cost dominates a local cold start, and it is not module evaluation.**
  About 600 ms of boot plus about 620 ms for the first response go to something
  else, the same in both modes. The cause is not established. Candidates are
  better-auth's per-isolate migration check (finding 12) and the identity
  lookup; this was not profiled.
