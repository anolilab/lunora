---
name: lunora-functions
description: Authoring rules for Lunora schema and server functions under `lunora/` —
    `defineSchema`/`defineTable`, `v.*` validators, the generated
    `query`/`mutation`/`action` builders (and `internal*`), indexes and
    `withIndex`, the `ctx.db` API, pagination, `ctx.db.related`, opt-in `ctx.*`
    capabilities, topics, modules, services, and `httpAction`. Use when writing or
    reviewing files in `lunora/` (`schema.ts`, function files, `http.ts`,
    `queues.ts`), when asked to "add a query/mutation/action", "add an index",
    "call one function from another", or "add a webhook endpoint", or when
    `lunora codegen` reports an error in a function.
---

# Lunora Functions

The core authoring rules for Lunora backend code. The verify loop after every
edit:

1. `lunora codegen` — regenerates `lunora/_generated/` and prints advisor
   findings (it does not run `tsc`).
2. `lunora verify` — codegen dry-run plus `tsc --noEmit`, no files written.

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
import { defineSchema, defineTable, v } from "lunorash/server";

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

- Lunora injects `_id` and `_creationTime` on every row, so don't declare them.
- `lunorash/*` is the umbrella package templates install; `@lunora/server` is
  the same module if the project depends on it directly.
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
`union(a, b, …)`, `optional(inner)`, `partial({...})`, `geoPoint()`, the
convenience types `date`, `timestamp`, and `storage` (an R2 object key), and
`v.from(schema)` to adopt any Standard Schema v1 validator (Zod, Valibot, …).

- Required is the default. `v.optional(x)` means the field may be absent;
  `x.nullable()` means it may be `null`. They are different.
- Refinements chain on the validator and are enforced at the trust boundary:
  `v.string().min(1).max(4096)`, `.email()`, `.url()`, `.pattern(re)`;
  `v.number().int().min(0)`, `.positive()`; `v.array(x).max(n)`. Bound every
  client-supplied string and array — templates cap text at `.max(4096)`.

## Functions: query / mutation / action

Each function declares its inputs with `.input(...)` (a `v.*` map), optionally
adds `.use(middleware)` (rate limiting, RLS, masking) and `.output(validator)`,
and ends with a terminal `.query` / `.mutation` / `.action` taking a
`({ ctx, args }) => …` handler. Export them as named consts from `lunora/*.ts`.
Codegen nests references by path: `lunora/messages.ts` → `api.messages.<fn>`,
`lunora/billing/invoices.ts` → `api.billing.invoices.<fn>`. Public functions
land in `_generated/api.ts`, `internal*` ones in `_generated/internal.ts`.

| Kind       | Reads `ctx.db` | Writes `ctx.db`     | Side effects / `fetch` | Reactive |
| ---------- | -------------- | ------------------- | ---------------------- | -------- |
| `query`    | yes            | no                  | no                     | yes      |
| `mutation` | yes            | yes, transactional  | no                     | —        |
| `action`   | yes            | yes, autocommitting | yes                    | —        |

Import the builders from `_generated/server`, not from `lunorash/server`: codegen
binds them to your schema, which is what types `ctx.db`, `v.id("channels")`, and
index names. `lunorash/server` exports the schema/HTTP/validator surface and
`LunoraError`, never `query` / `mutation` / `action`.

```ts
// lunora/messages.ts
import { LunoraError } from "lunorash/server";

import { api } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/server.js";
import { action, mutation, query, v } from "./_generated/server.js";

export const listByChannel = query.input({ channelId: v.id("channels") }).query(async ({ ctx, args: { channelId } }): Promise<Doc<"messages">[]> =>
    ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", channelId))
        .take(100),
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

export const notifySlack = action.input({ channelId: v.id("channels") }).action(async ({ ctx, args: { channelId } }) => {
    const messages = await ctx.runQuery(api.messages.listByChannel, { channelId });
    await fetch(String(ctx.env?.SLACK_WEBHOOK_URL), { method: "POST", body: JSON.stringify(messages) });
});
```

Templates also map `#lunora/*` to `./lunora/*` in `package.json` `imports`, so
`#lunora/_generated/server.js` works from anywhere in the project.

- **Pick the right kind.** Reactive read → `query`. Transactional write →
  `mutation`. External I/O (`fetch`, third-party SDKs, calling other functions)
  → `action`. An action has a `ctx.db`, but its own writes are not
  transactional: each autocommits as it runs, so a later throw rolls nothing
  back. Reach data through `ctx.runQuery` / `ctx.runMutation` — a mutation
  called that way runs in the same all-or-nothing transaction a top-level one
  gets, so put every write that has to land together in one mutation rather
  than sequencing several from the action.
- **`internal*` variants** (`internalQuery`, `internalMutation`,
  `internalAction`) are not exposed to clients — use them for server-only logic
  called from actions, crons, or other functions.
- **Throw `LunoraError(code, message?, options?)`** from `lunorash/server` for
  expected failures (`"UNAUTHORIZED"`, `"NOT_FOUND"`, …); it serializes with its
  code to the client, where `isUnauthorizedError` and friends branch on it.

## The `ctx.db` API

Reads:

```ts
await ctx.db.get(id);                                  // one row by id (or null)
ctx.db.query("t").withIndex("by_x", (q) => q.eq("x", v)); // indexed query
  .order("asc" | "desc")  // by the active index (or _creationTime)
  .filter((doc) => …)     // JS predicate, applied after the index range
  .collect();   // all matching rows
  .take(n);     // first n rows
  .first();     // first row or null
  .unique();    // the one match, null if none; throws if more than one
  .paginate({ numItems, cursor }); // { page, isDone, continueCursor }
```

Writes (mutations, and autocommitting in actions):

```ts
await ctx.db.insert("t", { ...fields }); // returns the new Id
await ctx.db.patch(id, { field: next }); // shallow-merge update
await ctx.db.replace(id, { ...allFields }); // full overwrite
await ctx.db.delete(id);
```

Prefer `withIndex` over `.filter`: a `.filter(...)` without a covering index
scans the whole table (advisor: `filter_without_index`), and a bare `.collect()`
grows with the table and with every subscriber's payload (`unbounded_collect`).
Constrain with `.withIndex`, cap with `.take(n)`, or paginate.

### Pagination

A paginated query takes a `paginationOpts` arg and returns `.paginate(...)`
as-is; the client hook (`usePaginatedQuery`, see `lunora-realtime`) supplies it:

```ts
// `v.any()` would type the arg `unknown`, which `.paginate()` rejects. The hook
// also sends `endCursor`; an undeclared key is stripped, so declare it.
const cursor = v.optional(v.union(v.string(), v.null()));

export const page = query
    .input({ channelId: v.id("channels"), paginationOpts: v.object({ cursor, endCursor: cursor, numItems: v.number() }) })
    .query(async ({ ctx, args: { channelId, paginationOpts } }) =>
        ctx.db
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", channelId))
            .order("desc")
            .paginate(paginationOpts),
    );
```

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
  named ones; a name the schema does not declare is refused, not ignored.
- **`direction`** — `"out"` follows the ids this row holds, `"in"` the rows that
  point at it, `"both"` (the default) does both.
- **`depth`** defaults to `1`, max `4`. **`limit`** defaults to `50`, max `200`.
  Both caps refuse rather than clamp, so a probe for the ceiling just errors.
- **Only a column is an edge**: a bare `v.id(...)`, `v.optional(v.id(...))` or
  `v.array(v.id(...))`. An id nested in a `v.object` / `v.union` / `v.record` is
  not. An array FK is followed outward only.
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

- `ctx.auth` — the resolved session (`ctx.auth.userId`, `null` when anonymous).
- `ctx.secrets` — Cloudflare Secrets Store.
- `ctx.ip` — the caller's `CF-Connecting-IP`; `undefined` off Cloudflare.
- `ctx.runQuery` (all kinds), `ctx.runMutation` (mutations, actions),
  `ctx.runAction` (actions) — call another function by its `api.*` /
  `internal.*` reference.
- `ctx.log`, `ctx.metrics`, `ctx.span` / `ctx.trace` — logging, metrics, the
  current wide-event span and a scoped tracing helper.

Wired by codegen on use. A dependency in `package.json` is not enough: codegen
scans the `lunora/` source set and turns a capability on only when a file there
imports its `@lunora/*` package or reads its `ctx.*` helper. Write the call
first, then run `lunora codegen` to wire the binding and typed context:

| `ctx.*`                                                                                   | Package                       |
| ----------------------------------------------------------------------------------------- | ----------------------------- |
| `ctx.scheduler` (mutations + actions; see `lunora-setup-scheduler`)                       | `@lunora/scheduler`           |
| `ctx.storage` (R2; see `lunora-setup-storage`)                                            | `@lunora/storage`             |
| `ctx.ai`                                                                                  | `@lunora/ai` (Workers AI)     |
| `ctx.flags`                                                                               | `@lunora/flags` (OpenFeature) |
| `ctx.queues.<name>`                                                                       | `@lunora/queue`               |
| `ctx.topics.<name>` (pub/sub, see below)                                                  | `@lunora/queue`               |
| `ctx.workflows` / `ctx.runStep`                                                           | `@lunora/workflow`            |
| `ctx.containers`                                                                          | `@lunora/container`           |
| `ctx.browser` (action-only)                                                               | `@lunora/browser`             |
| `ctx.sql` (action-only)                                                                   | `@lunora/hyperdrive`          |
| `ctx.kv` / `ctx.images` / `ctx.analytics` / `ctx.pipelines` / `ctx.vectors` / `ctx.r2sql` | `@lunora/bindings` subpaths   |

One exception to the usage scan, and one extra requirement:

- **`ctx.flags` gates on a declaration file**, not on usage — codegen wires it
  only when `lunora/flags.ts` exists. `ctx.notify` / `ctx.push` work the same
  way via `lunora/notify.ts`.
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

import { internal } from "./_generated/internal.js";

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
  The topic passed to `defineSubscription` must be a `defineTopic` export of
  `lunora/queues.ts` or a module's `queues.ts` (import it from there).
- Rate-limit public procedures that publish: one publish is one send per
  subscription (`privileged_fanout_from_public_procedure` flags it).

## Modules: grouping `lunora/` folders

A folder whose `module.ts` default-exports `defineModule(...)` is a module.
Modules are metadata — no `api.*` path or runtime change, still one Worker —
that drive the Studio **Architecture** view, OpenAPI tags, and table ownership:

```ts
// lunora/billing/module.ts
import { defineModule } from "lunorash/server";

export default defineModule({ description: "Invoices and payments", tables: ["invoices"] });
```

- Write `description` and `tables` inline; codegen reads them without running
  the file. Modules do not nest.
- A module can declare its own queues, topics and subscriptions in
  `lunora/<module>/queues.ts`. Export names stay app-wide (`ctx.queues.<name>`),
  so two queues files exporting the same name is a codegen error.
- `cross_module_table_write` warns when a function outside the owning module
  writes an owned table (insert, `patch`/`replace`/`delete`, batch or facade),
  including through a same-file helper. Move the write into the owning module:
  an exported helper there taking the caller's `ctx` (`openInvoice(ctx, …)`), or
  a registered owner mutation via `ctx.runMutation(internal.<owner>.<fn>, …)`.
- Installed components (`.extend(...)` schema extensions) count as modules that
  own their prefixed tables: write them through the component's functions, not
  `ctx.db` directly.
- Keep ids typed `Id<"table">` — a write through an untyped `string` id cannot
  be attributed to a table.

## Services: calling sibling Workers

A Worker the app calls (a parser, an LLM gateway) is declared in
`lunora.config.ts`, not discovered. Each one becomes a typed `ctx.services.<key>`
on **actions** (not queries/mutations: a cross-Worker call cannot be replayed or
rolled back; HTTP actions reach it through `ctx.runAction`):

```ts
// lunora.config.ts
export default {
    services: {
        documentParser: { dir: "services/document-parser" }, // fetch service
        llmGateway: { dir: "services/llm-gateway", entrypoint: "Gateway" }, // RPC
    },
};

// in an action
const parsed = await ctx.services.documentParser.fetch("https://parser/parse", { body, method: "POST" });
const text = await ctx.services.llmGateway.complete(prompt); // typed from the Gateway class
```

- The Worker name and entry come from `<dir>/wrangler.jsonc`; Lunora writes the
  `services[]` binding (`SERVICE_<KEY>`), runs it in the same `lunora dev` /
  `vite dev` session, and deploys it before the app.
- A bound service needs no URL, no `*_URL` var and no HMAC: set
  `"workers_dev": false` on it (`lunora doctor` warns otherwise).

## HTTP endpoints

For webhooks or non-RPC HTTP, use `httpRouter` / `httpRoute` + `httpAction`:

`httpRouter()` takes **no arguments** — it returns a [Hono](https://hono.dev)
app you mount routes on, and you export the app. Passing it a routes object is a
type error (`Expected 0 arguments`), and from untyped code the routes simply
never mount.

```ts
// lunora/http.ts
import { httpRouter } from "lunorash/server";

import { internal } from "./_generated/internal.js";

const app = httpRouter();
const encoder = new TextEncoder();

// Stripe's scheme: `stripe-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
// The Stripe SDK's `stripe.webhooks.constructEventAsync` does the same check.
const verifyStripe = async (secret: string, header: string | undefined, payload: string): Promise<boolean> => {
    const fields = header?.split(",").map((part) => part.split("=", 2)) ?? [];
    const t = fields.find(([k]) => k === "t")?.[1];
    const v1 = fields.find(([k]) => k === "v1")?.[1];

    if (!t || !v1 || !/^[\da-f]{64}$/.test(v1) || Math.abs(Date.now() / 1000 - Number(t)) > 300) {
        return false; // missing, malformed, or outside the 5-minute replay window
    }

    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(v1.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

    return crypto.subtle.verify("HMAC", key, signature, encoder.encode(`${t}.${payload}`)); // constant-time
};

// A plain Hono handler, not `httpAction`: the action ctx (`c.var.lunora`) has
// no env, while `c.env` is the Worker env.
app.post("/webhooks/stripe", async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET;

    if (typeof secret !== "string") {
        throw new Error("STRIPE_WEBHOOK_SECRET is not set");
    }

    const payload = await c.req.text(); // the raw bytes the signature covers

    if (!(await verifyStripe(secret, c.req.header("stripe-signature"), payload))) {
        return c.text("invalid signature", 401);
    }

    await c.var.lunora.runMutation(internal.billing.record, { event: JSON.parse(payload) as unknown });

    return c.text("ok");
});

export default app;
```

A webhook route is public: verify the provider's signature over the raw body
before any write, or anyone can forge events into `internal.*` functions.

## Checklist

- [ ] Schema columns are `v.*` validators; `_id`/`_creationTime` not declared.
- [ ] An index exists for every access pattern; queries use `withIndex`, not
      `.filter`, and are bounded (`.take(n)` / `.paginate`).
- [ ] Client-supplied strings and arrays carry a `.max(...)`.
- [ ] Right function kind: `query` (reactive read) / `mutation` (write) /
      `action` (side effects via `runQuery`/`runMutation`).
- [ ] Server-only logic uses `internal*`; expected failures throw `LunoraError`.
- [ ] Writes that must land together sit in one mutation; ids typed `Id<"table">`.
- [ ] Any `ctx.db.related` walk is narrowed with `edges` / `direction`, and its
      foreign keys are indexed.
- [ ] Writes to a module- or component-owned table go through the owner's
      functions (`cross_module_table_write` is clean).
- [ ] `lunora codegen` shows no new advisor findings; `lunora verify` is clean.
