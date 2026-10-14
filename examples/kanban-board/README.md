# @lunora-example/kanban-board

A drag-and-drop board — four columns, live for everyone looking at it, with
positions stored as fractional index keys so a reorder writes exactly one row.

## Deploy it

> [!WARNING]
> **This example has no authentication.** Deployed as-is, anyone with the URL can read, move and delete every card. It is built to demonstrate ordering and optimistic updates, not access control — wire `@lunora/auth` and gate the mutations on `ctx.auth.userId` before putting anything real on it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/kanban-board)

One click clones the repo, provisions the Durable Object namespace, prompts for the secrets in
`.dev.vars.example`, and deploys. Or from a checkout:

```bash
pnpm --filter @lunora-example/kanban-board run deploy
```

## What it demonstrates

- **Fractional index ordering.** `lunora/ordering.ts` computes the key strictly
  between two neighbours. Dropping a card patches only that card, so two people
  dragging different cards never contend — unlike integer positions, which
  renumber the tail on every drop and conflict under the shard's OCC.
- **Server-side drop resolution.** The browser sends a drop _index_; the `move`
  mutation reads the destination column and mints the key inside the same
  transaction. A client dragging against a slightly stale board still lands
  where the user aimed.
- **Optimistic updates across a whole query.** `withOptimisticUpdate` splices the
  card into place in the cached `tasks.list` result, and the server delta
  replaces that layer when it lands.
- **Native HTML5 drag and drop.** No drag library — the drop index comes from
  the rendered cards' midpoints.

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/kanban-board dev
```

Vite + Wrangler in Miniflare; open <http://localhost:5173> in two windows and
drag a card in one.

## Key snippets

### Schema (`lunora/schema.ts`)

```ts
export default defineSchema({
    tasks: defineTable({
        title: v.string(),
        // Spelled out, not imported from a shared const: codegen reads column
        // validators syntactically, so an identifier it has to follow degrades
        // the generated column type.
        status: v.union(v.literal("todo"), v.literal("in-progress"), v.literal("done"), v.literal("archived")),
        order: v.string(),
    }).index("by_status_and_order", ["status", "order"]),
});
```

Root-scoped — the whole board lives in one ShardDO, which is exactly the unit of
consistency a board wants. Reach for `.shardBy` once boards become independent.

### Moving a card (`lunora/tasks.ts`)

```ts
export const move = mutation
    .input({ id: v.id("tasks"), status: v.union(v.literal("todo"), v.literal("in-progress"), v.literal("done"), v.literal("archived")), index: v.number() })
    .mutation(async ({ args: { id, index, status: column }, ctx }) => {
        const cards = await ctx.db
            .query("tasks")
            .withIndex("by_status_and_order", (q) => q.eq("status", column))
            .order("asc")
            .collect();
        const neighbours = cards.filter((row) => row._id !== id);
        const position = Math.max(0, Math.min(index, neighbours.length));

        await ctx.db.patch(id, { order: midpoint(neighbours[position - 1]?.order ?? null, neighbours[position]?.order ?? null), status: column });
    });
```

## Keyboard

| Shortcut | Action                 |
| -------- | ---------------------- |
| `⌘K`     | Command palette        |
| `⌘F`     | Focus search           |
| `⌘A`     | Toggle archived column |

## Tests

```bash
pnpm --filter @lunora-example/kanban-board test
```

Covers `midpoint` — including 200 consecutive drops into the same gap, the case
that breaks float-based ordering.
