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

| Kind       | Reads `ctx.db`                    | Writes `ctx.db` | Side effects / `fetch` | Reactive |
| ---------- | --------------------------------- | --------------- | ---------------------- | -------- |
| `query`    | yes                               | no              | no                     | yes      |
| `mutation` | yes                               | yes             | no                     | —        |
| `action`   | no (use `runQuery`/`runMutation`) | no              | yes                    | —        |

```ts
import type { Id } from "@lunora/server";
import { LunoraError } from "@lunora/server";

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
  → `action`. An action has no `ctx.db`; it reaches data via `ctx.runQuery` /
  `ctx.runMutation`. A mutation called that way runs in its own all-or-nothing
  transaction, so put every write that has to land together in ONE mutation
  rather than sequencing several from the action.
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

`ctx.browser` and `ctx.sql` are **action-only** by design — they are
non-deterministic and would break query reactivity and mutation replay.

## HTTP endpoints

For webhooks or non-RPC HTTP, use `httpRouter` / `httpRoute` + `httpAction`:

```ts
import { httpAction, httpRouter } from "@lunora/server";

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
- [ ] Server-only logic uses `internal*`; expected failures throw `LunoraError`.
- [ ] `ctx.db` writes only inside mutations; ids typed with `Id<"table">`.
- [ ] Ran `lunora codegen`; typecheck is clean.
