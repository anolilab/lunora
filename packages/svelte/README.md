# @cirrus/svelte

Svelte adapter for Cirrus — live stores, optimistic mutations, and the reactive-loader handoff.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.

Thin, idiomatic glue over the framework-neutral [`@cirrus/client`](../client) (zero React). It re-expresses the `@cirrus/react` contract in Svelte stores you read with the `$store` idiom:

| `@cirrus/svelte`                      | `@cirrus/react` equivalent       | What it does                                                           |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `setCirrusClient` / `getCirrusClient` | `<CirrusProvider>` / `useCirrus` | Publish/read the `CirrusClient` over Svelte context.                   |
| `query(fn, args)`                     | `useQuery`                       | A live `Readable` that opens a WS subscription and re-emits on deltas. |
| `mutation(fn)`                        | `useMutation`                    | `{ mutate, pending }` — optimistic, ref-counted pending store.         |
| `hydratePreloaded(preloaded)`         | `usePreloadedQuery`              | SSR seed → live store, no loading flash.                               |

The package is plain `.ts` over Svelte stores — **no `.svelte` component compiler is required** to build or test it, so it stays unit-testable under Vitest.

## Install

```bash
pnpm add @cirrus/svelte svelte
```

`svelte` (>= 5) is a peer dependency.

## Usage

### 1. Provide the client (once, at the root)

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
    import { CirrusClient } from "@cirrus/client";
    import { setCirrusClient } from "@cirrus/svelte";

    setCirrusClient(new CirrusClient({ url: import.meta.env.VITE_CIRRUS_URL }));
</script>

<slot />
```

### 2. Live query store

```svelte
<script lang="ts">
    import { query } from "@cirrus/svelte";
    import { api } from "$lib/_generated/api";

    // `$messages` updates on every server delta.
    const messages = query(api.messages.list, { room: "general" });
</script>

{#each $messages ?? [] as message}
    <p>{message.text}</p>
{/each}
```

### 3. Optimistic mutation

```svelte
<script lang="ts">
    import { mutation } from "@cirrus/svelte";
    import { api } from "$lib/_generated/api";

    const { mutate, pending } = mutation(api.messages.send);
</script>

<button disabled={$pending} on:click={() => mutate({ room: "general", text: "hi" })}>
    Send
</button>
```

### 4. Reactive loader (`hydratePreloaded`)

The killer feature: a route loader preloads on the server (read-your-writes SSR), the HTML ships with the data, and on the client the **same** data hydrates into a live subscription with no loading flash.

```ts
// src/routes/+page.ts
import { createServerClient, preloadQuery } from "@cirrus/client";
import { api } from "$lib/_generated/api";

export const load = async ({ fetch }) => {
    const client = createServerClient({ url: import.meta.env.VITE_CIRRUS_URL, fetch });
    const preloaded = await preloadQuery(client, api.messages.list, { room: "general" });

    return { preloaded };
};
```

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
    import { hydratePreloaded } from "@cirrus/svelte";

    export let data;

    // Seeded synchronously from data.preloaded.value (no flash), then live.
    const messages = hydratePreloaded(data.preloaded);
</script>

{#each $messages as message}
    <p>{message.text}</p>
{/each}
```

> The server preload helpers (`createServerClient`, `preloadQuery`) live in `@cirrus/client` today. They move to `@cirrus/ssr` once that package lands in PLAN4 M1 — import them from there at that point; the adapter surface here is unchanged.

## Status

This is the **adapter** (PLAN4 M3). Full single-worker SvelteKit composition — mounting Cirrus realtime under `/_cirrus/*` inside SvelteKit's own Cloudflare adapter via hook-injection (`withCirrus()`) — is **Class-B** work, wired in PLAN4 **M4**. See `templates/sveltekit` for the scaffold and the M4 TODO.
