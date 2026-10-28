# Findings

Framework defects and surprises found while building and measuring `apps/bench`.
Each entry has a repro. Nothing here is fixed on this branch except where the
bench works around it in its own code, which the entry says.

Measured at `cf2cc3f75` on `feat/bench-app` (base `saas-kit` @ `d7133735c`),
wrangler 4.149, macOS on a quiet machine (load average ~2), packages built with
`build:prod`. The later security fix (`ae4a383ae`) adds one internal action and
no imports, so it leaves the eager graph effectively unchanged.

## Startup: what the bench measures

`node scripts/startup.mjs [--preset customer] --runs 9`: 9 interleaved runs per
mode on the frozen `lunora build` bundle (wrangler single-file esbuild, minified).

| Size                           | Mode  | Active ms med / min / max | Eager modules / all | Eager source | Registry-only modules (app of lunora/) | Bundle (gz)    |
| ------------------------------ | ----- | ------------------------- | ------------------- | ------------ | -------------------------------------- | -------------- |
| core (80 fn / 21 tables)       | eager | 75.4 / 73.9 / 82.0        | 2,479 / 2,625       | 14.3 MiB     | 19 (17 of 39)                          | 7.8 (2.1) MiB  |
| core                           | lazy  | 91.6 / 89.7 / 96.7        | 2,461 / 2,641       | 14.2 MiB     | 1                                      | 7.9 (2.1) MiB  |
| customer (970 fn / 131 tables) | eager | 105.7 / 104.7 / 114.7     | 2,749 / 2,895       | 19.1 MiB     | 289 (287 of 309)                       | 12.3 (2.2) MiB |
| customer                       | lazy  | 112.3 / 108.6 / 117.9     | 2,461 / 3,141       | 18.6 MiB     | 1                                      | 12.8 (2.3) MiB |

Plan 490 §5.1's real app (about 1,000 functions, ~130 tables, 11.1 MiB minified)
measured, on a machine at load ~16:

- **eager:** 364 / 421 ms (min / median);
- **lazy loaders:** 267 / 290 ms (−31 %);
- **graph:** 4,088 modules / 29.2 MiB, of which 1,340 modules / 5.95 MiB were
  registry-only (361 app modules and **979 dependency modules**).

**The customer preset matches the real app's size, not its profile.** It has the
same function count, table count and bundle size. It runs about 4× faster, and
the lazy registry makes it slower (+6 %) instead of 31 % faster.

The registry-only part explains it. In the bench, the generated domains import
only `lib/crpc`, zod and `@lunora/values`, and all of those are already on the
startup path through `lunora/server.ts`. So 287 of the 289 registry-only modules
are cheap app modules. Deferring them saves less than esbuild's lazy-init wrappers
cost, which is the same result as plan 490 §5's synthetic app.

In the real app, the registry was the only importer of heavy SDKs:
`@aws-sdk/client-s3`, `@smithy/*`, `@bufbuild/protobuf`, `e2b`,
`@connectrpc/connect` and `tldts`.

The other gaps:

- the real app had 534 `lunora/` modules against the bench's 309;
- its agent modules alone cost ~100 ms;
- its measurements were taken under load ~16, against ~2 here.

To bring the preset closer, add a generator option that gives some domains an
action-only heavy SDK that only the function module imports. It is not
implemented here.

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
