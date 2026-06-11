# @cirrus/vue

Vue 3 composables for the Cirrus framework. Thin, idiomatic glue over the framework-neutral [`@cirrus/client`](../client) (which owns the WebSocket transport, subscription registry, offline queue, and delta-merge) — re-expressed as Vue `ref`s and effect-scope-aware composables, so live queries and optimistic mutations behave like any other reactive source.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.

## Install

```bash
pnpm add @cirrus/vue @cirrus/client vue
```

Workspace dependency: [`@cirrus/client`](../client). Peer dep: `vue` (`^3.5.0`).

## Usage

```vue
<script setup lang="ts">
import { useQuery, useMutation } from "@cirrus/vue";
import { api } from "./cirrus/_generated/api";

const props = defineProps<{ room: string }>();

// Live ref — `undefined` until the first server response, then updates on every delta.
const messages = useQuery(api.messages.list, () => ({ room: props.room }));
const { mutate, pending } = useMutation(api.messages.send);
</script>

<template>
    <p v-if="messages === undefined">Loading…</p>
    <ul v-else>
        <li v-for="m in messages" :key="m.id">{{ m.body }}</li>
    </ul>
    <button :disabled="pending" @click="mutate({ room, body: 'hi' })">Send</button>
</template>
```

Provide the client once at the app root (or scope it to a subtree):

```ts
import { createApp } from "vue";
import { CirrusClient } from "@cirrus/client";
import { createCirrus } from "@cirrus/vue";
import App from "./App.vue";

const client = new CirrusClient({ url: "https://app.acme.test" });

createApp(App).use(createCirrus(client)).mount("#app");
```

## Provider

The client is provided through Vue's `provide`/`inject` graph and resolved by every composable via `useCirrus()`.

### `createCirrus(client)`

Vue plugin form — `app.use(createCirrus(client))`. Establishes the single app-wide `CirrusClient`. Returns `{ install(app) }`.

### `provideCirrus(client)`

Composition-API form — call inside a parent component's `setup()` to provide the client to its subtree. Use this when you'd rather scope the client to a subtree than the whole app. Must run synchronously inside `setup()`.

### `useCirrus()`

Reads the active `CirrusClient` from the nearest provider. Throws with a clear message when called outside a `createCirrus`/`provideCirrus` scope. Useful for escape-hatch operations like `client.action(...)` or `client.close()`.

### `CIRRUS_INJECTION_KEY`

The `InjectionKey<CirrusClient>` the provider uses. Exported so advanced consumers can `inject` it by hand; most apps use the helpers above.

## Composables

### `useQuery(fn, args, options?)`

Subscribes to a server query and returns a `Ref<ReturnOf<F> | undefined>` — `undefined` until the first response lands, then updated on every delta the server pushes.

`args` may be a plain value, a `ref`, or a getter. Passing a reactive source makes the subscription reactive: when the args change the old subscription is torn down and a fresh one opens for the new args (matching `@cirrus/react`/`@cirrus/solid`). Pass `"skip"` (or a source resolving to `"skip"`) to short-circuit — no network call, no socket.

```ts
const data = useQuery(api.foo.bar, () => (condition.value ? { id: id.value } : "skip"));
```

`options.shardKey` routes to a specific shard when the target function is `.shardBy(...)`-partitioned. Call inside `setup()` (or any active effect scope); the subscription tears down automatically on unmount (or when the effect scope stops).

### `useMutation(fn)`

Returns a reactive `MutationHandle<F>`:

- `mutate(args, options?)` — awaitable; resolves with the server value, rejects on failure. The `optimistic` / `optimisticUpdate` call options pass straight through to `client.mutation`, which applies and rolls them back against the Cirrus subscription cache (Convex parity).
- `data: Ref<ReturnOf<F> | undefined>` — the latest invocation's resolved value.
- `error: Ref<Error | undefined>` — the latest invocation's error.
- `pending: Ref<boolean>` — `true` while any invocation from this handle is in flight (ref-counted, so overlapping calls compose).
- `reset()` — clear `data`/`error` back to idle.

The ref-counted pending + error-normalize orchestration is the shared `createMutationRunner` from `@cirrus/client`; only the refs are adapter-specific.

### `hydratePreloaded(preloaded)`

Hydrate a query from a `Preloaded` token produced by `preloadQuery` during SSR, then keep it live. The returned `Ref<T | undefined>` is seeded **synchronously** from `preloaded.value`, so the first read (during hydration) shows the server value — no loading flash, no hydration mismatch. After seeding it opens a WebSocket subscription on the same `(functionPath, args, shardKey)` the SSR loader used, so every later delta updates the ref exactly like `useQuery`. Tears down with the surrounding effect scope.

### `subscribeToQuery(client, fn, args, options?)`

Low-level primitive behind `hydratePreloaded`: opens a live subscription against an explicit `client` for **fixed** args and streams values into a `Ref`. `options.seed` sets the ref synchronously before the subscription attaches; `options.shardKey` routes to a shard. Reach for `useQuery` for the reactive-args case; use this when you already hold a client and immutable args.

## Server entry (`@cirrus/vue/server`)

Server-side preload helpers, re-exported from the framework-neutral [`@cirrus/ssr`](../ssr) contract. Opens no WebSocket and touches no browser globals, so it is safe to import from a Nuxt/Nitro server route or any SSR context: build a request-scoped client with `createServerClient`, run `preloadQuery`, then hand the serializable `Preloaded` token to `hydratePreloaded` on the client.

```ts
// Nitro/Nuxt server route
import { createServerClient, preloadQuery } from "@cirrus/vue/server";
import { api } from "./cirrus/_generated/api";

const client = createServerClient({ url: process.env.NUXT_PUBLIC_CIRRUS_URL! /* + headers/session */ });
const preloaded = await preloadQuery(client, api.posts.list, {});
// → serialize `preloaded` into the page, hydrate with hydratePreloaded(preloaded)
```

Exports: `createServerClient`, `preloadQuery`, `preloadedQueryResult`, `serializePreloaded`, `deserializePreloaded`, `getServerSession`. Types: `ArgsOf`, `AuthLike`, `FunctionReference`, `HeadersSource`, `Preloaded`, `ReturnOf`, `ServerClientOptions`, `ServerSession`.

## Worker entry (`@cirrus/vue/worker`)

`withCirrus` (re-exported as `withFrameworkWorker` from `@cirrus/runtime`) wraps a framework's fetch handler as Cirrus's fallback `httpRouter`: Cirrus mounts only the reserved `/_cirrus/*` plane (RPC, WS, admin) + `ShardDO`, and all other requests fall through to the framework handler.

> **Nuxt note:** Nitro does not expose its emitted fetch handler as an importable module, so single-worker composition of `/_cirrus/*` into a Nitro output is not achievable. The supported Nuxt integration is a **two-worker split** — the Nitro SSR worker plus a standalone Cirrus worker (`wrangler.cirrus.jsonc`, `cirrus/server.ts`) that owns `/_cirrus/*` + `ShardDO`, wired together via `NUXT_PUBLIC_CIRRUS_URL`. `withCirrus` remains useful for frameworks whose build toolchain genuinely exposes the emitted handler as a module.

## API

| Export                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `createCirrus(client)`  | Vue plugin — `app.use(...)`. Provides the client.       |
| `provideCirrus(client)` | Provide the client to a subtree from `setup()`.         |
| `useCirrus()`           | Read the active `CirrusClient`.                         |
| `useQuery(fn, args)`    | Live `ref`. Reactive args; `"skip"` short-circuits.     |
| `useMutation(fn)`       | Returns `{ data, error, pending, mutate, reset }`.      |
| `hydratePreloaded(p)`   | Seed a ref from an SSR `Preloaded` token, then go live. |
| `subscribeToQuery(...)` | Low-level fixed-args subscription into a `ref`.         |
| `CIRRUS_INJECTION_KEY`  | The provider's `InjectionKey<CirrusClient>`.            |

Types: `MutationHandle`, `UseQueryOptions`, `ArgsOf`, `ReturnOf`, `CirrusClient`, `FunctionReference`, `MutationCallOptions`, `OptimisticLocalStore`, `OptimisticUpdate`, `Preloaded`, `Unsubscribe`, `User`.

## Breaking changes (alpha)

The adapter surface was unified across `@cirrus/solid`/`@cirrus/svelte`/`@cirrus/vue`:

- **`useCirrusClient` → `useCirrus`.** The provider accessor was renamed (no alias) to match React/Solid. Replace `useCirrusClient()` with `useCirrus()`.
- **`useMutation().withOptimisticUpdate(...)` removed.** Pass a multi-query optimistic update per call instead: `mutate(args, { optimisticUpdate })`. The handle is now uniformly `{ data, error, pending, mutate, reset }`.

## Docs

- Repo root: [README.md](../../README.md)

## License

FSL-1.1-Apache-2.0 — see [LICENSE.md](./LICENSE.md)
