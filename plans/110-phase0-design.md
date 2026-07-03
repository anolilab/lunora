# Plan 110 — Phase 0 design: `@lunora/next` composition adapter

> **Spike outcome (TL;DR)**: OpenNext-on-Cloudflare **can** host `ShardDO` + the
> WebSocket realtime plane alongside Next.js, matching Lunora's `/_lunora/*`
> contract, **without a new architecture** — Next is a **class-B** framework and
> reuses the shipped `withFrameworkWorker` composer at the OpenNext _custom-worker
> boundary_. The WebSocket upgrade **must** live at that boundary, **not** in a
> Next Route Handler. No STOP condition triggered. The remaining work is a normal
> build plan plus the open decisions in §7.
>
> Prototype: `plans/proto/next/compose-next-worker.ts` (+ passing test). Ran
> green in-sandbox (`9 passed`, shared run with 111/113).

---

## 1. Shared composition contract (from `@lunora/nuxt` + `@lunora/astro`)

Every host integration mounts the **same** realtime plane. Extracted first-hand
from the two shipped adapters and `@lunora/runtime`:

### 1.1 The reserved paths (`/_lunora/*`)

`packages/runtime/src/create-worker.ts:909-920` — Lunora owns these sub-paths; the
host owns everything else:

| Path                                              | Purpose                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /_lunora/rpc`                               | single RPC call (`RpcEnvelope`)                                                  |
| `POST /_lunora/rpc-batch`                         | batched RPC                                                                      |
| `/_lunora/ws`                                     | **WebSocket upgrade** → `101 Switching Protocols` (forwarded to `ShardDO.fetch`) |
| `/_lunora/admin/*`                                | Studio admin plane (gated)                                                       |
| `/_lunora/scheduler/dispatch`, `/_lunora/migrate` | scheduler + migrations                                                           |

### 1.2 The single shared composer — `withFrameworkWorker`

`packages/runtime/src/create-worker.ts:3285`. This is the **one** class-B seam
behind `@lunora/svelte/worker`, `@lunora/vue/worker`, and `@lunora/astro`'s
`withLunora` (`packages/astro/src/with-lunora.ts:45` re-exports it verbatim):

```ts
const withFrameworkWorker = (host: FrameworkHostHandler, optionsInput): LunoraWorker => {
    const httpRouter = toHttpRouter(host); // host may be a bare fetch fn OR { fetch, scheduled }
    const build = (options) => composeWorker({ ...options, httpRouter });
    // reserves /_lunora/*, delegates everything else to `httpRouter` (the framework host)
    // factory form rebuilds per request so per-request bindings (env.SHARD) wire in
};
```

Key properties the contract guarantees (create-worker.ts:3264-3321):

- **`host` shape**: `FrameworkHostHandler` = a bare `fetch` fn **or** a
  `{ fetch, scheduled? }` object (create-worker.ts:3245). "Every class-B adapter
  output (`@sveltejs/adapter-cloudflare`, Nitro's `cloudflare-module`,
  `@astrojs/cloudflare`) is structurally one of these." **OpenNext's
  `.open-next/worker.js` default export (`{ fetch }`) is exactly this shape.**
- **Options factory**: `(env) => ({ shardDO: env.SHARD, ... })` — per-request,
  because `env.SHARD` only exists at request time.
- **WebSocket passthrough**: the `101` upgrade `Response` (carrying its
  `webSocket`) is returned **verbatim** — the framework streams it unchanged
  (create-worker.ts:3364-3366).
- **`scheduled` preservation**: if Lunora configures no cron, the host's own
  `scheduled` is preserved (so OpenNext's cache-purge cron, if any, survives).

There is also `createLunoraHandler(options)` (create-worker.ts:3387) — the
framework-neutral `(request, env, ctx) => Response` bridge for hosts that mount by
**router path** rather than by wrapping a worker handler (Hono, h3, Elysia). Nuxt
uses this style: its Nitro server route reconstructs a web `Request` and calls
`delegateToLunora(lunoraApp, request, env, ctx)` (`packages/nuxt/src/runtime/handler.ts`,
`.../server/lunora.ts`).

### 1.3 Exporting `ShardDO`

The `ShardDO` Durable Object class (`packages/do/src/index.ts:223`) **must be
exported from the deployed worker's `main` entry** and bound in `wrangler.jsonc`.
The adapters diverge only in _where_ that export lives:

- **Nuxt**: a project-root `exports.cloudflare.ts` (`export { ShardDO } from "./lunora/server"`)
  carried into the generated worker by Nitro's `cloudflare_module` hook
  (`packages/nuxt/src/module.ts:73`).
- **Astro**: the `src/worker.ts` custom entry (`main` in wrangler) that calls
  `withLunora(...)` also re-exports `ShardDO` (`packages/astro/src/with-lunora.ts:28-37`).

### 1.4 The class model (A/B/C)

`packages/config/src/detect-framework.ts:10-46`:

- **Class A** — Vite-native; **Lunora owns the worker entry** (`createWorker({ httpRouter })`).
  TanStack Start, SolidStart, React Router.
- **Class B** — framework owns its **own** Cloudflare adapter; Lunora **injects**
  its composition into the framework's server entry via `withFrameworkWorker`.
  **SvelteKit, Nuxt, Astro.**
- **Class C** — non-CF / SSR-less; ship the client adapter + a standalone Lunora
  worker (today's default).

---

## 2. Where Next.js falls: **class B**

Next.js on Cloudflare deploys via **OpenNext** (`@opennextjs/cloudflare`), which
**owns its own Cloudflare adapter** and emits its own Worker (`.open-next/worker.js`).
That is the textbook class-B signature — identical to SvelteKit/Astro. The
detection table (`FRAMEWORK_SIGNATURES`) should gain:

```ts
{ class: "B", dependency: "next", framework: "nextjs" },
```

(plus `nextjs → "@lunora/react"` in the CLI's `ADAPTER_BY_FRAMEWORK`).

**Consequence**: Next needs **zero new runtime composition code**. The existing
`withFrameworkWorker(openNextHandler, (env) => ({ shardDO: env.SHARD }))` composes
Lunora with the OpenNext handler exactly as it does for Astro. `@lunora/next` is
therefore a _thin_ package: framework detection entry, a `withLunora` alias (or
just re-export `withFrameworkWorker`), and the template + docs for the OpenNext
custom-worker wiring.

---

## 3. The chosen OpenNext seam — custom-worker boundary (decision)

### 3.1 OpenNext's custom-worker mechanism

OpenNext generates `.open-next/worker.js` whose default export is `{ fetch }`. Its
documented **"Custom Worker"** how-to
(<https://opennext.js.org/cloudflare/howtos/custom-worker>) is to import that
handler, wrap it, and point wrangler's `main` at the custom file:

```ts
// src/worker.ts   (wrangler "main")
// @ts-expect-error generated at build time by @opennextjs/cloudflare
import { default as openNextHandler } from "./.open-next/worker.js";
import { withFrameworkWorker } from "@lunora/runtime"; // via @lunora/next

export default withFrameworkWorker(openNextHandler, (env) => ({ shardDO: env.SHARD }));

// ShardDO must be exported from THIS worker entry (and bound in wrangler.jsonc):
export { ShardDO } from "./lunora/server";
```

`wrangler.jsonc`:

```jsonc
{
    "main": "src/worker.ts",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
}
```

### 3.2 Durable Object export — an established OpenNext pattern

Re-exporting a DO class from the custom worker is **already** how OpenNext ships
its own DO-backed cache/queue: when enabled you must re-export `DOQueueHandler`,
`DOShardedTagCache`, `BucketCachePurge` from the worker
(opennextjs-cloudflare **#502**). `ShardDO` sits right beside them:

```ts
// when OpenNext's DO cache/queue is enabled, alongside ShardDO:
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
```

So the DO-export requirement is not a Lunora-specific hack — it is the normal
OpenNext custom-worker story.

### 3.3 Why the boundary and not a Next Route Handler

A Next Route Handler (`app/_lunora/[...path]/route.ts`) **can** serve RPC (a plain
`POST/GET → Response`). It **cannot** carry the WebSocket upgrade, and WS is
Lunora's core realtime feature. Three independent reasons:

1. **The `webSocket` field is non-standard.** A Cloudflare WS upgrade returns
   `new Response(null, { status: 101, webSocket: client })`. `webSocket` is a
   Workers-only Response extension. Next's `Response` abstraction has no concept
   of it.
2. **OpenNext's adapter round-trip strips it.** OpenNext converts the inbound
   Cloudflare `Request` into a Next server request, runs Next, then reconstructs a
   Cloudflare `Response` from Next's Web `Response`. Neither a `101` status switch
   nor a `webSocket` field survives that reconstruction.
3. **Route Handlers terminate on a response** and have no raw-socket access on
   Workers. This is confirmed ecosystem-wide: Next ships no first-class WS server
   (vercel/next.js#58698); on Cloudflare, WS upgrades are handled at the **Worker
   fetch boundary** or forwarded to a **Durable Object**.

At the custom-worker boundary, `withFrameworkWorker` intercepts `/_lunora/ws`
_before_ OpenNext ever sees it; `createWorker` forwards it to `ShardDO.fetch`,
which returns the `101` verbatim. **The boundary natively supports WS; the Route
Handler cannot.** Since RPC and WS should share one mount, put **both** at the
boundary. (An optional RPC-only Route Handler could exist for niche same-app edge
cases, but the canonical, WS-capable mount is the boundary.)

### 3.4 Prototype evidence

`plans/proto/next/compose-next-worker.ts` models exactly this dispatch (a faithful,
dependency-free stand-in for `withFrameworkWorker`, which needs workerd + a real DO
namespace to boot). The test (`compose-next-worker.test.ts`, **ran green**) proves:

- a non-`/_lunora` request delegates to the OpenNext handler;
- `POST /_lunora/rpc` round-trips through Lunora without touching OpenNext;
- `/_lunora/admin/*` reaches Lunora;
- **a `/_lunora/ws` upgrade returns the `101` + its `webSocket` field verbatim** —
  the load-bearing assertion, since that is precisely what a Route Handler +
  OpenNext response adapter would strip.

The real seam runs the identical logic via `withFrameworkWorker`, so the seam is
proven at the composition level. What was _not_ runnable in-sandbox: a live
workerd RPC round-trip through a real `ShardDO` (no workerd + Vectorize/DO binding
here); that is a build-plan smoke test, not a spike blocker.

---

## 4. Dev-mode note

OpenNext dev uses `initOpenNextCloudflareForDev()` in `next.config` so `next dev`
sees the CF bindings. The realtime plane in dev has two options: (a) run under
`wrangler dev` against the built custom worker (full WS parity), or (b) run
`next dev` for the UI and point the Lunora client at a separate `wrangler dev`
realtime worker. Recommend documenting (a) as the parity path and (b) as the
fast-iteration path; finalize in the build plan (open question §7.6).

---

## 5. STOP-condition assessment

| STOP condition (from the plan)                                                     | Triggered?                               | Evidence                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| OpenNext can't host DO + WS matching `/_lunora/*` without a different architecture | **No**                                   | Custom-worker boundary + `withFrameworkWorker` matches the contract exactly, same as Astro/Svelte (§3).                    |
| WS subscription path has no viable home                                            | **No**                                   | The boundary returns the `101 + webSocket` verbatim; proven by prototype (§3.3-3.4).                                       |
| Requires pinning an unstable/churning OpenNext API                                 | **Partial risk — flagged, not blocking** | The custom-worker import path (`./.open-next/worker.js`) and the DO re-export list are OpenNext-version-coupled; see §7.1. |

No STOP. This is a green spike: the seam is proven and reuses shipped code.

---

## 6. `init` no-op — recommendation

`packages/cli/src/commands/init/handler.ts:1348-1352` currently warns _"template
'next' is not yet available"_ and exits 1. **Recommendation: leave the no-op in
place until `templates/next` lands**, but improve the message to point at this
design ("Next.js support is in progress — track plan 110; use `--vite react` today").
Removing the branch before the template exists would let `lunora init -t next`
scaffold a broken project (the plan's own maintenance note warns of this). Removal
and the `templates/next` landing must be a single coordinated change in the build
plan.

---

## 7. Open questions (maintainer decisions)

1. **OpenNext version pinning.** The custom-worker import (`./.open-next/worker.js`)
   and the DO re-export list (`DOQueueHandler`/`DOShardedTagCache`/`BucketCachePurge`)
   are OpenNext-internal and move between releases. _Recommendation_: pin
   `@opennextjs/cloudflare` to a tested minor in `templates/next`, add a
   `@lunora/vite`/config check that verifies the custom worker still re-exports
   `ShardDO`, and document a re-verification step (the plan's maintenance note).
2. **Template authors the custom worker vs. codegen generates it.** _Recommendation_:
   ship it as a **template file the user owns** (like Astro's `src/worker.ts`),
   not generated — it is tiny, and users must edit it to add auth/crons. Revisit if
   OpenNext churn makes a generated+validated file safer.
3. **`@lunora/next` package surface for v1.** _Recommendation_: minimal —
   detection entry (`next → class B`), a `withLunora` alias over
   `withFrameworkWorker`, and the template. Defer SSR data-preload helpers
   (`@lunora/react` server-preload → `hydratePreloaded`) to v2.
4. **Auth routes.** `/api/auth/*` (better-auth via `@lunora/auth`) currently
   routes through `handleAuthRequest`. Decide whether it mounts at the boundary
   (before OpenNext) or as a Next Route Handler. _Recommendation_: boundary, for
   symmetry with the other adapters and to keep auth off the Next render path.
5. **Remove the `init` no-op now or with the template?** _Recommendation_: with the
   template (§6).
6. **Dev-mode story** (§4): `wrangler dev` custom worker (parity) vs `next dev` +
   separate realtime worker (fast). Pick the documented default.
7. **`nodejs_compat` + `compatibility_date` baseline** the template pins (OpenNext
   requires `nodejs_compat`; Lunora's DO SQLite requires a recent compat date).

---

## 8. Follow-up build plan outline

1. `@lunora/next` package: detection + `withLunora` alias + `next → @lunora/react`
   adapter mapping; `next` added to `FRAMEWORK_SIGNATURES`.
2. `templates/next`: OpenNext scaffold + `src/worker.ts` custom worker +
   `wrangler.jsonc` (SHARD DO binding + migration) + `lunora/` app + `@lunora/react`
   client wired to same-origin `/_lunora/*`.
3. Remove/rewire the `init` no-op (coordinated with the template).
4. Workerd smoke test: RPC round-trip + WS subscribe through the composed worker
   (the piece not runnable in this spike).
5. v2: SSR data-preload helpers, auth-route placement, all bindings.
