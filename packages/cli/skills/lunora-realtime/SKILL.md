---
name: lunora-realtime
description: Wires Lunora's live data into a client. Use for `LunoraClient`/`LunoraProvider`,
    reactive `useQuery`/`useSubscription`, `useMutation` with optimistic updates,
    pagination, connection status, the React/Vue/Solid/Svelte/Angular/React Native
    adapters, and the `@lunora/db` TanStack binding.
---

# Lunora Realtime

Consume Lunora functions reactively from the client. Queries are live
subscriptions over WebSocket — a `useQuery` re-renders the instant a mutation
changes the rows it reads — and mutations can paint optimistically with
automatic rollback.

## When to Use

- Wiring a frontend to a Lunora backend (React, Vue, Solid, Svelte, Angular,
  React Native/Expo, or an Astro/Nuxt meta-framework).
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

Two adapters differ in shape:

- **`@lunora/angular`** is signal-based rather than hook-based: register with
  `provideLunora(...)`, read the client via `injectLunoraClient()`, and use
  `liveQuery(...)` / `mutate(...)` / `connectionStatus(...)` in place of the
  hooks below.
- **`@lunora/react-native`** re-exports all of `@lunora/react` and adds
  `createLunoraClient` (plus `@lunora/react-native/auth` for the better-auth
  Expo bridge) — build the client with that instead of `new LunoraClient`.

For SSR meta-frameworks, `@lunora/astro` and `@lunora/nuxt` compose Lunora into
the server (Nitro for Nuxt) and ship reactive-loader server helpers.

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

**Live queries are identity-aware.** At the WebSocket upgrade the runtime
stamps the caller's verified identity onto the socket (from the server-minted
`x-lunora-userid` / `x-lunora-identity` headers, which a client cannot forge).
Every subscription re-run, shape resolution, and poke-driven refresh executes
under that socket's own identity, passed by value so a concurrent RPC can't
clobber it.

Practically, this means:

- `.use(rls(...))` and `ctx.auth.userId` work the same in a subscribed query as
  in a one-shot read. Shape subscriptions AND-merge the shape predicate with
  the table's RLS read base-where, so the membership query the poke protocol
  runs is RLS-correct by construction — never the client's word for it.
- An **anonymous** socket carries no identity, so an RLS/`ctx.auth` query fails
  closed (empty/denied) rather than leaking another user's rows.
- **Token expiry is enforced on the socket.** When the resolved credential
  carries an expiry, the DO sends a `TOKEN_EXPIRED` error frame and closes with
  code `4001` at the next send at or after that instant. `LunoraClient`
  reconnects automatically and re-resolves a fresh identity — but surface it in
  the UI if a re-login is required.

You can still scope data structurally when it fits the domain — `.shardBy(userId)`
(or tenant/room) partitions state so a subscription is narrow by construction,
and explicit query args keep subscriptions cheap (see the args-scoping note
above). Prefer those for _performance_; use `rls()` / `ctx.auth` for
_authorization_. They compose.

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

Call `defineCollections` **once** at module scope and treat the returned
collections as the single source of truth for each table. Don't mirror rows into
a parallel store, and never build derived indexes (trees, search, undo captures)
from a copy — optimistic writes and sync deltas land only on the Lunora
collection, so code reading a copy silently reads stale rows while `useLiveQuery`
renders fresh data.

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
5. **Two sources of truth for the same rows.** `defineCollections` more than once
   per table (or a parallel store of your own) mints copies that drift. Reads
   through `useLiveQuery` look fine, but derived indexes built from the copy can
   **miss rows** — rows written to the collection after the copy was taken never
   appear in the index — or **hold stale rows** — rows updated or deleted in the
   collection still show their old value. One instance, one collection per table.

## Checklist

- [ ] `LunoraClient` created once at module scope; app wrapped in the provider.
- [ ] Live reads use `useQuery`; `undefined` handled as loading.
- [ ] Writes use `useMutation`; `pending` disables submit; `optimistic` matches
      the row shape.
- [ ] Query `args` scoped narrowly to avoid over-broad re-renders.
- [ ] Pagination via `usePaginatedQuery`/`useInfiniteQuery` over `.paginate`.
- [ ] Considered `@lunora/db` if the app needs local indexes/joins or an outbox.
- [ ] `@lunora/db`: one `defineCollections` instance; no parallel copy of rows;
      derived indexes built from the same collection the UI renders.
