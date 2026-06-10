# @cirrus/astro

The **Astro** integration for [Cirrus](https://github.com/anolilab/cirrus) — the
realtime backend for any meta-framework. PLAN4 **class-B** (own-CF-adapter,
hook-injection) composition.

Astro is multi-framework at the UI layer, so `@cirrus/astro` is **not** a new
reactive runtime. Reactivity comes from whichever island adapter you hydrate
with — [`@cirrus/react`](../react), [`@cirrus/solid`](../solid),
[`@cirrus/svelte`](../svelte), or [`@cirrus/vue`](../vue). This package owns the
two **server-side** seams Astro needs:

1. **Single-worker composition** — mount Cirrus realtime _inside_ the Worker
   `@astrojs/cloudflare` emits (`withCirrus`).
2. **Reactive-loader server helpers** — preload Cirrus data in `.astro`
   frontmatter / server endpoints, then hydrate an island into a live
   subscription (`@cirrus/astro/server`).

## Install

```bash
pnpm add @cirrus/astro
```

`astro` is an optional peer dependency — the host Astro app already provides it.

## The composition story (class-B)

Unlike class-A frameworks (TanStack Start, SolidStart) where Cirrus owns the
worker entry, Astro owns its **own** Cloudflare adapter and builds its own server
worker. So Cirrus is **injected into** Astro's worker rather than fighting its
build.

### 1. Add the integration

```ts
// astro.config.mjs
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import { cirrus } from "@cirrus/astro";

export default defineConfig({
    output: "server",
    adapter: cloudflare(),
    integrations: [cirrus()],
});
```

### 2. Wrap the adapter's worker entry with `withCirrus`

`@astrojs/cloudflare` emits a server worker whose default export is the SSR
handler. Wrap it at that boundary so Cirrus realtime mounts under `/_cirrus/*`
and **everything else** falls through to Astro:

```ts
// src/worker.ts
import astroWorker from "../dist/_worker.js/index.js";
import { withCirrus } from "@cirrus/astro";

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return withCirrus(astroWorker, {
            shardDO: env.SHARD, // the ShardDO namespace binding
            // auth, routes, resolveIdentity, observability … all optional
        }).fetch(request, env, ctx);
    },
};
```

The two dispatch flows share one worker but never collide:

- `/_cirrus/rpc`, `/_cirrus/ws`, `/_cirrus/admin/*` → **Cirrus realtime**
- everything else → **Astro SSR**

An Astro render that throws is contained at the composition seam and surfaced as
a plain 500 — it can never take down the realtime plane.

## Reactive loaders (`@cirrus/astro/server`)

`@cirrus/astro/server` re-exports the framework-neutral
[`@cirrus/ssr`](../ssr) contract. Use it in `.astro` frontmatter (which runs
server-side during SSR) to preload a query, then hand the `Preloaded` token to an
island adapter's `hydratePreloaded`:

```astro
---
// src/pages/index.astro
import { createServerClient, preloadQuery } from "@cirrus/astro/server";
import { api } from "../../cirrus/_generated/api";
import Messages from "../components/Messages"; // a React/Solid island

const client = createServerClient({
    url: Astro.url.origin, // same-origin: /_cirrus/rpc loops back into this worker
    fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        const cookie = Astro.request.headers.get("cookie");
        if (cookie) headers.set("cookie", cookie); // forward the session
        return fetch(input, { ...init, headers });
    },
});

const preloaded = await preloadQuery(client, api.messages.list, { channelId: "channel:demo" });
---

<Messages client:load preloaded={preloaded} />
```

On the client, the island's adapter (`@cirrus/react`'s / `@cirrus/solid`'s
`hydratePreloaded`) seeds from the SSR snapshot **synchronously** (no loading
flash, no refetch), then opens the WebSocket subscription so it re-renders on
every server write. Your loaders are live.

## API

| Export                                                                            | Entry                  | Purpose                                                                       |
| --------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `cirrus(options?)`                                                                | `@cirrus/astro`        | The `AstroIntegration` added to `astro.config`'s `integrations`.              |
| `withCirrus(astroWorker, cirrusOptions)`                                          | `@cirrus/astro`        | Wrap the `@astrojs/cloudflare` worker so Cirrus realtime mounts inside it.    |
| `createServerClient` / `preloadQuery` / `getServerSession` / `serializePreloaded` | `@cirrus/astro/server` | The framework-neutral `@cirrus/ssr` server contract for `.astro` frontmatter. |

## License

FSL-1.1-Apache-2.0
