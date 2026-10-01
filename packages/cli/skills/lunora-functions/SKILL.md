---
name: lunora-functions
description: Authoring rules for Lunora schema and functions. Use when writing or reviewing
    `lunora/` code — `defineSchema`/`defineTable`, `v.*` validators, query vs
    mutation vs action (and `internal*`), indexes & `withIndex`, the `ctx.db` API,
    pagination, scheduling, and `httpAction`.
---

# Lunora Functions

The core authoring rules for Lunora backend code. Read this before writing or
changing anything under `lunora/`. After every edit, run `lunora codegen` — it
regenerates `lunora/_generated/` and typechecks your schema + functions.

## When to Use

- Writing or editing schema, queries, mutations, or actions.
- Reviewing `lunora/` code for correctness and idiom.
- Deciding query vs mutation vs action, or public vs internal.

## When Not to Use

- Setting up a new project (`lunora-quickstart`) or auth (`lunora-setup-auth`).
- Diagnosing a slow query or write conflict (`lunora-performance-audit`).
- Changing an existing schema with data at rest (`lunora-migration-helper`).

## Schema: `defineSchema` + `defineTable`

`lunora/schema.ts` exports `defineSchema` as the default export. Every column is
a `v.*` validator. Declare an index for every access pattern you query by.

```ts
import { defineSchema, defineTable, v } from "@lunora/server";

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

- Lunora injects `_id` and `_creationTime` on every row — do **not** declare
  them.
- `.index("name", ["a", "b"])` — columns are ordered; put equality columns
  first, then the range/sort column.
- `.shardBy("ownerId")` partitions the table across Durable Objects by key;
  `.global()` replicates it to D1 for cross-region reads. Default (neither) is a
  single root-scoped ShardDO. They are not combined on one table — for choosing
  between them, see the side-by-side comparison in the `lunora-performance-audit`
  skill.

### Validators (`v.*`)

`string`, `number`, `boolean`, `id("table")`, `null`, `any`, `bigint`, `bytes`,
`literal(value)`, `array(item)`, `object({...})`, `record(key, value)`,
`union(a, b, …)`, `optional(inner)`, plus the convenience types `date`,
`timestamp`, and `storage` (an R2 object key). Use `v.optional(...)` for nullable
fields — required is the default.

## Functions: query / mutation / action

Each function declares its inputs with `.input(...)` (a `v.*` map) and ends with a
terminal `.query` / `.mutation` / `.action` handler. Export them as named
consts from `lunora/*.ts`; codegen surfaces them as `api.<file>.<name>`.

| Kind       | Reads `ctx.db` | Writes `ctx.db`     | Side effects / `fetch` | Reactive |
| ---------- | -------------- | ------------------- | ---------------------- | -------- |
| `query`    | yes            | no                  | no                     | yes      |
| `mutation` | yes            | yes, transactional  | no                     | —        |
| `action`   | yes            | yes, autocommitting | yes                    | —        |

The builders are **generated**, not imported from `@lunora/server`: codegen binds
them to your schema, so `ctx.db`, `v.id("channels")`, and index names are all
typed. `@lunora/server` exports the schema/HTTP/validator surface and
`LunoraError`, never `query` / `mutation` / `action`.

```ts
import { LunoraError } from "lunorash/server";

import type { Id } from "#lunora/_generated/server.js";
import { action, mutation, query, v } from "#lunora/_generated/server.js";

// `api` / `internal` come from codegen:
// import { api, internal } from "./_generated/api";

export const listByChannel = query.input({ channelId: v.id("channels") }).query(async ({ ctx, args: { channelId } }) =>
    ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", channelId))
        .collect(),
);

export const send = mutation
    .input({ channelId: v.id("channels"), body: v.string() })
    .mutation(async ({ ctx, args: { channelId, body } }): Promise<Id<"messages">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHORIZED", "not signed in");
        }
        return ctx.db.insert("messages", {
            channelId,
            authorId: ctx.auth.userId as Id<"users">,
            body,
            createdAt: Date.now(),
        });
    });

export const notifySlack = action.input({ messageId: v.id("messages") }).action(async ({ ctx, args: { messageId } }) => {
    const message = await ctx.runQuery(api.messages.getById, { messageId });
    await fetch(SLACK_WEBHOOK, { method: "POST", body: JSON.stringify(message) });
});
```

- **Pick the right kind.** Reactive read → `query`. Transactional write →
  `mutation`. External I/O (`fetch`, third-party SDKs, calling other functions)
  → `action`. An action has a `ctx.db`, but its own writes are not
  transactional: each autocommits as it runs, so a later throw rolls nothing
  back. Reach data through `ctx.runQuery` / `ctx.runMutation` — a mutation
  called that way runs in the same all-or-nothing transaction a top-level one
  gets, so put every write that has to land together in ONE mutation rather
  than sequencing several from the action.
- **`internal*` variants** (`internalQuery`, `internalMutation`,
  `internalAction`) are not exposed to clients — use them for server-only logic
  called from actions, crons, or other functions.
- **Throw `LunoraError`** (`import { LunoraError } from "@lunora/server"`) with a
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
scans the whole table — `@lunora/advisor` flags it as `filter-without-index`.
Declare the index and constrain with `.withIndex`.

### Following foreign keys: `ctx.db.related`

Every `v.id("table")` column is an edge in a graph your schema already declares.
`ctx.db.related` walks it, so "this customer's tickets, and those tickets'
messages" is one call instead of a hand-written chain of `withIndex` lookups.

```ts
const { continueCursor, isDone, nodes } = await ctx.db.related(
    { table: "customers", id: customerId }, // or a row you already loaded
    { depth: 2, direction: "in", edges: ["tickets.customerId", "messages.ticketId"], limit: 50 },
);

for (const node of nodes) {
    node.table; // "messages"
    node.document; // the row itself
    node.depth; // 2
    node.score; // 0.5 — 1 at depth 1, halving per hop
    node.path; // ["tickets.customerId", "messages.ticketId"]
    node.pathIds; // ids along the way, start included
}
```

- **Edge names are `"<table>.<column>"`.** `edges` restricts the walk to the
  named ones; a name the schema does not declare is **refused**, not ignored.
- **`direction`** — `"out"` follows the ids this row holds, `"in"` the rows that
  point at it, `"both"` (the default) does both.
- **`depth`** defaults to `1`, max `4`. **`limit`** defaults to `50`, max `200`.
  Both caps **refuse rather than clamp**, so do not probe for the ceiling.
- **Only a column is an edge**: a bare `v.id(...)`, `v.optional(v.id(...))` or
  `v.array(v.id(...))`. An id nested in a `v.object` / `v.union` / `v.record` is
  not. An array FK is followed **outward only**.
- **It is an ordinary read** — RLS, column masks, soft delete, `.global()`
  routing and reactivity all apply, because every hop goes back through
  `ctx.db`. Under a `.rls("required")` schema each hop gets exactly the verdict a
  direct read of that table would, so declare a read policy for every table the
  walk can reach — or narrow it with `edges`.
- Index the foreign keys. Each inward hop is a `WHERE fk IN (…)` read, and
  unindexed it scans — see the `lunora-performance-audit` skill for the cost
  model and the traversal caps.

## Other `ctx` capabilities

Always available:

- `ctx.auth` — the resolved session (`ctx.auth.userId`).
- `ctx.scheduler` — `runAfter` / `runAt` for deferred work.
- `ctx.secrets` — Cloudflare Secrets Store.
- `ctx.span` / `ctx.trace` — the current span and a scoped tracing helper for
  wide events.

Added by their package when wired. **A dependency in `package.json` is not
enough** — codegen scans the `lunora/` source set and flips a capability on only
when a file there imports the `@lunora/*` package or reads its `ctx.*` helper.
So write the call first, then run `lunora codegen` to surface the typed context:

| `ctx.*`                                                                                   | Package                       |
| ----------------------------------------------------------------------------------------- | ----------------------------- |
| `ctx.storage`                                                                             | `@lunora/storage` (R2)        |
| `ctx.ai`                                                                                  | `@lunora/ai` (Workers AI)     |
| `ctx.flags`                                                                               | `@lunora/flags` (OpenFeature) |
| `ctx.queues.<name>`                                                                       | `@lunora/queue`               |
| `ctx.topics.<name>` (pub/sub, see below)                                                  | `@lunora/queue`               |
| `ctx.workflows` / `ctx.runStep`                                                           | `@lunora/workflow`            |
| `ctx.containers`                                                                          | `@lunora/container`           |
| `ctx.browser` (action-only)                                                               | `@lunora/browser`             |
| `ctx.sql` (action-only)                                                                   | `@lunora/hyperdrive`          |
| `ctx.kv` / `ctx.images` / `ctx.analytics` / `ctx.pipelines` / `ctx.vectors` / `ctx.r2sql` | `@lunora/bindings` subpaths   |

Two exceptions to the usage scan, and one extra requirement:

- **`ctx.flags` gates on a declaration file**, not on usage — codegen wires it
  only when `lunora/flags.ts` exists (`vis generate lunora-flags` creates it).
  `ctx.notify` / `ctx.push` work the same way via `lunora/notify.ts`.
- **`ctx.sql` also needs the real resource.** Codegen types the field, but the
  connection needs a `HYPERDRIVE` binding (`wrangler hyperdrive create`) and an
  explicit `createHyperdrive(ctx.env.HYPERDRIVE)` + driver adapter in the
  action — see `lunora-setup-hyperdrive`. Bindings codegen can provision on its
  own (e.g. `BROWSER` for `ctx.browser`) need no manual wrangler step.

`ctx.browser` and `ctx.sql` are **action-only** by design. They are external,
non-deterministic I/O: a query is re-run on every subscription re-evaluation, so
a non-deterministic read makes reactivity wrong, and a mutation's writes are
transactional — a rollback cannot un-send a network call.

### Topics: one event, many consumers

A queue has one consumer. To fan one event out to several independent
consumers, declare a topic and subscribe to it — in `lunora/queues.ts`, next to
your queues. Each subscription is its own queue with its own retries and
dead-letter queue.

```ts
// lunora/queues.ts
import { defineSubscription, defineTopic } from "@lunora/queue";

import { internal } from "./_generated/api";

export const signups = defineTopic<{ userId: string }>();

export const welcomeEmail = defineSubscription(signups, {
    handler: async (_ctx, batch) => {
        for (const message of batch.messages) {
            await message.run(internal.email.welcome, { userId: message.body.userId });
            message.ack();
        }
    },
    maxRetries: 5,
    deadLetterQueue: "welcome-email-dlq",
});

// in a mutation or action
await ctx.topics.signups.publish({ userId });
```

- Delivery is **at-least-once per subscription** and unordered — make handlers
  idempotent. A failed send rejects `publish`, and a retry re-delivers to the
  subscriptions that already got it.
- A subscription is published to only through its topic, never `ctx.queues`.
  The topic passed to `defineSubscription` must be a `defineTopic` export of the
  same file.
- Rate-limit public procedures that publish: one publish is one send per
  subscription (`privileged_fanout_from_public_procedure` flags it).

## Modules: grouping `lunora/` folders

A folder whose `module.ts` default-exports `defineModule(...)` is a module.
Modules are metadata — no `api.*` path or runtime change, still one Worker —
that drive the Studio **Architecture** view, OpenAPI tags, and table ownership:

```ts
// lunora/billing/module.ts
import { defineModule } from "@lunora/server";

export default defineModule({ description: "Invoices and payments", tables: ["invoices"] });
```

- Write `description` and `tables` inline; codegen reads them without running
  the file. Modules do not nest.
- `cross_module_table_write` warns when a function outside the owning module
  writes an owned table (insert, `patch`/`replace`/`delete`, batch or facade).
  Route the write through a function in the owning module instead.
- Installed components (`.extend(...)` schema extensions) count as modules that
  own their prefixed tables: write them through the component's functions, not
  `ctx.db` directly.
- Keep ids typed `Id<"table">` — a write through an untyped `string` id cannot
  be attributed to a table.

## HTTP endpoints

For webhooks or non-RPC HTTP, use `httpRouter` / `httpRoute` + `httpAction`:

`httpRouter()` takes **no arguments** — it returns a [Hono](https://hono.dev)
app you mount routes on, and you export the app. Passing it a routes object is a
type error (`Expected 0 arguments`), and from untyped code the routes simply
never mount.

```ts
// lunora/http.ts
import { httpAction, httpRouter } from "@lunora/server";

import { internal } from "./_generated/api";

const app = httpRouter();

app.post(
    "/webhooks/stripe",
    httpAction(async (ctx, request) => {
        const event = await request.json();

        await ctx.runMutation(internal.billing.record, { event });

        return new Response("ok");
    }),
);

export default app;
```

## Checklist

- [ ] Schema columns are `v.*` validators; `_id`/`_creationTime` not declared.
- [ ] An index exists for every access pattern; queries use `withIndex`, not
      `.filter`.
- [ ] Right function kind: `query` (reactive read) / `mutation` (write) /
      `action` (side effects via `runQuery`/`runMutation`).
- [ ] Server-only logic uses `internal*`; expected failures throw `LunoraError`.
- [ ] `ctx.db` writes only inside mutations; ids typed with `Id<"table">`.
- [ ] Any `ctx.db.related` walk is narrowed with `edges` / `direction`, and its
      foreign keys are indexed.
- [ ] Writes to a module- or component-owned table go through the owner's
      functions (`cross_module_table_write` is clean).
- [ ] Ran `lunora codegen`; typecheck is clean.
