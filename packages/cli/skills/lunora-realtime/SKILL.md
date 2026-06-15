---
name: lunora-realtime
description: Wires Lunora's live data into a client. Use for `LunoraClient`/`LunoraProvider`,
    reactive `useQuery`/`useSubscription`, `useMutation` with optimistic updates,
    pagination, connection status, the React/Vue/Solid/Svelte adapters, and the
    `@lunora/db` TanStack binding.
---

# Lunora Realtime

Consume Lunora functions reactively from the client. Queries are live
subscriptions over WebSocket — a `useQuery` re-renders the instant a mutation
changes the rows it reads — and mutations can paint optimistically with
automatic rollback.

## When to Use

- Wiring a frontend to a Lunora backend (React, Vue, Solid, Svelte).
- Adding optimistic updates, pagination, or presence to the UI.
- Choosing between live hooks and the `@lunora/db` collection layer.

## When Not to Use

- Writing the server functions themselves — that's `lunora-functions`.
- Initial project/provider scaffolding — that's `lunora-quickstart`.

## Provider Setup

Create the `LunoraClient` once at module scope and wrap the app. The client owns
the WebSocket, the optimistic cache, and the offline queue.

```tsx
import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";

const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;
const client = new LunoraClient({ url });

// <LunoraProvider client={client}>…</LunoraProvider>
```

Vue / Solid / Svelte have matching providers in `@lunora/vue`, `@lunora/solid`,
`@lunora/svelte`; the hook names and semantics below mirror across them.

## Live Queries

`useQuery(reference, args)` opens a subscription and returns the value, or
`undefined` while it loads. The reference comes from codegen
(`api.<file>.<name>`).

```tsx
import { useQuery } from "@lunora/react";

import { api } from "../../lunora/_generated/api";
import type { Doc } from "../../lunora/_generated/dataModel";

const todos = useQuery(api.todos.list, {}) as Doc<"todos">[] | undefined;
```

- `undefined` means "loading" — render a skeleton/spinner for it.
- The subscription tears down on unmount and re-runs only when `args` change or
  the underlying rows change. Keep `args` narrow so a write elsewhere doesn't
  re-push unrelated data (see `lunora-performance-audit`).
- `useSubscription` is the lower-level primitive for streaming subscriptions;
  `usePreloadedQuery` + `lunoraQueryOptions` support SSR/preload handoff via
  `@lunora/react/server`.

## Authorization & Live Queries

Subscriptions re-run the query handler **server-side under anonymous
identity**. The one-shot `fetch` RPC behind the initial load carries the
caller's identity, but the live WebSocket channel (the subscription seed and
every write-driven refresh) does not — it evaluates as anonymous.

This matters for any query that authorizes or filters on the authenticated
user:

- A query guarded by `.use(rls(...))` or one that reads `ctx.auth.userId`
  directly returns the user's rows on the **initial** HTTP fetch, but its
  **live** updates evaluate anonymously and may resolve to an empty/denied
  set.
- This **fails closed** — the live channel shows _less_ data, never another
  user's data, so there is no leak. But it is a correctness caveat: the
  initial render and the live updates can disagree.

The supported pattern today is to scope per-user data **outside** of
`ctx.auth` inside a subscribed query:

- Partition the data by shard with `.shardBy(userId)` (or tenant/room), so the
  subscription is already scoped to the right state, or
- Pass the identifier as an **explicit query arg**
  (`useQuery(api.todos.list, { userId })`) and filter on the arg rather than on
  `ctx.auth`.

Reserve `rls()` / `ctx.auth`-based filtering for non-subscribed reads (one-shot
actions/queries) where identity is always present.

## Mutations + Optimistic Updates

`useMutation(reference)` returns `{ mutate, pending }`. Pass an `optimistic`
callback to paint the next state immediately; if the server rejects the call the
runtime rolls the cache back automatically.

```tsx
import { useMutation } from "@lunora/react";

import type { Doc, Id } from "../../lunora/_generated/dataModel";

const { mutate: add, pending } = useMutation(api.todos.add);

await add(
    { text },
    {
        optimistic: (current) => {
            const list = (current as Doc<"todos">[] | undefined) ?? [];
            const provisional: Doc<"todos"> = {
                _id: `optimistic_${Date.now()}` as Id<"todos">,
                _creationTime: Date.now(),
                text,
                done: false,
                createdAt: Date.now(),
            };
            return [provisional, ...list];
        },
    },
);
```

- The `optimistic` callback receives the current cached value and returns the
  provisional one. When the server delta arrives it replaces the optimistic
  entry; on failure the cache reverts.
- `pending` is `true` while the call is in flight — disable the submit button
  with it.
- **Offline queue:** mutations made while disconnected are queued by
  `LunoraClient` and replayed on reconnect (client-id-keyed, so they aren't
  double-applied).

## Pagination, Connection, Presence

- `usePaginatedQuery` / `useInfiniteQuery` — cursor pagination over a query that
  ends in `.paginate(...)` on the server.
- `useConnectionStatus` — live socket state for an offline/reconnecting banner.
- `usePresence` — who's-here + heartbeat (pairs with the `presence` registry
  item).
- `useAuth` + the `Authenticated` / `Unauthenticated` / `AuthLoading` gates —
  see `lunora-setup-auth`.

## `@lunora/db` — TanStack DB Collections

For richer client state (indexed local collections, cross-query joins, a durable
offline-transactions outbox), use `@lunora/db` instead of raw hooks. Scaffold
with `vis generate lunora-collections` (wires `defineCollections` from your
schema + functions into live TanStack DB collections). Reach for it when the app
needs client-side indexes/joins or a persistent optimistic outbox; raw `useQuery`
/`useMutation` are enough for straightforward live lists.

## Common Pitfalls

1. **Creating `LunoraClient` inside a component.** It re-opens the socket every
   render — create it once at module scope.
2. **Treating `undefined` as empty.** `undefined` is "loading", `[]` is "loaded,
   empty" — branch on both.
3. **Broad query args.** A subscription keyed too broadly re-renders on
   unrelated writes; scope `args` to what the component shows.
4. **Optimistic shape drift.** The provisional value must match the query's
   element shape (including `_id`/`_creationTime`) or the UI flickers when the
   real delta lands.

## Checklist

- [ ] `LunoraClient` created once at module scope; app wrapped in the provider.
- [ ] Live reads use `useQuery`; `undefined` handled as loading.
- [ ] Writes use `useMutation`; `pending` disables submit; `optimistic` matches
      the row shape.
- [ ] Query `args` scoped narrowly to avoid over-broad re-renders.
- [ ] Pagination via `usePaginatedQuery`/`useInfiniteQuery` over `.paginate`.
- [ ] Considered `@lunora/db` if the app needs local indexes/joins or an outbox.
