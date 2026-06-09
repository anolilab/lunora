# Void Framework — Full Teardown

A complete reverse-engineering of **`void` (voidzero-dev) v0.9.2** — every documented feature
plus the bundled-`dist` implementation internals — so we have a durable, full understanding of
the system Cirrus borrows DX ideas from.

Source of truth: `npm pack void@0.9.2` → docs under `skills/void/docs/**` (guide/reference/
integrations) and esbuild bundles under `dist/**` (names/comments mostly preserved). Captured
2026-06 via three parallel reverse-engineering passes (docs · build/CLI · runtime).

> **Framing.** Void is a _full-stack web framework + managed deploy platform_ (Vite plugin +
> backend SDK + Cloudflare platform). Cirrus is a _reactive backend_ (Convex-on-Cloudflare).
> They share a substrate (CF Workers, Vite-first DX, D1, import-driven config) but differ in
> purpose: void owns the HTTP/rendering front; Cirrus owns real-time reactive state on Durable
> Objects. Sections flagged **[out of scope for Cirrus]** are void's web-framework half that
> Cirrus deliberately doesn't build. The **gap analysis** at the end is the actionable part.

---

## 0. The four DX pillars (the reason we studied void)

1. **Import-driven resource inference** — `import { db } from "void/db"` provisions a D1 binding; no manual wrangler editing. → _Cirrus shipped this (`@cirrus/config` infer + reconcile)._
2. **"No-codegen" types** — generated `.d.ts` are pure `typeof import(...)` scaffolds; TypeScript does all inference. → _Cirrus thinned its dataModel codegen toward this._
3. **In-place `init`** — AST-patches an existing `vite.config` to inject the plugin via MagicString. → _Cirrus shipped `cirrus init --here`._
4. **`prepare` + managed deploy** — no-Vite codegen for CI + a one-command deploy plane. → _Cirrus shipped `cirrus prepare`; the managed plane is a business decision Cirrus skips._

The one void capability Cirrus still lacks and would benefit from: **remote-binding dev** (§4.5).

---

## 1. Documentation catalog (feature surface)

### 1.1 Architecture & thesis

- Vite plugin + backend SDK + Cloudflare Workers platform. Thesis: **"your imports drive your infrastructure"** — importing `void/db|kv|storage|ai|sandbox|queues` auto-provisions the matching CF binding (Miniflare in dev, real resources on deploy).
- Private beta; "not for mission-critical production yet." Targets CF Workers by default; `node`/`bun`/`deno` standalone targets exist (without platform features).

### 1.2 Project structure & conventions

| Dir           | Contains                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/`     | File-based Hono API handlers. Named method exports (`export const GET = defineHandler(...)`). Dynamic `[id]`→`:id`, catch-all `[...slug]`, route groups `(admin)/` (no URL effect), `_`-prefixed files ignored. |
| `pages/`      | Inertia-style SSR pages: a component + co-located `*.server.ts` exporting `loader` (GET data) / `action` (mutations). Layouts nest + persist; markdown + frontmatter supported.                                 |
| `middleware/` | Global middleware, numeric-prefix ordering (`01.logger.ts`, `02.auth.ts`), each a `defineMiddleware()`.                                                                                                         |
| `db/`         | `schema.ts` (Drizzle, source of truth) + `migrations/*.sql`.                                                                                                                                                    |
| `crons/`      | `defineScheduled` handlers; `export const cron = "*/5 * * * *"`.                                                                                                                                                |
| `queues/`     | `defineQueue` consumers.                                                                                                                                                                                        |
| `src/`        | Shared code (always scanned for auth imports).                                                                                                                                                                  |
| `public/`     | Static assets served as-is.                                                                                                                                                                                     |
| `.void/`      | Generated (gitignored): `db.d.ts`, `routes.d.ts`, `queues.d.ts`, `tsconfig.json`, `v3/` (local dev state).                                                                                                      |

### 1.3 `void.json` config (every field)

`$schema` (ships at `void/schema.json`) · `sourceDir` · `target` (`cloudflare|node|bun|deno`) ·
`database` (omit=D1, `"pg"`=Hyperdrive) · `auth.providers[]` (30+) · `head` (title/titleTemplate/
meta/link/script/htmlAttrs/bodyAttrs, precedence page>middleware>config) · `output`
(`server`(default, deploy-time ISR) | `static`(build-time prerender)) · `remote: true` ·
`sandbox` (image/instanceType/maxInstances) · `worker` (compatibility_date/flags/vars — **binding
arrays disallowed here**, managed by inference) · `routing.{headers,redirects,rewrites,fallbacks,
revalidate,revalidateQueryAllowlist,prerender}` · `inference.{bindings,build,scanDirs,appType,
outputDir}`.

`.env` load order: `.env` → `.env.local` → `.env.production` → `.env.production.local`. `VITE_*`
prefix exposes to client.

### 1.4 Data layer

- Drizzle schema-as-truth in `db/schema.ts` using `void/schema-d1` or `void/schema-pg`; import tables via `@schema` alias; `void/db` re-exports all Drizzle operators (no separate install).
- D1 (default, managed) vs PostgreSQL (`database:"pg"`, Hyperdrive in prod, direct local, needs `DATABASE_URL`).
- Migrations: `void db push` (prototype), `void db generate` (SQL files), `migrate`, `status` (drift), `reset`, `seed`, `execute`, `studio`, `export`. `void gen model` generates schema.
- Type-safety pipeline: Drizzle types → handler return + validator schemas → `RouteMap` (`void/routes`) → typed fetch client + `InferProps` pages. **No traditional codegen** — pure `typeof import()` + tsconfig `paths`. Any Standard Schema lib works (zod/valibot/arktype) + drizzle-zod/valibot/arktype helpers.

### 1.5 Routing & rendering **[mostly out of scope for Cirrus]**

- Server routing on **Hono**: `defineHandler` (+ `.withValidator({params,query,body})`), `defineMiddleware`, `CloudContext`/`CloudEnv`, return-value auto-JSON, `c.rewrite()`/`c.originalUrl()`/`c.isRewritten()`.
- Pages mode (Inertia-style): loaders (`InferProps`, `defer()` streaming), actions (singular/named, `ValidationError` → field errors), `Link`, `useRouter/useParams/useNavigation`, layouts (`_layouts/`), head merge, islands (4 hydration strategies: load/visible/idle/media), markdown (`@void/md`), view transitions.
- Edge: static-asset caching, ISR/`revalidate`, deploy-time prerendering, custom headers, redirects, rewrites/fallbacks, SSR, SSG. Client adapters: **react/vue/svelte/solid**.

### 1.6 Platform features

- **AI** (`void/ai`): Workers AI inference (`ai.run/stream/models/toMarkdown/image/provider`), 18 providers, metered.
- **Sandboxes** (`void/sandbox`): `@cloudflare/sandbox` DO-backed containers.
- **Auth** (`void/auth`): better-auth, 30+ OAuth providers, `getUser/getSession/requireAuth`, `defineAuth` escape hatch, email/password.
- **Realtime**: WebSockets (`*.ws.ts` → DO; `defineRoom`/`defineWebSocket`), SSE (`eventStream`/`connectEventStream`), **Live event streams** (`defineLiveStream`/`connectLiveStream`).
- KV (`void/kv`, `kv.map` scoped client), R2 (`void/storage`), Queues (`void/queues`, `defineQueue`, `msg.ack/retry`), Crons, env (`defineEnv`, secret redaction, client-leak guard), `void/log` → CF tail/Logpush.

### 1.7 CLI (every verb)

`init` (+ `--here` in-place, `--agents`, `--github`) · `prepare` · `deploy` (`--project/--dir/--spa`) ·
`auth login|logout|whoami|token` · `project status|link|list|logs|rollback|cancel|delete|purge-cache` ·
`db push|generate|status|reset|seed|execute|migrate|studio|export|set-url|rename-migrations` ·
`gen model|migration|route|middleware|ssr|cron|queue` · `secret list|put|sync|delete` ·
`env check|types|example` · `domain add|delete|list|status` · `mcp`. Env: `VOID_TOKEN`, `VOID_PROJECT`,
`VOID_REMOTE`, `VOID_ENV_UNMASK`.

### 1.8 Framework integrations **[out of scope for Cirrus]**

Plugs into TanStack Start, React Router v7, SvelteKit (`withVoidTSConfig()`, disk wrangler sync),
Nuxt (Nitro), Astro 6+ (`nodejs_als`), Analog, Hono, and Node/Bun/Deno targets. Cirrus is consumed
_by_ frontends rather than hosting them, so this breadth is not a Cirrus goal.

---

## 2. Resource inference engine (`plugin-inference-*.mjs`)

The crown-jewel DX trick — **Cirrus already ships an equivalent** (`@cirrus/config`'s
export-driven variant), but void's algorithm is the reference.

**3-tier ladder with early exit** (`inferBindingsFromSource(code, filename)`):

```js
// Tier 1 — es-module-lexer (fast asm.js, no AST)
const [imports] = parse(code);
for (const imp of imports)
    switch (imp.n) {
        case "void/db":
            result.needsD1 = true;
            break;
        case "void/kv":
            result.needsKV = true;
            break;
        case "void/storage":
            result.needsR2 = true;
            break;
        case "void/auth":
            result.needsAuth = true;
            break;
        case "void/queues":
            result.needsQueues = true;
            break;
        case "void/ai":
            result.needsAI = true;
            break;
        case "void/sandbox":
            result.needsSandbox = true;
            break;
        case "void/live":
            if (!isTypeOnlyImportStatement(code.slice(imp.ss, imp.se + 1))) result.needsLive = true;
            break;
        case "void/client":
        case "void/client/react":
            /* … */ if (/\bauth\b/.test(stmt)) result.needsAuth = true;
    }
// Tier 1 fallback — regex, if es-module-lexer throws
// Tier 2 — early exit if all flags set
if (allSet) return result;
// Tier 3 — regex GATE, then oxc AST walk only if it matches
const ENV_BINDING_RE = /\benv\s*\.\s*(DB|KV|STORAGE|QUEUE_\w+|AI|SANDBOX)\b/;
if (!ENV_BINDING_RE.test(code)) return result;
walk(program, {
    enter(node) {
        /* confirm c.env.DB | env.DB member access */
    },
});
```

- The regex is a **cheap filter**: the expensive oxc parse only runs when `env.X` literally appears. Common case = zero AST cost.
- `void/live` is special-cased to ignore type-only imports (`import type`, `{ type X }`).
- **Framework detection** reads `package.json` deps → `{tanstack-start, react-router, vinext}`=class a, `sveltekit`=b, `nuxt|analog|astro`=c. Class governs which plugin stack is returned.
- Scan dirs: void-app `["routes","middleware","queues","pages","crons","src"]`; framework `["src","app","pages","routes","server","crons","queues"]`. `inference.scanDirs` overrides; `inference.bindings` bypasses inference entirely.
- `mergeBindings` is a pure **union** (any file setting a flag wins). SSR entry scanned as an extra pass. `.astro` → frontmatter only.

> **Cirrus delta:** Cirrus's inference is **export-driven** (it binds the DO classes the worker
> _exports_, not the modules it _imports_) precisely because wrangler rejects a `durable_objects`
> binding whose class isn't exported — a footgun void doesn't face (its DOs are framework-owned).
> Same 3-tier lexer idea, safer mapping for Cirrus's model.

---

## 3. Build pipeline & deploy

### 3.1 `voidPlugin()` composition (void-app / class-a)

Synchronous at load (inference runs before Vite init). Plugin order:
`cloudflare-builtins-external` → `default-worker-environment` (outDir `dist/ssr`) →
`worker-environment-sanitizer` → `sandbox-sdk-resolve` → `wrangler-compat-persist` →
**`cloudflare(...)`** (upstream CF plugin with merged `worker` config) → `void:env`
(loadEnv + `filterLoadedEnv` strips shell pollution) → `client-stubs` (server imports → no-op in
client env) → routing plugin (virtual Hono entry) → migration plugin (auto-apply on dev start) →
error overlay → dev triggers (`/__void/scheduled`, `/__void/queue`, UUID-token guarded) → codegen
watcher. Class b/c frameworks get a shorter list **without** the CF plugin (just wrangler-sync +
hooks injection).

### 3.2 Codegen — the "no-codegen" reality (`route-types-*.mjs`, `gen-*.mjs`)

Generates **only `typeof import()` scaffolds**; TypeScript chases the real types. Schema-lib-agnostic.

```ts
// .void/routes.d.ts — declare module "void/routes"
interface RouteMap {
    "/api/posts": {
        GET: {
            input: ExtractInput<(typeof import("../routes/api/posts.ts"))["GET"]["__validators"]>;
            output: Serialize<Awaited<(typeof import("../routes/api/posts.ts"))["GET"]["__output"]>>;
        };
    };
}
```

- **Phantom-type contract** on every handler/queue export: `__validators` (StandardSchema), `__output` (return type, wrapped `Serialize<Awaited<>>` → strips Response/Date→string/Function/undefined/bigint), `__payload` (queue body). WS routes add `messages.client`/`messages.server`.
- **tsconfig `paths` overlay** redirects `void/db`→`.void/db.d.ts`, `void/routes`→`.void/routes.d.ts`, `void/queues`→`.void/queues.d.ts`, `@schema`→`./db/schema.ts`. `db.d.ts` imports from the internal `void/_db` subpath to avoid circular resolution through its own redirect.

> **Cirrus delta:** Cirrus can't go _fully_ codegen-less (its `api`/`createShardDO` are value-level
> artifacts), but it already moved the schema-independent dataModel boilerplate into the shipped
> `@cirrus/server/data-model` and binds it via generics — same "let tsc do the work" spirit.

### 3.3 `syncWranglerBindings` — additive, idempotent

Reads `wrangler.jsonc`/`wrangler.json` (creates jsonc if absent). For each inferred binding,
**appends only if a binding of that name is absent** (never removes):

```js
if (bindings.needsD1 && !existing.some((b) => b.binding === d1Name))
    parsed.d1_databases = [...existing, { binding: d1Name, database_name: "default", database_id: "local" }];
// KV → {binding:"KV", id:"local"};  R2 → {binding:"STORAGE", bucket_name:"default"}
```

- WS routes → DO bindings + `migrations:[{tag:"void-ws-v1", new_classes:[…]}]`. Sandbox → DO + `containers[]` + `new_sqlite_classes`. **Live** → collision-safe binding name `VOID_LIVE_${sha256("void/live:binding:VOID_LIVE:0").slice(0,8)}`.
- Compat-date priority: `void.json` worker → wrangler → build output → hardcoded `LATEST_KNOWN_COMPAT_DATE`. Writes default back to `void.json` for determinism. Flag normalization: auth/pg/sandbox → `nodejs_compat`; else `nodejs_als`.

> **Cirrus shipped** the equivalent (`reconcileWranglerBindings` — same additive/idempotent JSONC
> structural-edit approach, plus migration-class registration and a D1-placeholder pre-flight block).

### 3.4 Deploy flow (`deploy-*.mjs`)

- **App-type detection:** `--dir`/`appType=static|spa` → static deploy; `detectFramework` class b/c → framework deploy; class a → full deploy; else `detectPreset` (known static output dirs); else full Void-app Vite build.
- **Schema drift gate** (pre-deploy, `hasDeploySchemaDrift`): copies project to a temp dir, snapshots `migrations/`, runs `drizzle-kit generate` against a dummy DB, diffs snapshots; any diff → `exit(1)` with guidance. Always cleaned up in `finally`.
- **Migration application:** wraps the built worker — renames entry to `__original.js`, generates a thin `index.js` that intercepts `POST /__void/migrate`, `/__void/migrate/capabilities`, `/__void/migrate/app[/attempt/:id]`; the platform calls these post-deploy before switching traffic. Worker is never re-bundled.
- **Asset upload protocol:** BLAKE3 content hash (`BLAKE3(base64(content)+ext).slice(0,32)` — matches Wrangler's algorithm for cross-dedup) + MD5 (R2 Content-MD5) computed in **one pass**. `preflight` → `requestUploadUrls` (presigned R2 PUTs, dedup by blake3) → direct R2 PUT (concurrency 10, 5xx retry 3×) → `finalizeDeploy` → **NDJSON event stream** (`start/heartbeat/asset_upload/provisioning/worker_readiness/migration/worker_upload/queue_setup/prerender/done/error`). Worker files base64 in the finalize JSON.
- Structured JSONL deploy log to `~/.void/logs/deploy-<ISO>.jsonl` with per-phase timing + 6-level `err.cause` chains. `void project rollback [id]` reinstates a prior deploy.

### 3.5 `init` in-place vite-config patcher (the MagicString trick Cirrus copied)

`patchViteConfigWithVoidPlugin(filePath, code)` — handwritten depth-0 char-walker (skips strings/
templates/comments, handles `<T>` type args) finds `export default defineConfig({…})` /
`export default {…}`, locates the `plugins:[…]` array, and edits via MagicString:

```js
if (/^\s*$/.test(arrayContent)) ms.overwrite(arrayStart + 1, arrayEnd, "voidPlugin()");
else ms.appendLeft(arrayStart + 1, next === "\n" ? `\n${propIndent}  voidPlugin(),` : "voidPlugin(), ");
// no plugins key → inject plugins:[voidPlugin()];  then insertVoidImport() after last import
```

`.cjs`/`.cts` or unparseable → prints a manual-step notice. Class-c frameworks always print notices.

> **Cirrus shipped** `cirrus init --here` using **ts-morph + MagicString** (a more robust AST locate
>
> - same source-preserving edit) in `packages/cli/src/util/patch-vite-config.ts`.

---

## 4. Runtime internals

### 4.1 Handler + typed fetch (`runtime/handler.mjs`)

- `defineHandler(...args)`: single arg = identity; multi = Koa-onion middleware chain; `convertReturnValue` JSON-wraps non-Response returns.
- Phantom types `__validators`/`__output`/`__payload` exist **only at type level** (never assigned) — codegen reads them via `typeof import`.
- `.withValidator({params,query,body})` validates each slot via Standard Schema (`schema["~standard"].validate`), collects all issues → single 400 JSON. **Schema-library-agnostic.**
- Typed fetch client = thin `ofetch` wrapper with `:param` interpolation; pure HTTP, no special wire format. `fetchStream` parses Workers-AI SSE.

> **Cirrus is ahead here:** its reactive client (`useQuery`/`useMutation` + optimistic updates +
> offline queue) is far more than void's typed `fetch`. **Worth stealing:** the Standard-Schema
> `~standard.validate` pattern would let Cirrus function args accept zod/valibot/arktype uniformly.

### 4.2 Database runtime (`runtime/db.mjs`)

`void/db` is a **virtual-module stub** the Vite plugin swaps at build for a schema-aware module;
fallback is a lazy `Proxy` that `drizzle(requireRuntimeBinding("DB"))` on first access (D1 pulled
from an AsyncLocalStorage runtime-env context). PG path uses `drizzle-orm/node-postgres` via
`DATABASE_URL`. Migration table `_void_migrations`; v2 adds `_void_migration_attempts` + `_lock`
for concurrent-deploy idempotency. (No CF Sessions API / read-your-writes in the runtime — remote
path is CLI-only.)

### 4.3 Auth runtime (`runtime/auth.mjs`)

better-auth; session in AsyncLocalStorage (`Symbol.for("void.authContext.v1")`); `getUser/getSession`
read it; `requireAuth` throws `HTTPException(401)`. Password = custom **scrypt** adapter
(N=16384,r=16,p=1, `salt:key` hex — not bcrypt). Social providers read `*_CLIENT_ID/SECRET` env at
request time; PKCE via better-auth; `BETTER_AUTH_SECRET` (dev fallback on localhost). CF Access via
`CF_ACCESS_CLIENT_ID/SECRET` or `CF_ACCESS_TOKEN`; CLI uses `cloudflared access token`.

### 4.4 Realtime

- **SSE** (`runtime/sse.mjs`): `TransformStream`-based `eventStream(start)`, keep-alive 15s, sets `text/event-stream` + `X-Accel-Buffering:no`.
- **Live event streams** (`runtime/live.mjs`) — **two-DO fan-out topology** on `VOID_LIVE`:
    - **Connection DO** (`live:${streamId}:connection:${connId}`) owns one SSE stream + in-memory sub map (`/connect`, `/control`, `/deliver`, `/check`).
    - **Topic DO** (`live:${streamId}:topic:${SHA256(streamId+"\0"+topic)}`) stores subscriber rows in DO storage (`/register`, `/unregister`, `/publish`).
    - Publish: SHA-256 topic key → Topic DO lists subscribers → fan-out to each Connection DO `/deliver` (1.5s timeout) → SSE event. Limits: 256 subs/conn, 256/topic, 64KB/event. Client auto-reconnects + resubscribes.
- **WebSockets** (`runtime/ws-server.mjs`): `*.ws.ts` → DO using **hibernation** (`state.acceptWebSocket`), auth via `serializeAttachment`; both directions validated against Standard Schema. `defineRoom` (`room.broadcast/getConnections`) vs `defineWebSocket` (per-connection).

> **Cirrus comparison:** Cirrus uses **hibernated WS on a single `ShardDO`** (SQLite + OCC) for
> reactive subscriptions — lower per-event latency than void's SSE + connection→topic round-trip,
> and its reactivity is query-driven (re-run on write) rather than manual pub/sub. void's
> connection/topic split is a clean isolation pattern; its unbounded SHA-256 topic keys are a neat
> trick if Cirrus ever wants a non-query pub/sub channel.

### 4.5 ⭐ Remote-binding dev — the gap Cirrus should close

The one void capability Cirrus lacks. Two halves:

**Local** (`runtime/remote/index.mjs`): when `env.__VOID_REMOTE` is set, the worker entry calls
`createRemoteEnv(env, bindingNames)` which **replaces real binding objects with HTTP proxy shims**:

```js
function createRemoteEnv(env, bindingNames) {
    const client = new ProxyClient(env.__VOID_PROXY_URL, env.__VOID_TOKEN, env.__VOID_PROJECT_ID, env);
    return {
        ...env,
        ...(env.DB && { DB: new ProxyD1Database(client, "DB") }),
        ...(env.KV && { KV: new ProxyKVNamespace(client, "KV") }),
        ...(env.STORAGE && { STORAGE: new ProxyR2Bucket(client, "STORAGE") }),
    };
}
```

`ProxyD1Database.prepare(sql).bind(...p).all()` → `POST ${proxyUrl}/d1/query {binding,sql,params,
method:"all",projectId}` with `Authorization: Bearer <token>`. KV/R2 map analogously (binary
base64). **Response shapes mirror Cloudflare's D1 REST format, so Drizzle works unchanged.**

**Deployed** (`runtime/remote/binding-handler.mjs`): the deployed worker exposes `/__void/*` Hono
routes that execute against the **real** bindings, guarded by an `x-void-internal` shared secret
(`__VOID_PROXY_TOKEN`):

```js
app.post("/d1/query", async (c) => {
    const { binding, sql, params, method } = await c.req.json();
    const stmt = env[binding].prepare(sql).bind(...(params ?? []));
    switch (method) {
        case "first":
            return c.json(await stmt.first());
        case "run":
            return c.json({ success: true, meta: (await stmt.run()).meta });
        default: {
            const r = await stmt.all();
            return c.json({ results: r.results, success: true, meta: r.meta });
        }
    }
});
```

Wire path: `local Miniflare worker → ProxyD1Database → POST proxy.void.cloud/d1/query → (Workers
for Platforms service binding, ~1–5ms vs REST ~50–200ms) → deployed /__void/d1/query → real
env.DB`. Env vars: `__VOID_REMOTE`, `__VOID_PROXY_URL`, `__VOID_TOKEN`, `__VOID_PROJECT_ID`,
`__VOID_PROXY_TOKEN`. Limitations: latency, no R2 multipart, no `db.dump()`.

> **Cirrus replication sketch:** (A) when `CIRRUS_REMOTE=1`, the vite plugin/worker entry wraps
> `env.DB`/KV/R2 in `ProxyD1Database`-style shims POSTing to a Cirrus proxy with the deploy token +
> project id; (B) the deployed Cirrus worker mounts a `/__cirrus/*` binding-handler (auth via
> `x-cirrus-internal`). The JSON protocol + Cloudflare-shaped responses mean Drizzle/D1 callers need
> zero changes. **Caveat:** Cirrus's primary state is the _Durable Object_ (SQLite per shard), not
> D1 — so a faithful remote-dev would also need to proxy _shard DO_ RPC, which is harder than D1/KV/
> R2 (DO addressing + the reactive subscription path). A pragmatic first cut: proxy D1 (`.global()`
> tables) + KV + R2 only, and run shards locally. Still a big debugging win.

### 4.6 Queues / Sandboxes / AI / ISR / env / migrations

- **Queues**: `queues` is a lazy `Proxy` → `QUEUE_${NAME}` binding; `defineQueue` sets phantom `__payload`; consumer `QueueBatch<T>` with `.ack()/.retry({delaySeconds})/.ackAll()/.retryAll()`. _(Cirrus covers this via `@cirrus/scheduler` queue-workpool.)_
- **Sandboxes**: `getSandbox` wraps `@cloudflare/sandbox` + a metering gate (POST `/sandbox/acquire`; 409 → `SandboxLimitError`); usage events to a queue on a 5-min DO alarm.
- **AI**: 3 backends — WfP service binding (fastest) → HTTP proxy → native `AI` binding. `ai.provider("openai")` proxies to the provider with the project's stored key (18 providers).
- **ISR**: `revalidate({paths}|{all})` POSTs to the `__VOID_PROXY` service binding (no-op in local dev); proxy purges R2 cache + CDN.
- **env** (`runtime/env.mjs`): `defineEnv(schema)` + an `env` Proxy validating per key on first access (WeakMap cache per env identity), async validators pre-resolved at boot (`_validateEnvOnce` spliced into the entry), `__VOID_*` filtered from the public proxy, **secret redaction** in error messages (key-name regex + value-prefix `sk_`/`ghp_` + ≥24-char high-entropy).
- **Migrations (v2)**: `/__void/migrate/*` authed via `x-void-internal`; SHA-256 integrity of SQL + plan (`migrationListHash`); plan kinds `single-statement` / `breakpoint-framed` (split on `--> statement-breakpoint`); INSERT-conflict attempt lock + `reconcileAttempt` recovery.

### 4.7 Pages SSR protocol **[out of scope for Cirrus]**

Inertia-style. Page object = `{component, props, params, shared, url, errors, head, deferred,
deferredKeys}`. GET: run loader → resolve head (config<middleware<page) → separate `defer()` props
→ XHR (`X-VoidPages:true`) returns JSON / NDJSON-streams deferred, full SSR streams HTML +
`<script>window.__resolveDeferred()</script>`. Mutations map `ValidationError`→`{field:message}`.
`serializePageData` escapes `<>&  `. Client engine: SPA nav over `X-VoidPages`, prefetch
cache, View Transitions, static `/_void/pages/<path>.json` fast-path, islands hydrate by
load/visible/idle/media.

---

## 5. Notable techniques worth stealing (ranked)

1. **⭐ Remote-binding dev** (§4.5) — the one clear in-scope DX gap; pure-JSON proxy with CF-shaped responses. _Pragmatic first cut: D1/KV/R2 only._
2. **Standard Schema (`~standard.validate`) for inputs** — make Cirrus function args accept zod/valibot/arktype uniformly with zero coupling.
3. **3-tier inference with regex gate** — already mirrored; the "regex filter before AST" pattern keeps inference cheap. (Cirrus's export-driven mapping is the safer variant.)
4. **`typeof import()` phantom-type codegen** — already partially adopted; the `__output`/`__validators` carrier pattern is the model for any future thinning.
5. **Migration idempotency protocol** (`_attempts` + INSERT-conflict lock + reconcile) — directly applicable to `@cirrus/do`'s migration runner for safe rolling restarts.
6. **Schema-drift gate via temp-copy + drizzle-kit snapshot diff** — a clean "fail before deploy" check (Cirrus's model differs — `defineMigration` not Drizzle SQL — so adapt, don't copy).
7. **Single-pass BLAKE3+MD5 asset hashing** + Wrangler-compatible BLAKE3 for cross-dedup — relevant only if Cirrus ever builds its own deploy plane.
8. **`filterLoadedEnv`** — strip shell-env pollution from worker vars by diffing against `process.env`.
9. **Collision-safe DO binding names via deterministic hash suffix** — neat for auto-provisioned DOs.
10. **Live event streams' connection/topic DO split + SHA-256 topic keys** — a clean pub/sub topology if Cirrus wants non-query channels.

---

## 6. Gap analysis vs Cirrus (what's done / missing / out of scope)

**Done (void DX parity shipped):** import-driven binding inference · wrangler auto-reconcile ·
thinned `typeof`-style codegen · in-place `init --here` (MagicString) · `prepare` · `deploy`
(+ `--migrate`, D1-placeholder guard).

**Genuine remaining gaps (in scope):**

- **Remote-binding dev** (§4.5) — _highest DX leverage; build it._ D1/KV/R2 proxy first.
- **Standard Schema input validation** — small, additive, schema-lib-agnostic args.
- **Client framework breadth** — void has react/vue/svelte/solid; Cirrus has react only (Vue/Svelte reactive clients widen reach; Solid deferred).
- **Workers AI helper** (`@cirrus/ai`) — small additive (Cirrus has Vectorize, not inference).
- **Sandboxes/containers** — niche, low priority.

**Out of scope by design (void's web-framework half — do NOT build):** Pages/SSR/SSG/ISR · islands
· head/view-transitions/markdown · edge headers/redirects/rewrites/prerendering · PostgreSQL/
Hyperdrive · non-CF targets · meta-framework plugin breadth (SvelteKit/Nuxt/Astro) · managed deploy
plane (business decision).

**Where Cirrus already leads void:** real-time reactivity (void has none — only manual SSE/WS/Live
pub/sub) · the observability **studio** (void ships a basic dashboard) · `@cirrus/mail` (void has no
mail) · RLS policies · presence · vector/rank/aggregate indexes.

---

_Generated from a three-pass reverse-engineering of void@0.9.2 (docs + dist). See
[[void-cloud-teardown]] memory for the condensed version and the shipped-roadmap status._
