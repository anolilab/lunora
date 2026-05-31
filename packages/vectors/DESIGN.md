# @cirrus/vectors — DSL spike

Two candidate shapes for declaring vector indexes in `cirrus/schema.ts`. The
runtime adapter (`createVectors`) is shared between them — only the schema-side
surface and the codegen output change.

Both spikes assume the user brings their own embedder (BYOE) and that
`ctx.vectors.*` is exposed on `QueryCtx` and `MutationCtx` (the heavy hosted
work happens in `ActionCtx`).

---

## Shape A — `.vectorize(field, opts)` fluent chain on the table

```ts
// cirrus/schema.ts
import { defineSchema, defineTable, v } from "@cirrus/server";
import { embed } from "../app/embed"; // user's own embedder

export default defineSchema({
    docs: defineTable({
        title: v.string(),
        body: v.string(),
        workspaceId: v.id("workspaces"),
    })
        .shardBy("workspaceId")
        .vectorize("body", {
            index: "docs-body",
            dimensions: 1024,
            metric: "cosine",
            metadata: ["title", "workspaceId"], // mirrored as Vectorize metadata
            embed,
        }),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),
});
```

```ts
// cirrus/searchDocs.ts
import { query, v } from "@cirrus/server";
import { embed } from "../app/embed";

export const searchDocs = query({
    args: { q: v.string() },
    handler: async (ctx, { q }) => {
        const matches = await ctx.vectors.indexFor("docs", "body").query({ input: q, embed, topK: 10 });

        return matches.matches.map((m) => m.id);
    },
});
```

**Pros**

- Mirrors `.shardBy()` / `.index()` / `.searchIndex()` — feels native to the existing chain
- Codegen knows the (table, field) association directly → metadata can be strongly typed against the table's shape (`metadata: ["title", "workspaceId"]` is checked against `Shape`)
- Auto-propagation on `db.delete/patch/replace` is a 1-liner — the table holds the vector handle
- `ctx.vectors.indexFor("docs", "body")` reads naturally

**Cons**

- Source is **always one column on this table**. Want to embed `title + body`? Need a synthetic column or a separate define.
- Multiple vector views of the same table (e.g. body and title-and-body) require multiple chained calls — readable but stacks up
- Embed config lives on the table — sharing across tables means duplicating

---

## Shape B — `defineVectorIndex(...)` top-level helper

```ts
// cirrus/schema.ts
import { defineSchema, defineTable, defineVectorIndex, v } from "@cirrus/server";
import { embed } from "../app/embed";

export default defineSchema({
    docs: defineTable({
        title: v.string(),
        body: v.string(),
        workspaceId: v.id("workspaces"),
    }).shardBy("workspaceId"),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),

    vectorIndexes: {
        "docs-body": defineVectorIndex({
            source: { table: "docs", select: (row) => row.body },
            metadata: (row) => ({ title: row.title, workspaceId: row.workspaceId }),
            dimensions: 1024,
            metric: "cosine",
            embed,
        }),

        "docs-title-and-body": defineVectorIndex({
            source: { table: "docs", select: (row) => `${row.title}\n\n${row.body}` },
            dimensions: 1024,
            metric: "cosine",
            embed,
        }),
    },
});
```

```ts
// cirrus/searchDocs.ts
import { query, v } from "@cirrus/server";
import { embed } from "../app/embed";

export const searchDocs = query({
    args: { q: v.string() },
    handler: async (ctx, { q }) => {
        const matches = await ctx.vectors["docs-body"].query({ input: q, embed, topK: 10 });
        return matches.matches.map((m) => m.id);
    },
});
```

**Pros**

- Vector index is a first-class entity. Multiple indexes per table is trivial.
- `select` is a function → can derive vector source from any computation (`title + body`, sliding windows, etc.)
- `metadata` is a function → arbitrary projection, derived fields allowed
- Closer to Cloudflare's own mental model (a Vectorize index _is_ a top-level resource with its own dimensions/metric)
- Easy to extend later to cross-table indexes (compose multiple tables in v0.2)

**Cons**

- Schema layout splits into two top-level concerns (tables + vectorIndexes)
- The framework has to maintain a back-reference (table → its indexes) to power auto-propagation on `db.delete/patch/replace`
- Slightly more verbose for the simple case (one body field, one index)
- `vectorIndexes` is a fixed name — collides with a hypothetical user table called that. Mitigate by using a symbol-keyed slot or `defineSchema({ tables, vectorIndexes })` form.

---

## Decision — both shapes shipped

**Shape A is the primary surface; Shape B is the opt-in escape hatch.** Both
are implemented and share the `createVectors` runtime adapter.

Most apps want one vector per natural-language field on one table — exactly
Shape A's sweet spot. The handful of cases that need derived sources or
multi-table indexes drop down to `defineVectorIndex(...)` and pair it with an
explicit `ctx.vectors.upsertNow(...)` from a mutation/action.

Shape B lives in an **optional second argument** to `defineSchema` rather than a
reserved `vectorIndexes` key inside the table map. This keeps the first
argument's per-table type inference intact (`schema.tables.docs.shape.body` stays
typed) and sidesteps the reserved-name collision flagged in Shape B's cons:

```ts
defineSchema(
    {
        docs: defineTable({ ... }).shardBy("workspaceId").vectorize("body", { index: "docs-body", ... }),
        // ...
    },
    {
        "docs-title-and-body": defineVectorIndex({
            source: { table: "docs", select: (r) => `${r.title}\n\n${r.body}` },
            // ...
        }),
    },
);
```

Codegen discovers Shape A by the `.vectorize()` chain method and Shape B from
the second `defineSchema` argument, hoisting both into a flat
`SchemaIR.vectorIndexes` list. From there it emits a `VectorIndexName` union into
`_generated/dataModel.ts` and the wrangler validator requires a matching
`[[vectorize]]` binding (by `index_name`) for every declared index.

---

## Independent choices already locked in

| Decision            | Choice                                                                                                                                        | Reason                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Embedder            | Bring-your-own (user supplies `embed: (input) => number[]`)                                                                                   | Decouple from any single provider; works with Workers AI, OpenAI, local, custom           |
| Upsert timing       | Caller picks per-call. Default = post-commit (queued via `@cirrus/scheduler`); explicit `ctx.vectors.upsertNow(...)` for sync                 | Keeps mutation latency fast by default but doesn't lock out users who want sync semantics |
| Delete propagation  | Auto: `db.delete(id)` on a vectorized table removes the vector(s) for `id`                                                                    | Ergonomic; only one source of truth for "this row is gone"                                |
| Shard semantics     | Vectorize is account-global. Index lives outside DO storage; results return ids that the caller re-fetches via shard-aware `ctx.db.x.get(id)` | Matches the underlying CF resource model — no fake sharding                               |
| Wrangler validation | Codegen surfaces required `[[vectorize]]` bindings; missing binding fails dev with a typed error                                              | Same pattern as the existing D1/R2 validators                                             |
