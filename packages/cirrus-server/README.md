# @cirrus/server

Server-side primitives for the Cirrus framework. This is what you import inside `cirrus/schema.ts` and your function files. It defines the `defineSchema` / `defineTable` builders, the `query` / `mutation` / `action` wrappers, and the `QueryCtx` / `MutationCtx` / `ActionCtx` shapes that handlers receive. It also re-exports the [`v` validator suite](../cirrus-values) for ergonomic single-import usage.

## Install

```bash
pnpm add @cirrus/server
```

Workspace dependency: [`@cirrus/values`](../cirrus-values) (re-exported as `v`, `Id`, `Infer`, `Validator`, `ValidationError`).

## Usage

### `cirrus/schema.ts`

```ts
import { defineSchema, defineTable, v } from "@cirrus/server";

export default defineSchema({
    rooms: defineTable({
        name: v.string(),
        createdAt: v.number(),
    }).index("by_name", ["name"]),

    messages: defineTable({
        author: v.string(),
        body: v.string(),
        ts: v.number(),
    })
        .index("by_room_ts", ["room", "ts"])
        .searchIndex("search_body", { field: "body", filterFields: ["room"] })
        .shardBy("room"),

    users: defineTable({ email: v.string() }).index("by_email", ["email"]).global(),
});
```

Table modifiers:

| Modifier                                | Effect                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| `.index(name, fields, opts?)`           | Secondary index. Pass `{ unique: true }` to enforce.      |
| `.searchIndex(name, { field, filterFields? })` | Full-text search index over a field.               |
| `.shardBy(field)`                       | Route storage by field — one Durable Object per distinct value. |
| `.global()`                             | Mark the table as D1-backed and cross-shard.              |

### `cirrus/messages.ts`

```ts
import { query, mutation, action, v } from "@cirrus/server";

export const list = query({
    args: { room: v.string() },
    handler: async (ctx, { room }) => {
        return ctx.db
            .query("messages")
            .withIndex("by_room_ts", (q) => q.eq("room", room))
            .take(50);
    },
});

export const send = mutation({
    args: { room: v.string(), body: v.string() },
    handler: async (ctx, { room, body }) => {
        const id = await ctx.db.insert("messages", { room, body, ts: Date.now(), author: ctx.auth.userId });
        return id;
    },
});

export const notify = action({
    args: { email: v.string(), subject: v.string() },
    handler: async (ctx, args) => {
        await ctx.fetch("https://api.resend.com/emails", { method: "POST", /* … */ });
        await ctx.runMutation(api.notifications.markSent, { to: args.email });
    },
});
```

## Contexts

| Context       | `db`              | `storage`         | `scheduler` | `auth` | `fetch` | `run*` |
| ------------- | ----------------- | ----------------- | ----------- | ------ | ------- | ------ |
| `QueryCtx`    | `DatabaseReader`  | `ReadOnlyStorage` | —           | yes    | —       | —      |
| `MutationCtx` | `DatabaseWriter`  | `ReadOnlyStorage` | yes         | yes    | —       | —      |
| `ActionCtx`   | `DatabaseWriter`  | `Storage`         | yes         | yes    | yes     | yes    |

- **Queries** are pure reads — no inserts, no storage writes, no `fetch`.
- **Mutations** can mutate the DB and schedule work, but cannot perform external HTTP or R2 writes. Storage stays read-only here (you can `download`/`getSignedUrl` but not `upload`/`delete`) — full storage lives on actions.
- **Actions** are the escape hatch: full `Storage` surface, `globalThis.fetch`, and `runQuery`/`runMutation`/`runAction` to compose with other functions.

Args are validated against the declared `args` validator at every call. On mismatch a `ValidationError` is thrown carrying the offending field's `path`.

## API

| Export                          | Description                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| `defineSchema(tables)`          | Build the application schema.                                          |
| `defineTable(shape)`            | Build a single table with fluent index/shard modifiers.                |
| `query({ args, handler })`      | Register a query.                                                      |
| `mutation({ args, handler })`   | Register a mutation.                                                   |
| `action({ args, handler })`     | Register an action.                                                    |
| `v`                             | Validator namespace (re-exported from `@cirrus/values`).               |
| `ValidationError`               | Thrown on args mismatch (re-exported).                                 |
| `anyApi`                        | Proxy stand-in for the generated `api` object — useful in tests.       |

Types: `TableBuilder`, `TableDefinition`, `Schema`, `IndexDefinition`, `SearchIndexDefinition`, `ShardMode`, `QueryCtx`, `MutationCtx`, `ActionCtx`, `DatabaseReader`, `DatabaseWriter`, `TableReader`, `IndexRangeBuilder`, `ReadOnlyStorage`, `Storage`, `Scheduler`, `AuthState`, `RegisteredQuery`, `RegisteredMutation`, `RegisteredAction`, `RegisteredFunction`, `FunctionKind`, `ArgsValidator`, `InferArgs`, `Id`, `Infer`, `Validator`, `ValidatorKind`, `AnyApi`.

## Docs

- Repo root: [README.md](../../README.md)
- Server reference: [apps/docs/content/docs/api/server.mdx](../../apps/docs/content/docs/api/server.mdx)
- Queries & mutations: [apps/docs/content/docs/concepts/queries-mutations.mdx](../../apps/docs/content/docs/concepts/queries-mutations.mdx)
- Sharding: [apps/docs/content/docs/concepts/sharding.mdx](../../apps/docs/content/docs/concepts/sharding.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
