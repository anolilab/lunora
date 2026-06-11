# @cirrus/db

Optimistic, offline-first client data layer for the Cirrus framework, built on [TanStack DB](https://tanstack.com/db). `defineCollections` binds your Cirrus queries and mutations into live, indexed client collections (reads) and a durable, retried offline-transactions outbox (writes) — so a write renders instantly, survives reloads and offline windows, is superseded by the real server row on acknowledgement, and rolls back if the server rejects it.

Peer-depends on `@tanstack/db` and `@tanstack/offline-transactions`; React bindings (`@tanstack/react-db`) are supplied by the consuming app.

```ts
import { defineCollections } from "@cirrus/db";

import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

export const createCollections = (client: CirrusClient) =>
    defineCollections(client, {
        messages: {
            list: api.messages.list,
            scopeBy: "channelId", // sharded — re-point with db.scope.messages({ channelId })
            insert: {
                mutation: api.messages.send,
                optimistic: (input: Omit<Doc<"messages">, "_id" | "_creationTime">, id) => ({
                    _id: id as Id<"messages">,
                    _creationTime: Date.now(),
                    ...input,
                }),
                toArgs: (row) => ({ channelId: row.channelId, id: row._id, text: row.text }),
            },
        },
        users: { list: api.users.list }, // read-only
    });

// → db.collections.* (feed useLiveQuery), db.actions.* (optimistic writes),
//   db.scope.* (re-point sharded collections), db.executor (the outbox)
```

You don't have to write this by hand — `vis generate cirrus-collections` scaffolds it from your `schema.ts` + functions.

## API reference

### `defineCollections(client, defs)`

`<D>(client: CirrusClient, defs: D) => CirrusDb<D>`. Wires each entry of `defs` into a live, auto-indexed TanStack DB collection synced from its `list` query, and — for entries with an `insert` binding — an optimistic write action backed by the offline-transactions outbox (durable, retried, client-id-keyed). Scoped (`scopeBy`) collections are re-pointable for sharded queries.

Each value in `defs` is a `CollectionDef`:

| Field     | Type                          | Description                                                                                            |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `list`    | `FunctionReference`           | **Required.** The Cirrus query that lists the rows — the sync source.                                  |
| `insert`  | `InsertBinding<TRow, TInput>` | Optional write binding. Present iff the collection is written through the outbox.                      |
| `scopeBy` | `string`                      | Optional field that scopes the list (e.g. a shard key); makes the collection re-pointable via `scope`. |
| `getKey`  | `(row) => string`             | Optional row-key extractor. Defaults to `row._id`.                                                     |

An `InsertBinding` describes how a write flows through the outbox:

| Field        | Type                               | Description                                                                                  |
| ------------ | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `mutation`   | `FunctionReference`                | The Cirrus mutation that persists the row.                                                   |
| `optimistic` | `(input, id) => TRow`              | Build the optimistic row to insert from the action input + the generated client id.          |
| `toArgs`     | `(row) => Record<string, unknown>` | Build the mutation args from the persisted optimistic row (forward `_id` as the `clientId`). |

A scoped collection starts empty and only subscribes once you call `db.scope.<name>(args)`; pass no args to detach.

### `CirrusDb<D>` (return value)

| Member        | Type                                       | Description                                                                                                                                         |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collections` | `{ [K]: Collection<RowOf<D[K]>, string> }` | The live, synced collections — feed these to `useLiveQuery`.                                                                                        |
| `actions`     | `{ [K]: (input) => { id; transaction } }`  | Optimistic, durable, retried write actions — present for `insert` collections. Returns the generated client `id` and the TanStack DB `Transaction`. |
| `scope`       | `{ [K]: (args?) => void }`                 | Re-point a `scopeBy` collection's subscription (omit `args` to detach) — present for scoped collections.                                            |
| `executor`    | `OfflineExecutor`                          | The shared offline executor (the outbox).                                                                                                           |

The result is fully typed from `defs`: only `insert` entries expose an `actions` member, only `scopeBy` entries expose a `scope` member, and each collection's row type is inferred from its `list` query's return.

### Lower-level helpers

Exported for testing and advanced composition: `toMap(rows, getKey)` (index a row list into a keyed map), `makeDiffEmit(synced, writer)` (diff a desired keyed snapshot into a collection's sync channel — only changed rows are written), `runOutboxMutation(mutate)` (run a mutation under the outbox retry policy: coded server errors become `NonRetriableError` and roll back, code-less network/infra failures are retried), and `createOptimisticOnlineDetector()` (an "always attempt" `OnlineDetector` that periodically nudges the executor to drain the outbox). Types: `CirrusDb`, `CollectionDef`, `InsertBinding`, `Row` (`Record<string, unknown> & { _id: string }`), `SyncWriter`.

See the [@cirrus/db guide](https://github.com/anolilab/cirrus) for the full walkthrough.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.
