# Plan 4 — Cirrus Everywhere: the reactive backend for _any_ meta-framework

**Thesis.** Cirrus does not become a web framework. It becomes the **reactive backend that
any meta-framework plugs into** — TanStack Start, React Router, SolidStart, SvelteKit, Nuxt,
Astro — composed into **one Cloudflare Worker**. The differentiator no other backend has:
**your loaders are live.** A route loader fetches Cirrus data on the server (read-your-writes
SSR), the HTML ships with it, and on the client that same data **hydrates into a live
subscription** that re-renders on every write. void plugs frameworks in but has no reactivity;
Next/TanStack render but have no live data. Cirrus + your framework = full-stack _and_ real-time.

> Positioning line: **"Bring your framework. Your loaders are live."**

---

## 0. Why this is mostly _composition_, not _construction_

The grounding pass (see seam map) found the load-bearing pieces already exist:

- **One-worker composition seam exists.** `createWorker({ httpRouter })` (`packages/runtime/src/create-worker.ts`) already accepts an optional `HttpRouterLike` — `{ fetch(request, env?, ctx?) }` — consulted for every path that isn't an auth route, an explicit route, or a reserved `/_cirrus/*` endpoint (`/_cirrus/rpc`, `/_cirrus/ws`, `/_cirrus/admin/*`). **Any** meta-framework SSR handler is structurally an `HttpRouterLike`. The seam is built; it's just not wired in templates.
- **The client is already framework-agnostic.** `@cirrus/client` (`CirrusClient`, `SubscriptionRegistry`, offline queue, delta-merge, reconnect) has **zero** React. `@cirrus/react` is thin glue over it. So Svelte/Vue/Solid adapters reuse the same core.
- **Server preload exists.** `createServerClient`, `preloadQuery`/`preloadedQueryResult` (`@cirrus/client`), `prefetchQuery` (`@cirrus/react/server`), and `usePreloadedQuery` (hydrate-then-subscribe) are already there for React.
- **Vite composition is open.** `cirrus({ cloudflare: false })` lets a meta-framework supply its own Cloudflare/SSR build; the Cirrus plugins (codegen, studio, wrangler validate/reconcile) stack alongside.
- **Auth resolves server-side.** `auth.api.getSession({ headers: request.headers })` works in any SSR context; the runtime already forwards identity via `resolveIdentity(request, env)`.

**So the work is:** (1) formalize the framework-neutral SSR **contract**, (2) ship per-framework **adapters** + the single-worker **composition** helper, (3) make the **reactive-loader** handoff turnkey, (4) **detect + scaffold + deploy** per framework, (5) **docs**.

---

## 1. Architecture (the contract)

```
                         ┌──────────────── ONE CLOUDFLARE WORKER ────────────────┐
  request  ─────────────▶│  createWorker({ httpRouter, shardDO, auth, ... })     │
                         │   1. /api/auth/*      → @cirrus/auth (better-auth)     │
                         │   2. explicit routes  → webhooks/callbacks             │
                         │   3. httpRouter.fetch ← META-FRAMEWORK SSR  ◀── plug   │
                         │   4. /_cirrus/rpc     ← CirrusClient.query()           │
                         │   5. /_cirrus/ws      ← subscriptions / deltas         │
                         │   6. /_cirrus/admin/* ← studio / observability         │
                         └───────────────┬───────────────────────┬───────────────┘
                                         │ RPC / WS               │ (SSR loader runs here too)
                                         ▼                        ▼
                                   ShardDO (SQLite, OCC, hibernated WS broadcast)

  ── browser ───────────────────────────────────────────────────────────────────
  @cirrus/client  (framework-neutral: transport, subscribe, offline, delta-merge)
        ▲                ▲                ▲                ▲
  @cirrus/react   @cirrus/svelte   @cirrus/vue   @cirrus/solid   (thin idiomatic adapters)
```

**Two dispatch flows, one worker.** Pages/API/SSR → the meta-framework via `httpRouter`. Realtime
(queries/mutations/subscriptions) → reserved `/_cirrus/*`. They never collide.

**The reactive-loader handoff (the killer feature), framework-neutral at the data layer:**

```
[server: route loader]                         [client: framework adapter]
  session = getServerSession(request, auth)      hydratePreloaded(preloaded)
  client  = createServerClient({url, token})       → seed value (no refetch)
  preloaded = await preloadQuery(client, fn, args) → open WS subscription
  return { preloaded }            ──serialize──▶    → re-render on every delta
```

Only the last step ("bind to UI") is per-framework; everything left of it is shared.

---

## 2. Packages & deliverables

### 2.1 `@cirrus/ssr` (NEW) — the framework-neutral server contract

Promote the scattered server helpers into one neutral entrypoint every adapter depends on:

- `createServerClient({ url, token?, fetch? })` — request-scoped HTTP client (no WS), safe in any SSR loader. _(exists in `@cirrus/react/server`; move/re-export here.)_
- `getServerSession(request, auth)` — the missing helper: cookie/headers → `{ user, session } | null`, wrapping `auth.api.getSession`. _(today every app hand-rolls this.)_
- `preloadQuery(client, fn, args, { shardKey? })` → `Preloaded<T>` (serializable snapshot + subscription descriptor). *(exists in `@cirrus/client`; formalize the shape + token forwarding so the client can resume the *same* identity.)*
- `serializePreloaded` / dehydrate helpers for embedding in HTML safely.

### 2.2 `@cirrus/runtime` — harden the composition seam

- Make `httpRouter` composition a documented, first-class contract (precedence, error isolation: a framework 500 must not take down `/_cirrus/*`).
- Helper `composeWorker({ httpRouter, ...cirrusOptions })` (thin sugar over `createWorker`) so templates read cleanly.
- Ensure SSR loaders running _inside_ the same worker can call Cirrus **in-process** (skip the network hop to `/_cirrus/rpc`) — an internal `serverQuery(ctx, fn, args)` fast-path using `createCaller` (already generated in `_generated/functions.ts`). _Big perf + simplicity win vs void, which always goes over HTTP._

### 2.3 Framework adapters — thin, over `@cirrus/client`

Each exposes idiomatic primitives + the preloaded-hydration handoff. The contract per adapter:
`useQuery`/equiv (live), `useMutation`/equiv (optimistic), `hydratePreloaded(preloaded)` (SSR seed → live), provider/context, `usePresence`/`useStream` where it makes sense.

| Adapter                | Status                                                                      | Idiom                                                    |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `@cirrus/react`        | exists — harden SSR/`usePreloadedQuery` + move server bits to `@cirrus/ssr` | hooks + context                                          |
| `@cirrus/solid` (NEW)  | —                                                                           | signals/resources (closest model to Cirrus's reactivity) |
| `@cirrus/svelte` (NEW) | —                                                                           | stores (`$store`) / runes                                |
| `@cirrus/vue` (NEW)    | —                                                                           | composables (`ref`/`reactive`)                           |

> Solid first after React: its fine-grained signals map most directly onto Cirrus deltas, so it
> best showcases "live loaders" with minimal glue.

### 2.4 `@cirrus/vite` — framework detection + one-worker composition

Mirror void's class-a/b/c model:

- **`detectFramework(root)`** from `package.json` (`@tanstack/react-start`, `@react-router/dev`, `solid-start`/`@solidjs/start`, `@sveltejs/kit`, `nuxt`, `astro`).
- Compose the framework's Vite plugin + the Cirrus plugins so **one worker** is emitted; reconcile the framework's wrangler/worker config with Cirrus's binding reconcile (SHARD/SESSION/SCHEDULER/DB already shipped).
- For frameworks that own their own CF adapter (SvelteKit/Nuxt/Astro), inject the Cirrus worker composition into their server entry (void does this via hooks-injection plugins) rather than fighting their build.

### 2.5 Templates + CLI

- `cirrus init -t <framework>` for each (tanstack-start exists; add react-router, solid-start, sveltekit, nuxt, astro). Each template wires `httpRouter` + a sample **live loader** + the adapter provider.
- Reuse the shipped `cirrus init --here` in-place patcher to add Cirrus to an _existing_ meta-framework app.

### 2.6 Docs

- "Bring your framework" guide per framework; the **reactive loaders** concept page (the differentiator); the one-worker deploy story; auth-in-SSR.

---

## 3. The per-framework integration matrix (void's class model, adapted)

| Class                                        | Frameworks                                      | Composition strategy                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Vite-native, we own the worker entry** | TanStack Start, React Router (Vite), SolidStart | `createWorker({ httpRouter: <framework SSR handler> })` directly in the worker entry. Cleanest; in-process `serverQuery` available.                                                                                                |
| **B — own CF adapter, hook-injection**       | SvelteKit, Nuxt, Astro                          | Let the framework build its server; inject Cirrus worker composition into its server entry / hooks (Cirrus realtime mounted under `/_cirrus/*`, the framework keeps everything else). Adapter ships `withCirrus()`-style wrappers. |
| **C — non-CF or SSR-less**                   | static/SPA                                      | No SSR loaders; ship the client adapter + a standalone Cirrus worker (current default).                                                                                                                                            |

---

## 4. Milestones (prove the differentiator first, then broaden)

> **Status (updated):** M0–M5 shipped. **M4 (class-B) now works** — proven by a
> real `cirrus init -t sveltekit` → `vite build` → `wrangler deploy --dry-run`
> smoke (via a local verdaccio registry). The injection point was the open
> problem: `@sveltejs/adapter-cloudflare` overwrites whatever the wrangler `main`
> field points at, so pointing `main` at `src/worker.ts` clobbered the composition.
> **Fix:** point `main` at the adapter's _own_ default output
> (`.svelte-kit/cloudflare/_worker.js`) so the adapter writes there (no clobber);
> keep `src/worker.ts` as the `withCirrus` wrapper that imports that output and
> re-exports `ShardDO`; and have `cirrus deploy` pass `src/worker.ts` as the
> positional deploy entry (which overrides `main`) so the ONE deployed worker is
> the composed one. The dry-run confirmed a single worker with both
> `env.SHARD (ShardDO)` and `env.ASSETS` bindings resolved. The same smoke
> surfaced (and we fixed) template gaps across all 8 templates: missing
> `@cirrus/cli`, `@cirrus/do`, `typescript`, `@cloudflare/workers-types`; the
> sveltekit scaffold lacked `vite.config.ts`/`app.html`/`tsconfig.json`; and a
> latent `v.id("channels")` type error (a branded id to a non-existent table)
> shipped in every template's sample schema (now `v.string()`). Astro composes on
> the same `withCirrus` wrapper but `@astrojs/cloudflare` writes to `dist/_worker.js/`
> (it does NOT clobber `main`), so its existing wiring is structurally sound;
> Nuxt uses Nitro's output as `main` directly. See
> `docs/frameworks/bring-your-framework` (class-B note) + `verify-live-loaders`.
> The in-process `serverQuery` fast-path is also shipped, but
> intentionally keeps the worker→DO hop (a worker-side `createCaller` is
> architecturally impossible — dispatch happens inside the DO), so it removes the
> self-`fetch` loopback while keeping byte-identical identity/RLS semantics.

**M0 — Spike: prove "live loaders" end-to-end on TanStack Start (class A). ✅ shipped.**
One template where a TanStack Start route loader calls `preloadQuery` (with forwarded session),
SSRs the data, and the React adapter hydrates it into a live `useQuery` that updates on a mutation
from a second tab. This validates the whole contract (composition + SSR data + WS handoff +
in-process `serverQuery`). _Highest-signal, smallest scope._

**M1 — Formalize the contract. ✅ shipped.** `@cirrus/ssr` (`createServerClient`/`getServerSession`/
`preloadQuery`/`serializePreloaded`), the `composeWorker` sugar + in-process `serverQuery` fast-path
(with HTTP-path identity/RLS parity), and `@cirrus/react` sourcing `createServerClient` from
`@cirrus/ssr` + `hydratePreloaded`. Docs: reactive-loaders page.

**M2 — Build/deploy composition. ✅ shipped.** `@cirrus/vite` `detectFramework` + detection-driven
class-A one-worker emit (a `virtual:cirrus/worker` entry under `composeWorker`); the developer points
wrangler `main` at it. `cirrus init -t tanstack-start` and `-t react-router` wired.

**M3 — Adapter breadth. ✅ shipped.** `@cirrus/solid` (+ SolidStart template), `@cirrus/svelte`,
`@cirrus/vue` — each thin glue over `@cirrus/client` with `hydratePreloaded` + provider + a
live-loader template, and the shared `createMutationRunner`. Each on its packem framework preset.

**M4 — Class-B frameworks. ✅ SvelteKit validated end-to-end; Astro/Nuxt on the same mechanism.**
The shared `withFrameworkWorker` (`@cirrus/runtime`), the per-adapter `withCirrus`, the
`@cirrus/astro` integration, and the templates exist and unit-test. The injection point is solved
(see status note above): wrangler `main` points at the framework adapter's _own_ output so the
build can't clobber the `src/worker.ts` composition, and `cirrus deploy` bundles `src/worker.ts`
as the positional deploy entry. A real `cirrus init -t sveltekit` → `vite build` →
`wrangler deploy --dry-run src/worker.ts` produced a single worker exporting `ShardDO` with both
the `SHARD` and `ASSETS` bindings — no separate worker, no class-C fallback.

**M5 — Polish. ✅ shipped.** `cirrus init --here` per framework; dev HMR (the composed worker is an
ordinary module entry, HMRs under `@cloudflare/vite-plugin`); the "bring your framework" docs matrix;
deploy + verify-live-loaders guides.

---

## 5. Risks & open questions

1. **WS during/after SSR.** SSR fetches over HTTP (or in-process); the live subscription only opens
   client-side post-hydration. Need a clean "loading→live" state with no flash/refetch (the
   `staleTime: Infinity` + `initialData` pattern already does this for React; replicate per adapter).
2. **Identity continuity SSR→client.** The server loader resolves a session and forwards a token to
   `createServerClient`; the client subscription must resume the _same_ identity. `preloadQuery`
   must carry enough to re-auth the WS (cookie-based is simplest on same origin — verify).
3. **In-process vs network server query.** When SSR runs in the _same_ worker, `serverQuery` should
   bypass `/_cirrus/rpc` and call `createCaller` directly (faster, no self-fetch). Must match RLS /
   identity semantics exactly with the HTTP path.
4. **Single-worker bundling per framework.** Class-B frameworks bundle their own worker — composing
   Cirrus in without double-bundling DO classes or fighting their CF adapter is the main class-B
   risk (void solves it with hooks-injection transforms; budget for that).
5. **Dev HMR of the composed worker.** Both the framework's SSR and Cirrus's worker must HMR
   together under one Vite/Miniflare dev server. Class A is fine (`@cloudflare/vite-plugin`); class
   B inherits the framework's dev server — verify Cirrus realtime works under it.
6. **DO state isn't remotely SSR-able.** SSR reads go through the worker→ShardDO path fine at
   runtime; no special handling needed, but `preloadQuery` of a sharded query needs the `shardKey`
   resolvable server-side from the session/route params.

---

## 6. Why this beats the alternatives

- **vs building a renderer (Path A):** months not years; we don't compete with TanStack/Next/void on
  rendering; we amplify the moat instead of diluting it.
- **vs void:** void plugs frameworks in but ships no reactivity — its loaders are static fetches.
  Cirrus's loaders are _live_. That's a capability void structurally cannot match.
- **vs "just use Cirrus client in any app":** today that works but is BYO-wiring (two workers,
  hand-rolled SSR + session). This plan makes it **one worker, one deploy, turnkey per framework**,
  with live loaders out of the box.

**MVP that proves it all: M0** — TanStack Start route with a live loader, in one worker. Everything
else is breadth on a proven contract.

---

_Grounded in the integration-seam map (`createWorker.httpRouter`, framework-agnostic `@cirrus/client`,
`createServerClient`/`preloadQuery`, `cirrus({cloudflare:false})`). Companion: [[void-cloud-teardown]]
for the class-a/b/c composition reference; `VOID-TEARDOWN.md` §1.8 / §3.1 for void's framework wiring._
