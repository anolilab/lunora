---
name: cirrus-functions
description: Authoring rules for Cirrus schema and functions. Use when writing or reviewing
    `cirrus/` code — `defineSchema`/`defineTable`, `v.*` validators, query vs
    mutation vs action (and `internal*`), indexes & `withIndex`, the `ctx.db` API,
    pagination, scheduling, and `httpAction`.
---

# Cirrus Functions

The core authoring rules for Cirrus backend code. Read this before writing or
changing anything under `cirrus/`. After every edit, run `cirrus codegen` — it
regenerates `cirrus/_generated/` and typechecks your schema + functions.

## When to Use

- Writing or editing schema, queries, mutations, or actions.
- Reviewing `cirrus/` code for correctness and idiom.
- Deciding query vs mutation vs action, or public vs internal.

## When Not to Use

- Setting up a new project (`cirrus-quickstart`) or auth (`cirrus-setup-auth`).
- Diagnosing a slow query or write conflict (`cirrus-performance-audit`).
- Changing an existing schema with data at rest (`cirrus-migration-helper`).

## Schema: `defineSchema` + `defineTable`

`cirrus/schema.ts` exports `defineSchema` as the default export. Every column is
a `v.*` validator. Declare an index for every access pattern you query by.

```ts
import { defineSchema, defineTable, v } from "@cirrus/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        authorId: v.id("users"),
        body: v.string(),
        createdAt: v.number(),
    }).index("by_channel", ["channelId", "createdAt"]),

    channels: defineTable({
        name: v.string(),
    }),
});
```

- Cirrus injects `_id` and `_creationTime` on every row — do **not** declare
  them.
- `.index("name", ["a", "b"])` — columns are ordered; put equality columns
  first, then the range/sort column.
- `.shardBy("ownerId")` partitions the table across Durable Objects by key;
  `.global()` replicates it to D1 for cross-region reads. Default (neither) is a
  single root-scoped ShardDO. They are not combined on one table — for choosing
  between them, see the side-by-side comparison in the `cirrus-performance-audit`
  skill.

### Validators (`v.*`)

`string`, `number`, `boolean`, `id("table")`, `null`, `any`, `bigint`, `bytes`,
`literal(value)`, `array(item)`, `object({...})`, `record(key, value)`,
`union(a, b, …)`, `optional(inner)`, plus the convenience types `date`,
`timestamp`, and `storage` (an R2 object key). Use `v.optional(...)` for nullable
fields — required is the default.

## Functions: query / mutation / action

Each function declares `args` (a `v.*` map) and a `handler`. Export them as named
consts from `cirrus/*.ts`; codegen surfaces them as `api.<file>.<name>`.

| Kind       | Reads `ctx.db`                    | Writes `ctx.db` | Side effects / `fetch` | Reactive |
| ---------- | --------------------------------- | --------------- | ---------------------- | -------- |
| `query`    | yes                               | no              | no                     | yes      |
| `mutation` | yes                               | yes             | no                     | —        |
| `action`   | no (use `runQuery`/`runMutation`) | no              | yes                    | —        |

```ts
import type { Id } from "@cirrus/server";
import { action, CirrusError, mutation, query, v } from "@cirrus/server";

// `api` / `internal` come from codegen:
// import { api, internal } from "./_generated/api";

export const listByChannel = query({
    args: { channelId: v.id("channels") },
    handler: async (ctx, { channelId }) =>
        ctx.db
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", channelId))
            .collect(),
});

export const send = mutation({
    args: { channelId: v.id("channels"), body: v.string() },
    handler: async (ctx, { channelId, body }): Promise<Id<"messages">> => {
        if (!ctx.auth.userId) {
            throw new CirrusError("UNAUTHORIZED", "not signed in");
        }
        return ctx.db.insert("messages", {
            channelId,
            authorId: ctx.auth.userId as Id<"users">,
            body,
            createdAt: Date.now(),
        });
    },
});

export const notifySlack = action({
    args: { messageId: v.id("messages") },
    handler: async (ctx, { messageId }) => {
        const message = await ctx.runQuery(api.messages.getById, { messageId });
        await fetch(SLACK_WEBHOOK, { method: "POST", body: JSON.stringify(message) });
    },
});
```

- **Pick the right kind.** Reactive read → `query`. Transactional write →
  `mutation`. External I/O (`fetch`, third-party SDKs, calling other functions)
  → `action`. An action has no `ctx.db`; it reaches data via `ctx.runQuery` /
  `ctx.runMutation`.
- **`internal*` variants** (`internalQuery`, `internalMutation`,
  `internalAction`) are not exposed to clients — use them for server-only logic
  called from actions, crons, or other functions.
- **Throw `CirrusError`** (`import { CirrusError } from "@cirrus/server"`) with a
  code + message for expected failures; it serializes cleanly to the client.

## The `ctx.db` API

Reads:

```ts
await ctx.db.get(id);                                  // one row by id (or null)
ctx.db.query("t").withIndex("by_x", (q) => q.eq("x", v)); // indexed query
  .collect();   // all matching rows
  .first();     // first row or null
  .unique();    // exactly one (throws if 0 or >1)
  .take(n);     // first n rows
  .order("asc" | "desc")  // sort by the index range
  .paginate(opts);        // cursor page (pair with usePaginatedQuery)
```

Writes (mutations only):

```ts
await ctx.db.insert("t", { ...fields }); // returns the new Id
await ctx.db.patch(id, { field: next }); // shallow-merge update
await ctx.db.replace(id, { ...allFields }); // full overwrite
await ctx.db.delete(id);
```

**Prefer `withIndex` over `.filter`.** A `.filter(...)` with no covering index
scans the whole table — `@cirrus/advisor` flags it as `filter-without-index`.
Declare the index and constrain with `.withIndex`.

## Other `ctx` capabilities

`ctx.auth` (the resolved session: `ctx.auth.userId`), `ctx.scheduler`
(`runAfter` / `runAt` for deferred work), `ctx.storage` (R2), `ctx.vectors`
(Vectorize), and — when their packages are wired — `ctx.ai` and `ctx.containers`.

## HTTP endpoints

For webhooks or non-RPC HTTP, use `httpRouter` / `httpRoute` + `httpAction`:

```ts
import { httpAction, httpRouter } from "@cirrus/server";

export default httpRouter({
    "/webhooks/stripe": httpAction(async (ctx, request) => {
        const event = await request.json();
        await ctx.runMutation(internal.billing.record, { event });
        return new Response("ok");
    }),
});
```

## Checklist

- [ ] Schema columns are `v.*` validators; `_id`/`_creationTime` not declared.
- [ ] An index exists for every access pattern; queries use `withIndex`, not
      `.filter`.
- [ ] Right function kind: `query` (reactive read) / `mutation` (write) /
      `action` (side effects via `runQuery`/`runMutation`).
- [ ] Server-only logic uses `internal*`; expected failures throw `CirrusError`.
- [ ] `ctx.db` writes only inside mutations; ids typed with `Id<"table">`.
- [ ] Ran `cirrus codegen`; typecheck is clean.
