# @cirrus/vectors

Cloudflare Vectorize adapter for the Cirrus framework. Integrates vector search into your Cirrus schema and runtime so you can declare vector indexes alongside your regular tables, keep them automatically in sync on every write, and query them from any function handler.

You bring your own embedder; `@cirrus/vectors` handles the Vectorize binding plumbing, batching, concurrency limits, and delete propagation.

## Install

```bash
pnpm add @cirrus/vectors
```

## Choosing your shape

### Shape A — `.vectorize(field, opts)` on the table (primary)

Declare the index inline on the table definition. Best for the common case: one natural-language field, one vector index.

```ts
// cirrus/schema.ts
import { defineSchema, defineTable, v } from "@cirrus/server";
import { embed } from "../app/embed"; // your own embedder

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
            metadata: ["title", "workspaceId"],
            embed,
        }),
});
```

### Shape B — `defineVectorIndex(...)` second argument to `defineSchema` (escape hatch)

Use when you need derived sources (e.g. `title + body`), multiple views of the same table, or computed metadata.

```ts
// cirrus/schema.ts
import { defineSchema, defineTable, defineVectorIndex, v } from "@cirrus/server";
import { embed } from "../app/embed";

export default defineSchema(
    {
        docs: defineTable({
            title: v.string(),
            body: v.string(),
            workspaceId: v.id("workspaces"),
        }).shardBy("workspaceId"),
    },
    {
        "docs-title-and-body": defineVectorIndex({
            source: { table: "docs", select: (row) => `${row.title}\n\n${row.body}` },
            metadata: (row) => ({ workspaceId: row.workspaceId }),
            dimensions: 1024,
            metric: "cosine",
            embed,
        }),
    },
);
```

Shape B lives in the optional second argument to `defineSchema` (not as a reserved key inside the table map) so per-table type inference stays intact and there is no reserved-name collision.

## Quick start

### Querying from a function handler

`ctx.vectors` is available on every `QueryCtx`, `MutationCtx`, and `ActionCtx`. On a query it exposes `query` and `getByIds`; on mutations/actions it also exposes `upsert`, `upsertNow`, and `deleteByIds`.

```ts
// cirrus/searchDocs.ts
import { query, v } from "@cirrus/server";
import { embed } from "../app/embed";

export const searchDocs = query({
    args: { q: v.string() },
    handler: async (ctx, { q }) => {
        const matches = await ctx.vectors.query("docs-body", {
            input: q,
            embed,
            topK: 10,
        });

        return matches.matches.map((m) => m.id);
    },
});
```

### `createVectors` — wire up the runtime adapter in the DO

`createVectors` constructs the `CirrusVectors` adapter. You pass it a map of logical index name to Vectorize binding; the adapter validates, batches, and enforces Vectorize limits.

```ts
import createVectors from "@cirrus/vectors";

// Inside your Durable Object setup, env is the Worker env.
const vectors = createVectors({
    indexes: {
        "docs-body": env.DOCS_BODY, // VectorizeIndex binding from wrangler
        "docs-title-and-body": env.DOCS_TITLE_AND_BODY,
    },
});
```

### `createContextVectors` — bridge `CirrusVectors` to the server `VectorSearch` contract

`createContextVectors` wraps a `CirrusVectors` instance and returns a `VectorSearchLike` that is assignable to the server's `ctx.vectors` slot. Used internally by the generated DO to wire the adapter onto each function context.

```ts
import createVectors, { createContextVectors } from "@cirrus/vectors";

const cirrusVectors = createVectors({ indexes: { "docs-body": env.DOCS_BODY } });
const contextVectors = createContextVectors(cirrusVectors);
// Pass contextVectors when building query/mutation context objects.
```

### `createVectorSyncHook` — keep Vectorize in sync with row writes

`createVectorSyncHook` returns a `WriteHook` that auto-propagates inserts, updates, and deletes into the matching Vectorize index. The generated DO calls this on every committed write; you can also call it manually for custom mutation flows.

```ts
import { createContextVectors, createVectorSyncHook } from "@cirrus/vectors";
import schema from "../cirrus/schema";

const syncHook = createVectorSyncHook({
    schema, // your compiled schema with embed closures
    vectors: contextVectors,
    namespace: tenantId, // shard / tenant key — REQUIRED for multi-tenant isolation
});

// Later, inside a write path:
await syncHook({ op: "insert", table: "docs", id: newDoc._id, doc: newDoc });
```

> **Tenant isolation** — Vectorize indexes are account-global. Always pass `namespace` equal to the shard or tenant key so upserts are isolated. Apply the same namespace when querying. Omitting it in a multi-tenant app means one tenant's vectors are queryable by another.

## API

### Value exports

| Export                          | Description                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createVectors(options)`        | Construct a `CirrusVectors` adapter from a map of Vectorize index bindings. Validates at construction time that at least one binding is provided.  |
| `createContextVectors(cirrus)`  | Bridge a `CirrusVectors` instance to the server's `VectorSearch` contract for attachment to function contexts.                                     |
| `createVectorSyncHook(options)` | Build a `WriteHook` that fans out upserts/deletes to every vector index sourced from the written table, covering both Shape A and Shape B indexes. |

### `CirrusVectors` methods (returned by `createVectors`)

| Method                          | Description                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `upsert(indexName, input)`      | Embed `input.input` and upsert a single vector. Returns `VectorizeUpsertMutation`.                        |
| `upsertMany(indexName, inputs)` | Embed and upsert up to 1 000 vectors, with bounded concurrency on the embedder fan-out.                   |
| `query(indexName, input)`       | Query by pre-computed `vector` or by `input` + `embed`. `topK` capped at 100. Returns `VectorizeMatches`. |
| `getByIds(indexName, ids)`      | Fetch up to 1 000 stored vectors by id.                                                                   |
| `deleteByIds(indexName, ids)`   | Delete up to 1 000 vectors by id. Returns `VectorizeDeleteMutation`.                                      |
| `describe(indexName)`           | Return `VectorizeIndexDetails` for the index (dimensions, vector count).                                  |

### Type exports

`CirrusVectors`, `CirrusVectorsOptions`, `EmbedFunction`, `QueryInput`, `UpsertInput`, `VectorizeDeleteMutation`, `VectorizeIndexDetails`, `VectorizeIndexLike`, `VectorizeMatch`, `VectorizeMatches`, `VectorizeQueryOptions`, `VectorizeUpsertMutation`, `VectorizeVector`, `VectorMetric` — from `./types`.

`SchemaLike`, `TableDefinitionLike`, `TableVectorIndexLike`, `VectorEmbedderLike`, `VectorIndexDefinitionLike`, `VectorMatchesLike`, `VectorMatchLike`, `VectorQueryInputLike`, `VectorRecordLike`, `VectorSearchLike`, `VectorUpsertInputLike`, `WriteEvent`, `WriteHook` — from `./context`.

## Wrangler bindings

Codegen discovers every vector index (Shape A and B) and emits a `VectorIndexName` union into `_generated/dataModel.ts`. The Vite plugin / wrangler validator then requires a matching `[[vectorize]]` binding (by `index_name`) in `wrangler.jsonc` for every declared index; a missing binding fails `dev` with a typed error.

```jsonc
// wrangler.jsonc
[[vectorize]]
binding = "DOCS_BODY"
index_name = "docs-body"

[[vectorize]]
binding = "DOCS_TITLE_AND_BODY"
index_name = "docs-title-and-body"
```

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.
