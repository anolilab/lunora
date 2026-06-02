# @cirrus/react

React 18 / 19 hooks for the Cirrus framework. Wraps a [`@cirrus/client`](../client) instance with Suspense-friendly hooks that subscribe via `useSyncExternalStore`, so concurrent rendering, transitions, and selective hydration all behave correctly.

## Install

```bash
pnpm add @cirrus/react @cirrus/client react react-dom
```

Workspace dependency: [`@cirrus/client`](../client). Peer deps: `react` and `react-dom` (`^18 || ^19`).

## Usage

```tsx
import { CirrusClient } from "@cirrus/client";
import { CirrusProvider, useQuery, useMutation } from "@cirrus/react";
import { api } from "./cirrus/_generated/api.js";

const client = new CirrusClient({ url: "https://app.acme.test" });

export function App() {
    return (
        <CirrusProvider client={client}>
            <MessageList room="general" />
        </CirrusProvider>
    );
}

function MessageList({ room }: { room: string }) {
    const messages = useQuery(api.messages.list, { room });
    const { mutate, pending } = useMutation(api.messages.send);

    if (messages === undefined) return <p>Loading…</p>;

    return (
        <>
            <ul>
                {messages.map((m) => (
                    <li key={m.id}>{m.body}</li>
                ))}
            </ul>
            <button disabled={pending} onClick={() => mutate({ room, body: "hi" })}>
                Send
            </button>
        </>
    );
}
```

## Hooks

### `useQuery(fn, args, options?)`

Subscribes to a server query. Returns `ReturnOf<F> | undefined` — `undefined` until the first response lands. Components calling `useQuery` with identical `(fn, args, shardKey)` share a single underlying network call via the shared cache.

Pass `"skip"` as `args` to short-circuit the query entirely (no network, no cache entry).

```ts
const data = useQuery(api.foo.bar, condition ? { id } : "skip");
```

### `useMutation(fn)`

Returns `{ mutate, pending }`:

- `mutate(args, options?)` returns a `Promise<ReturnOf<F>>` and supports the same `{ optimistic, shardKey }` options as `client.mutation`.
- `pending` is `true` while at least one in-flight call is outstanding.

> The hook intentionally exposes `{ mutate, pending }` rather than the earlier `[mutate, { isLoading }]` prototype shape — destructure at the call site so the React linter tracks `mutate` and `pending` independently.

### `useSubscription(fn, args, options?)`

Pure WebSocket subscription. Unlike `useQuery` this hook does **not** issue an initial HTTP fetch — it only delivers values that the server pushes. Returns `{ data, error }`. Pass `"skip"` for `args` to disable the hook.

### `useAuth()`

Returns `{ user, token, setToken }`. `setToken(jwt | null)` proxies to `client.setAuthToken` so subsequent RPC calls carry the `Authorization` header. `user` is reserved for the upcoming auth phase and currently always `null`.

### `useCirrus()`

Reads the current `CirrusClient` from the nearest `<CirrusProvider>`. Throws if used outside a provider. Useful for escape-hatch operations like `client.close()` or one-shot `client.action(...)` calls.

## Provider

```tsx
<CirrusProvider client={client}>{children}</CirrusProvider>
```

Stable identity — the underlying context value is just the `CirrusClient` you pass in, so re-renders don't tear down subscriptions.

## Server Components (`@cirrus/react/server`)

The hooks are client-only (each module declares `"use client"`) — use them inside your own Client Components. Server-side data loading lives in the separate, socket-free `@cirrus/react/server` entry — safe to call from a React Server Component:

```tsx
// Server Component
import { createServerClient, prefetchQuery, dehydrate, HydrationBoundary } from "@cirrus/react/server";
import { QueryClient } from "@tanstack/react-query";

const client = createServerClient({ url: process.env.CIRRUS_URL!, token });
const queryClient = new QueryClient();
await prefetchQuery(queryClient, client, api.posts.list, {});

return (
    <HydrationBoundary state={dehydrate(queryClient)}>
        <PostList /> {/* client component: useQuery(api.posts.list, {}) reads the hydrated value */}
    </HydrationBoundary>
);
```

- `createServerClient({ url, token?, fetch? })` — request-scoped, HTTP-only client. Build one per request.
- `prefetchQuery(queryClient, client, fn, args, opts?)` — seeds the TanStack cache under the same key `useQuery` reads.
- `preloadQuery(client, fn, args, opts?)` — returns a serializable `Preloaded` token for `usePreloadedQuery`.
- `dehydrate`, `HydrationBoundary` — re-exported from `@tanstack/react-query`.

See the [React reference](../../apps/docs/content/docs/api/react.mdx#server-components-nextjs-app-router) for the full Next.js walkthrough.

## API

| Export                      | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `<CirrusProvider />`        | Context provider. Required at the root of any tree that uses hooks. |
| `useCirrus()`               | Read the active `CirrusClient`.                                     |
| `useQuery(fn, args)`        | Subscribe to a query. `"skip"` short-circuits.                      |
| `useMutation(fn)`           | Returns `{ mutate, pending }`.                                      |
| `useSubscription(fn, args)` | Returns `{ data, error }`. WS only.                                 |
| `useAuth()`                 | Returns `{ user, token, setToken }`.                                |

Types: `CirrusProviderProps`, `MutationHook`, `UseQueryOptions`, `UseMutationCallOptions`, `UseSubscriptionResult`, `UseAuthResult`, `User`, `CirrusClient`, `FunctionReference`, `ArgsOf`, `ReturnOf`.

## Docs

- Repo root: [README.md](../../README.md)
- React reference: [apps/docs/content/docs/api/react.mdx](../../apps/docs/content/docs/api/react.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
