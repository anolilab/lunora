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

See the [@cirrus/db guide](https://github.com/anolilab/cirrus) for the full API.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.
