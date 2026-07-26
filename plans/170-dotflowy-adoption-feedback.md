# 170 — Dotflowy adoption feedback (external PR #310)

**Source:** [cameronapak/dotflowy#310](https://github.com/cameronapak/dotflowy/pull/310) — "Lunora outline sync as opt-in beta", 104 files / +11.4k lines, head `22ba774`.
**Versions in use:** `lunorash@1.0.0-alpha.98`, `@lunora/react@1.0.0-alpha.31`, `@lunora/db@1.0.0-alpha.27`, `@lunora/ratelimit@1.0.0-alpha.9`.

This is the first substantial third-party production port onto Lunora: an existing outline
editor replacing a hand-rolled per-user-DO sync engine with `defineTable().shardBy()` +
`defineShape` + `defineMutator` + `@lunora/db` mutators, composed _beside_ an existing
Better Auth / Stripe / MCP Worker. Every workaround in it is a spec for something Lunora
should own. Findings below are ordered by severity; each states the evidence.

> **Status.** All 21 findings are implemented in PR #187, so the "**Fix.**" paragraphs
> below read as the rationale for changes that have already landed, not as a proposal.
>
> The three sub-items initially deferred are now done too: the advisor lint behind
> `deny()` (`unrestricted_where_branch`), `ctx.db.asId` narrowed to the generated
> `TableName` plus `AppTableName` so an add-on's tables stop leaking into an app's
> table unions, and the Studio panel over `client.debug()`.
>
> Two limits worth knowing, both deliberate. `dist:check` (#1) greps only React
> dev-JSX markers, so it proves the React-family packages are production builds but
> does not verify minification or `NODE_ENV` folding for the rest. And the Studio
> panel (#21) introspects the client running in the Studio page, not the client in
> your application — diagnosing a specific stuck overlay still means calling
> `client.debug()` in the app itself.
>
> **Review caught three defects in the fixes themselves**, worth recording because
> each is a trap the next person may re-enter: `deleteAll` pinned `expectedTable`,
> which blocks the DO's global fallback, so erasing a `.global()` table was a silent
> no-op (inflated count, surviving rows, and an infinite loop past `chunkSize`);
> `guardShardSweep` gated global tables that `wipeShard` never touches, so one
> protected global table denied an otherwise-legal wipe; and the `asId` narrowing
> (#10) was defeated by its own wide `(string, string) => string` fallthrough
> overload, which overload resolution reaches for exactly the misspelled literal the
> narrowing was meant to reject — the fix is a conditional `AsIdTable<T>` instead.

---

## P0 — Confirmed defects

### 1. Every published `@lunora/*` package is a **development** build

`packages/react/package.json:57`:

```json
"build":      "pnpm exec packem build --development",
"build:prod": "pnpm exec packem build --production",
```

`.github/workflows/semantic-release.yml:119` runs `pnpm run build:packages` →
`vis run build` → the `build` script. `build:prod` is **never invoked by the release
pipeline**. 45 of 48 packages carry the `--development` `build` script; all 48 have an
unused `build:prod`.

Verified against the registry — `npm pack @lunora/react@1.0.0-alpha.31`:

```
dist/packem_shared/LunoraProvider-BsuiW4Lk.mjs:  from 'react/jsx-dev-runtime'
                                                 jsxDEV(LunoraContext, …)
                                                 jsxDEV(QueryClientProvider, …)
dist/packem_shared/CheckoutButton-DUite8jJ.mjs:  from 'react/jsx-dev-runtime'
```

The shipped React entry points import the **dev** JSX runtime. Any consumer whose bundler
stubs or drops `react/jsx-dev-runtime` in a production build gets `jsxDEV is not a
function` the moment `<LunoraProvider>` mounts. Dotflowy hit exactly this and shipped
a workaround — `scripts/react-jsx-dev-runtime-shim.ts` plus a `vite.config.ts` alias:

```ts
// @lunora/react ships precompiled `jsxDEV` imports; Vite's prod React
// stub leaves jsxDEV undefined (LunoraProvider crash under cf:dev).
"react/jsx-dev-runtime": new URL("./scripts/react-jsx-dev-runtime-shim.ts", import.meta.url).pathname,
```

Blast radius: `react`, `vue`, `svelte`, `solid`, `angular`, `client` all ship JSX/dev
output; the other 39 packages ship whatever else `--development` implies (unminified,
dev-only branches retained, no `NODE_ENV` folding).

**Fix.** Release must build `--production`. Either point the workflow at `build:prod`,
or make `build` production and add `build:dev` for local iteration. Add a publish-time
guard (`api:check`-style) that greps every `dist/**` for `jsx-dev-runtime` and fails.
This is a one-line pipeline change with a large correctness payoff and should land before
any further alpha releases.

### 2. Per-collection checkpoint registries break multi-collection shards

`packages/db/src/collection-options.ts:175` mints a **fresh** `CheckpointRegistry` per
`lunoraCollectionOptions()` call. But `clientSeq` is per-**client, per-shard** — one FIFO
push chain in `bindMutators` (`define-mutators.ts:125`) covers _all_ collections bound
together. So when `upsertTagColor` advances the shard watermark, only the `tagColors`
registry hears the poke; the `nodes` registry's `awaitMutationId` never resolves and the
transaction's `isPersisted` hangs.

Dotflowy monkey-patches `resolve` to fan pokes across registries
(`src/data/lunora-outline-store.ts:61`):

```ts
function relayCheckpoints(from: CheckpointRegistry, to: CheckpointRegistry): void {
    const orig = from.resolve.bind(from);
    from.resolve = (watermark) => {
        orig(watermark);
        to.resolve(watermark);
    };
}
```

Note also the asymmetry that invites the bug: `BindMutatorsContext` takes
`collections` (plural) but `checkpoints` (singular).

**Fix.** Make the registry **shard-scoped and shared**: keyed by `shardKey` on the client
(or an explicit `checkpoints` you can create once and pass into every
`lunoraCollectionOptions` call for that shard). Then `bindMutators` needs no
`checkpoints` argument at all — it can derive it from `client` + `shardKey`.

### 3. `bindMutators` transactions are dropped as stale by TanStack DB

`bindMutators` builds its transaction with `metadata: { serverRef }` only
(`define-mutators.ts:171`). Dotflowy found that completing `mutationFn` without
TanStack's "direct transaction" marker makes TanStack discard the optimistic rows as
stale — reverting typed text to the last synced value. Their patch
(`src/data/lunora-checkpoints.ts:24`):

```ts
export const DIRECT_TRANSACTION_METADATA_KEY = "__tanstack_db_direct";
// String literal on purpose: `@tanstack/db` doesn't re-export the constant
// from its package root (lives under `collection/transaction-metadata`).
```

…wrapped around every bound mutator via `withDirectOptimisticMetadata`.

**Fix.** Set the flag inside `bindMutators`. Regression test: mutate → let the checkpoint
fall back → assert the optimistic value survives. If the constant genuinely isn't
exported by `@tanstack/db`, pin the literal in one place in `@lunora/db` with a test that
fails when the upstream key changes.

### 4. Shape-poke vs RPC-ack ordering drops overlays early

For a `shape` source, `collection-options.ts:214` only resolves the registry from
`onCheckpoint`. For a `list` source it _also_ resolves from
`confirmedMutationWatermark`. Dotflowy's finding is that resolving on the RPC ack drops
the overlay **before** `wholeOutline` contains the new row — visible flicker — while
waiting only on the poke hangs forever if a poke is missed. They wrote a whole policy
layer, `shapeFirstCheckpoints` (`src/data/lunora-checkpoints.ts:61`): wait on the shape
gate; arm a 3 s fallback once the RPC watermark has caught up; suppress unhandled
rejections from the shape wait.

They cared enough to build an e2e switch (`suppressWholeOutlinePoke`) to reproduce the
missed-poke path.

**Fix.** This policy belongs in `@lunora/db`, not in every app. Ship shape-first-with-
fallback as the default `CheckpointRegistry` behaviour, with the fallback window
configurable and observable (emit a warning/metric when the fallback fires — a fallback
that fires often means pokes are being lost, and today nobody would notice).

---

## P1 — Missing abstractions the app had to build

### 5. No supported server-side RPC into a shard

Dotflowy's Worker MCP needs to call shard functions from a plain (non-Lunora) Worker.
`@lunora/runtime` exports `resolveShard`, which returns a raw `{ fetch }` stub — so they
hand-rolled the whole protocol (`worker/lunora-mcp-store.ts:76`): the
`https://shard.internal/rpc` URL, the `{ functionPath, args }` body, the
`x-lunora-userid` / `x-lunora-system` headers, envelope decoding, and status-vs-envelope
error disambiguation. All of it undocumented internal protocol, all of it untyped
(`functionPath` is a string; the result is `unknown` and re-decoded with Effect Schema).

`x-lunora-system` in particular is a **trust-boundary** header. Lunora is right to strip
forged copies at the Worker edge (`create-worker.ts` + the test at
`runtime/__tests__/create-worker.test.ts:1862`) — but the moment a user's own Worker holds
the DO binding, the safety of that call depends on them reading the source correctly.

**Fix.** Ship a first-class typed server client:

```ts
const shard = createShardClient(env.SHARD, { as: { userId } }); // or .asSystem()
const nodes = await shard.call(internal.mcp.listNodes, { userId }); //  typed args + return
```

Codegen already knows every `internalQuery`/`internalMutation` path and its arg/return
validators — emit `internal.*` references and a `_generated/server-client.ts`. This
removes ~90 lines of protocol code and one class of security footgun per adopter, and it
is the natural pairing for the "compose Lunora beside an existing Worker" story the whole
PR is built on.

### 6. Codegen's `_generated/collections.ts` is unusable for real apps

What codegen emits for their four shapes:

```ts
export const wholeOutlineCollection = (client: LunoraClient, args?: Record<string, unknown>): Collection<Row, string> =>
    createCollection(lunoraCollectionOptions({ client, shape: { args, name: "wholeOutline" } }).config);
```

It throws away everything a real app needs: `checkpoints` (so no mutators), `shardKey`
(so the watermark lands in the wrong bucket for a sharded table), `getKey`, `load`. Rows
are the untyped `Row`, and `args` is `Record<string, unknown>` even though
`defineShape({ args: { userId: v.string() } })` fully types them.

Dotflowy imported **none** of it and rewrote all four collections by hand
(`src/data/lunora-outline-store.ts:624-667`).

**Fix.** Emit options factories, not pre-built collections — typed shape args, typed
`Doc<"table">` rows, `checkpoints` + `scope` returned, `shardKey` threaded through, and
`getKey` overridable. If `_generated/collections.ts` can't be made useful, don't emit it.

### 7. No test double for the client wire protocol

`e2e/fixtures.ts` grew a ~300-line hand-written Playwright mock of Lunora: `page.route`
on `/_lunora/rpc`, `page.routeWebSocket` on `/_lunora/ws`, an in-memory row store, poke
frames, watermark bookkeeping, plus failure injectors (`suppressWholeOutlinePoke`,
`failMutatorWrites`) and re-entrancy cleanup ("stacked `routeWebSocket` handlers can keep
an old in-memory store alive across reload"). `@lunora/testing` exports only `.` and
`./package.json` — `lunoraTest` is a server-side harness; there is nothing for the
browser.

**Fix.** `@lunora/testing/playwright`:

```ts
await mockLunora(page, { rows: { nodes: [...] }, shapes: ["wholeOutline"] });
await mockLunora.suppressPoke("wholeOutline");
await mockLunora.failWrites();
```

Every adopter needs this and every adopter will get the watermark bookkeeping subtly
wrong. It also gives Lunora an executable spec of its own wire protocol.

### 8. `where` has no deny primitive

`lunora/shapes.ts:9` — the app wrote a comment explaining the magic value, four times:

```ts
// Shape `where` returns WhereInput (not boolean). `{ OR: [] }` is the
// vacuously-false deny sentinel used by Lunora RLS/shapes.
if (!ctx.auth.userId || ctx.auth.userId !== userId) return { OR: [] };
```

`FALSE_PREDICATE` exists internally in `rls/middleware.ts:270` and
`rls/shape-read-base.ts:72` but is **not exported**. The failure mode is severe and
silent: `return {}` instead of `return { OR: [] }` replicates the entire table.

**Fix.** Export `deny()` (and `allowAll()`) from `@lunora/server`, and let `where` return
`false` as sugar. Add a lint/advisor rule for a `where` predicate with a conditional
branch that returns `{}` or `undefined`.

### 9. Owner-only shapes are a pattern, not a primitive

`ownerWhere` is duplicated across all four shapes. With `.shardBy("userId")` +
`authorizeShard: (identity, shardKey) => identity.userId === shardKey` already declared in
`worker/lunora-app.ts:99`, Lunora has everything it needs to derive this.

**Fix.** `defineShape({ table: "nodes", owner: "userId" })`, or a schema-level
`.ownedBy("userId")` that composes into every shape and RLS base-where on that table.

### 10. Table-generic helpers over `ctx.db` are impossible

`lunora/mcp.ts:43-62` declares a private `MutatorDb` / `MutatorCtx` and casts
`ctx as unknown as MutatorCtx` in all four functions — discarding the whole generated
`QueryCtx`/`MutationCtx`. Reason: they need `commitPlan(ctx, plan)` and a `WIPE_TABLES`
loop to work across a _union_ of table names, and `Id<T>` / `db.patch` / `db.query` don't
resolve for a union. They also cast every id (`patch.id as Id<"nodes">`, `row._id as
Id<ShardTable>`), and `ratelimit_buckets` — a table injected by
`.extend(ratelimit.extension)` — leaks into their hand-written table union.

**Fix.** Make the generated `TableName` union work as a type argument (`ctx.db.get<T
extends TableName>(id: Id<T>)` already does; `patch`/`delete` should too), export
`asId<T>(table, value)` for the parse boundary, and give schema extensions their own
namespace so `ratelimit_buckets` isn't the app's problem.

### 11. `wipeUserShard` is a hand-rolled loop

`lunora/mcp.ts:175` implements account deletion by enumerating five tables and deleting
row-by-row. On a large outline that's O(rows) DO work in one mutation, with no batching
and no guarantee it fits a transaction.

**Fix.** `ctx.db.wipeShard()` / `ctx.db.deleteAll(table)` as a runtime primitive
(GDPR-erasure is table stakes and the DO can drop the SQLite tables directly), plus a
documented account-deletion recipe.

### 12. Bulk import has no primitive

`src/data/lunora-migrate.ts:92` chunks at 500 nodes and awaits `isPersisted` per chunk;
the KV import (`:104`) is a serial `await` per row — for a user with 200 tag colors that's
200 sequential round-trips behind the FIFO push chain.

**Fix.** A documented bulk/import path — `ctx.db.insertMany`, or a
`client.importRows(shape, rows)` that bypasses per-row watermarks — plus guidance on
chunk sizing against the DO transaction limit.

---

## P2 — DX and docs

### 13. Vite dev proxy needs `ws: true` — undocumented, silent failure

Dotflowy lost time here twice, and wrote it into their own `AGENTS.md`:

> Vite proxies for `/api` and `/_lunora` need explicit `ws: true` — string shorthand does
> not upgrade WebSockets and blocks Lunora dogfood on "Loading outline".

**Fix.** Cover it in the "compose beside an existing Worker" doc, and have `@lunora/vite`
detect a `server.proxy` entry pointing at a Lunora path without `ws: true` and warn.

### 14. CSRF origin mismatch behind a dev proxy → opaque 403

`worker/lunora-app.ts:39-47`: the browser `Origin` is Vite (`:3000`), the Worker URL after
`changeOrigin` is wrangler (`:8787`), so the CSRF guard rejects the cookie WS upgrade with
`FORBIDDEN_ORIGIN` and "the outline never leaves _Loading outline_". They built
`lunoraTrustedOrigins()` merging `LUNORA_TRUSTED_ORIGINS` + `BETTER_AUTH_TRUSTED_ORIGINS`

- `BETTER_AUTH_URL`, hardcoding `localhost:3000` and `localhost:3210`.

**Fix.** Trust loopback origins by default in dev; make the `FORBIDDEN_ORIGIN` error body
name the received `Origin`, the expected origin, and the `csrf.trustedOrigins` knob.

### 15. `defineApp` env constraint forces a cast

```ts
// defineApp requires `Record<string, unknown>`; AuthEnv is a closed interface.
type LunoraAppEnv = LunoraEnv & Record<string, unknown>;
```

A TS interface isn't assignable to `Record<string, unknown>`. Every app with an
`interface Env` (i.e. every app using generated `worker-configuration.d.ts`) hits this.

**Fix.** Relax the constraint to `object`, or accept `Record<string, unknown> | object`.

### 16. Bring-your-own-auth is the real adoption path, and it's undocumented

The most important architectural decision in the PR (ADR 0055, "Identity / e2e / kv
(locked)"): **do not run a second `@lunora/auth` signup stack**. Product Better Auth stays
the session authority; Lunora reads it via `resolveIdentity`. That's the shape of every
real adoption — nobody migrating an existing app wants Lunora's auth.

Their implementation also calls `createAuth(env, url.origin)` and
`auth.api.getSession()` on **every request**, including every WS upgrade, with no caching.

**Fix.** Promote BYO-auth to a documented first-class path, ship
`@lunora/auth/bridge`-style helpers for better-auth / Clerk / Auth.js, and document (or
provide) per-request identity memoization. Pair it with the `authorizeShard` +
`.ownedBy()` story from #9 as one "existing app, existing auth" guide.

### 17. `serverRef` is an unchecked string

23 mutators, each `serverRef: "mutators:insertSibling"`. A typo, a rename, or a file move
is a runtime failure with no compile-time signal, and note the one place the names already
diverge: `deleteSavedQueryRow` on the client maps to `"mutators:deleteSavedQuery"`.

**Fix.** Accept a generated function reference —
`defineMutator({ serverRef: api.mutators.insertSibling })` — with the string form kept for
escape-hatch use.

> **Follow-up (2026-07-26).** PR #187 landed the `@lunora/db` half — `defineMutator`
> accepted a `MutatorReference` — but codegen never emitted `api.mutators.*`, so the
> reference form had nothing to point at and dotflowy's re-port stayed on the string
> escape hatch (reported on #310 after the post-#187 purge). Closed by:
>
> - `discoverMutators` now lifts each mutator's `args` validator map and its `server`
>   impl return type, and `emitApi` renders them as `api.mutators.<name>:
FunctionReference<"mutation", Args, Return>` — a real function reference, since a
>   mutator already dispatches through `LUNORA_FUNCTIONS` with `kind: "mutation"`.
> - The `@lunora/db` overload was itself unusable: `R extends MutatorReference<never>`
>   rejects any reference carrying a concrete arg type (`{ text: string }` is not
>   assignable to `never`), so a real generated reference fell through to the
>   `serverRef: string` overload and failed. It now infers directly —
>   `<TArgs>(… serverRef: MutatorReference<TArgs>)`.
> - `_generated/server.ts` re-exports a project-bound `defineMutator` (typed
>   `MutationCtx`), which also answers the 33 `const mctx = ctx as unknown as MutatorCtx`
>   casts in dotflowy's `lunora/mutators.ts` — the server context was the untyped base
>   `MutationCtx`, with no schema-typed `ctx.db`. Discovery accepts the
>   `_generated/server` specifier so the typed authoring path registers.
>
> Two latent bugs surfaced while emitting the first checker-rendered mutator types, both
> pre-existing for ordinary functions and both fixed: an extensionless
> `import("./_generated/dataModel")` qualifier (written by a function file that follows
> the no-`.js` convention) emitted a TS2835 into `_generated/*`, and an
> `import("@lunora/values").Id<…>` qualifier was a TS2307 for an umbrella-only app that
> declares no `@lunora/values`.

### 18. Client mutator boilerplate is mechanical

`lunora-outline-store.ts` is 694 lines, ~600 of which are 23 near-identical blocks: repeat
the arg type (already declared server-side), then
`const index = buildTreeIndex(snapshotNodes(collection)); const plan = planX(...); if (plan) applyPlanToCollection(collection, plan)`.

Two separable wins:

- **Arg types should be inferred** from the server mutator's validators via the generated
  API, not restated by hand in `defineMutator<{...}>`.
- **A "plan" shape is emergent.** Dotflowy independently arrived at
  `{ deletes, patches, inserts }` applied uniformly to a collection _and_ to `ctx.db`
  (`commitPlan` in `mcp.ts:70` is the server twin of `applyPlanToCollection`). That's the
  shared-planner pattern their ADR calls the trust boundary. Lunora could own it:
  `applyPlan(target, plan)` for both sides, so the client and server can't drift.

### 19. Version skew across four independently-versioned packages

`lunorash@…alpha.98`, `@lunora/react@…alpha.31`, `@lunora/db@…alpha.27`,
`@lunora/ratelimit@…alpha.9`. Nothing tells an adopter which combination is coherent.

**Fix.** Either a `lunora doctor` check that flags incompatible combinations, or peer
ranges that make npm refuse a bad set, or re-export `@lunora/db` + framework adapters
under `lunorash/*` so the umbrella pins them.

### 20. HMR requires a manual teardown hook

`src/data/lunora-sync.ts:185` — an `import.meta.hot.accept` that stops and restarts sync,
because a store-module edit otherwise strands old mutator bindings and a hung
`isPersisted` waiter. `@lunora/vite` should handle this for collections/mutators it knows
about.

### 21. Diagnostics are `console.log`

Every failure path in the port is `console.error("[lunora-sync] …")` /
`console.warn("[lunora-migrate] …")`, and migration is triggered from a global
(`window.__dotflowyMigrateToLunora`). There's no way to ask the client "what is the
current watermark / are there pending overlays / did a poke get dropped".

**Fix.** A client debug surface (`client.debug()` → shard watermarks, pending
transactions, subscription state, dropped-poke counter) and a Studio panel that reads it.
This is also what would have made #4 diagnosable in minutes instead of a bespoke
`shapeFirstCheckpoints`.

---

## Cross-cutting note

The single loudest signal in this PR is **who the adopter is**: not a greenfield app, but a
working product with its own auth, its own Worker, its own MCP server, its own DO, and a
requirement to run both engines side by side behind a user-visible flag while it migrates.
Lunora's docs and codegen assume the greenfield case. The "compose beside an existing
Worker" path — BYO auth (#16), typed server-side shard RPC (#5), dev proxy + CSRF
(#13/#14), useful collection factories (#6), a browser test double (#7), and a
dual-run/migration recipe (#12) — is where this PR spent almost all of its integration
cost. Turning that path into a documented, supported first-class story is the highest-
leverage thing Lunora can do with this feedback.

## Suggested order

1. **#1** — release production builds + a `dist` guard. One-line pipeline fix, ships broken
   artifacts today.
2. **#2, #3, #4** — the `@lunora/db` optimistic/checkpoint triad. All three are bugs an
   adopter must work around before their app is usable; all three have a reference
   implementation sitting in this PR.
3. **#5, #6** — typed server client + real collection factories. Biggest boilerplate delete.
4. **#7, #8, #16** — Playwright double, `deny()`, BYO-auth guide.
5. The rest as capacity allows.
