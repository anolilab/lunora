---
name: lunora-realtime
description: Wires Lunora's live data into a client app. Covers `LunoraClient` and the per-framework provider, reactive `useQuery`/`useSubscription`, `useMutation` with optimistic updates, `usePaginatedQuery`, `shardKey` routing, connection status, presence, the React/Vue/Solid/Svelte/Angular/React Native adapters, and the `@lunora/db` TanStack DB binding. Use when building UI that reads or writes Lunora functions, when asked to "show live data", "make this update in real time", "add optimistic updates", "add infinite scroll/pagination", or "show offline/reconnecting state", when editing components that import `@lunora/react`/`vue`/`solid`/`svelte`/`angular`/`react-native` or `lunorash/client`, or when a live query stays `undefined`, freezes, or doesn't update.
---

# Lunora Realtime

Consume Lunora functions reactively from the client. Queries are live
subscriptions over WebSocket — a `useQuery` re-renders as soon as a mutation
changes the rows it reads — and mutations can paint optimistically with
automatic rollback.

## When Not to Use

- Writing the server functions themselves — that's `lunora-functions`.
- Initial project/provider scaffolding — that's `lunora-quickstart`.
- Sign-in UI and the `Authenticated` gates — that's `lunora-setup-auth`.

## Provider Setup

Create the `LunoraClient` once at module scope; it owns the WebSocket, the
optimistic cache, and the offline queue, so creating it inside a component
reopens the socket on every render.

```tsx
import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";

const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;
const client = new LunoraClient({ url });

// <LunoraProvider client={client}>…</LunoraProvider>
```

The adapters differ in how they register the client and name their primitives:

| Package                | Register the client                                          | Live read / write                              |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `@lunora/react`        | `<LunoraProvider client={client}>`                           | `useQuery` / `useMutation`                     |
| `@lunora/vue`          | `app.use(createLunora(client))` (or `provideLunora(client)`) | `useQuery` / `useMutation`                     |
| `@lunora/solid`        | `<LunoraProvider client={client}>`                           | `createQuery` / `createMutation`               |
| `@lunora/svelte`       | `setLunoraClient(client)` in the root layout                 | `query` / `mutation` stores                    |
| `@lunora/angular`      | `provideLunora()` in `ApplicationConfig`                     | `liveQuery` / `mutate`, `injectLunoraClient()` |
| `@lunora/react-native` | `createLunoraClient({ url, storage })` + `LunoraProvider`    | re-exports `@lunora/react` hooks               |

The rest of this skill uses the React names; the others mirror the same
semantics (`usePaginatedQuery` → `createPaginatedQuery` / `paginatedQuery`,
`useConnectionStatus` → `createConnectionStatus` / `connectionStatus`, …).
React Native passes `storage: AsyncStorage` so the offline queue survives a
restart; `@lunora/react-native/auth` bridges a better-auth Expo session.
`@lunora/astro` and `@lunora/nuxt` (Nitro) integrate Lunora into the SSR server.

## Live Queries

`useQuery(reference, args, options?)` opens a subscription and returns the
value, or `undefined` while it loads. References come from codegen and are
typed end to end, so no cast is needed:

```tsx
import { useQuery } from "@lunora/react";

import { api } from "../lunora/_generated/api";

const todos = useQuery(api.todos.list, {});
const messages = useQuery(api.messages.list, { channelId }, { shardKey: channelId, onError: report });
```

- `undefined` means loading and `[]` means loaded-and-empty; branch on both.
- Pass `"skip"` as `args` to disable the query (no network call, no
  subscription) — e.g. until a required id is known.
- Pass `onError` to see a server-pushed error (an RLS denial, a query that starts
  throwing). Without it the error is dropped and the value silently freezes at
  its last good result.
- `shardKey`: for a `.shardBy(...)` table, pin every read and write to the
  shard's key (`{ shardKey: channelId }` on both `useQuery` and the mutation
  call). Without it the runtime has to fan out across every shard.
- The subscription re-runs only when `args` or the rows it read change. Keep
  `args` narrow so unrelated writes don't re-push data (see
  `lunora-performance-audit`).
- `useSubscription` is the push-only variant (no initial HTTP fetch) returning
  `{ data, error }`. For SSR, `@lunora/react/server` exports `preloadQuery`,
  `fetchQuery`, and `lunoraQueryOptions`; hand the result to
  `usePreloadedQuery` on the client.
- References in folders are nested: `lunora/billing/invoices.ts` →
  `api.billing.invoices.<fn>`. Client code only ever imports `api`;
  `internal` functions are not callable from the client.

## Authorization & Live Queries

Live queries are identity-aware. At the WebSocket upgrade the runtime stamps
the caller's verified identity onto the socket, and every subscription re-run
executes under that identity, so:

- `.use(rls(...))` and `ctx.auth.userId` behave the same in a subscription as in
  a one-shot read. Shape subscriptions AND-merge their predicate with the
  table's RLS read policy.
- An anonymous socket carries no identity, so an RLS/`ctx.auth` query fails
  closed (empty or denied) rather than leaking rows.
- When the credential carries an expiry, the server sends `TOKEN_EXPIRED` and
  closes with code `4001`. `LunoraClient` reconnects and re-resolves identity
  automatically; surface it in the UI only if a re-login is required.

Use `.shardBy(...)` and narrow args for performance, `rls()` / `ctx.auth` for
authorization. They compose.

## Mutations + Optimistic Updates

`useMutation(reference)` returns `{ mutate, pending, data, error, reset }`.
Destructure it — the hook result itself isn't callable. `mutate` returns a
promise that rejects on failure. Pass `optimisticUpdate` to paint the next state
immediately; if the server rejects the call the cache rolls back.

```tsx
import { useMutation } from "@lunora/react";

import { api } from "../lunora/_generated/api";
import type { Doc, Id } from "../lunora/_generated/dataModel";

const { mutate: add, pending } = useMutation(api.todos.add);

await add(
    { text },
    {
        optimisticUpdate: (store) => {
            const list = store.getQuery(api.todos.list, {}) ?? [];
            const provisional: Doc<"todos"> = {
                _id: `optimistic_${Date.now()}` as Id<"todos">,
                _creationTime: Date.now(),
                text,
                done: false,
                createdAt: Date.now(),
            };
            store.setQuery(api.todos.list, {}, [provisional, ...list]);
        },
    },
);
```

- `optimisticUpdate` names the query it patches because nothing can infer that
  `todos.add` affects `todos.list`. `store.getAllQueries(fn)` lists every
  subscribed args variant of a query so you can patch each one.
- The provisional row must match the query's element shape, including
  `_id`/`_creationTime`, or the UI flickers when the real row lands.
- The per-call `optimistic: (current) => next` shortcut only patches a
  subscription under the mutation's own reference and args (a counter, a doc by
  id). For the add-updates-list shape above it is a silent no-op.
- `pending` stays `true` until every overlapping call from this hook settles;
  use it to disable the submit button.
- Offline, mutations are queued by `LunoraClient` and replayed on reconnect,
  keyed by client id so they aren't applied twice.

## Pagination, Connection, Presence

The server query takes `paginationOpts` and returns `.paginate(...)` (see
`lunora-functions`). The hook supplies the cursor:

```tsx
const { results, status, loadMore, error } = usePaginatedQuery(api.messages.page, { channelId }, { initialNumItems: 20 });
// status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
```

Pages are live ranges: inserts and deletes inside a loaded page grow or shrink
it in place without duplicating rows. There is no total count; subscribe to a
separate count query for "42 of 1,203". `useInfiniteQuery` is the
TanStack-style alternative.

- `useConnectionStatus` — live socket state for an offline/reconnecting banner.
- `usePresence` — who's-here with heartbeat (pairs with the `presence` registry
  item).
- `useAuth` + `Authenticated` / `Unauthenticated` / `AuthLoading` — see
  `lunora-setup-auth`.

## `@lunora/db` — TanStack DB Collections

For indexed local collections, cross-query joins, or a durable offline outbox,
use `@lunora/db` (peer deps `@tanstack/db`, `@tanstack/offline-transactions`).
Plain `useQuery` / `useMutation` are enough for straightforward live lists.

```ts
import { defineCollections } from "@lunora/db";
import type { LunoraClient } from "lunorash/client";

import { api } from "../lunora/_generated/api";
import type { Doc, Id } from "../lunora/_generated/dataModel";

export const createCollections = (client: LunoraClient) =>
    defineCollections(client, {
        messages: {
            list: api.messages.list,
            scopeBy: "channelId", // the .shardBy column
            insert: {
                mutation: api.messages.send,
                optimistic: (input: Omit<Doc<"messages">, "_id" | "_creationTime">, id) => ({ _id: id as Id<"messages">, _creationTime: Date.now(), ...input }),
                toArgs: (row) => ({ channelId: row.channelId, id: row._id, text: row.text }),
            },
        },
    });
// → db.collections.* (feed useLiveQuery), db.actions.* (optimistic writes),
//   db.scope.* (re-point sharded collections), db.executor (the outbox)
```

Call `defineCollections` once and treat its collections as the single source of
truth per table. Optimistic writes and sync deltas land only on that instance,
so a second instance or a copy of the rows in your own store drifts: derived
indexes (trees, search, undo captures) built from the copy miss new rows and
hold stale ones, while `useLiveQuery` still looks correct.

## Checklist

- [ ] `LunoraClient` created once at module scope and registered the way the
      adapter expects.
- [ ] `undefined` handled as loading; `"skip"` used while args are incomplete;
      `onError` wired where a failure must be visible.
- [ ] Reads and writes on `.shardBy` tables pass `shardKey`.
- [ ] Mutations destructure `mutate`; `pending` disables submit;
      `optimisticUpdate` rows match the query's element shape.
- [ ] Lists that grow use `usePaginatedQuery` over a `.paginate` query.
- [ ] `@lunora/db`: one `defineCollections` instance; no parallel copy of rows.
