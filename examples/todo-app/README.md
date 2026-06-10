# @cirrus-example/todo-app

A minimal CRUD demo for Cirrus. List, create, toggle, and delete todos with
optimistic updates and live subscriptions over WebSocket.

## What it demonstrates

- `defineSchema` with a single root-scoped table and an index
- `query` + `mutation` handlers in `cirrus/todos.ts`
- The full client pipeline: `useQuery` for live data, `useMutation` with the
  `optimistic` callback for zero-latency UI
- A minimal Worker entry: `createWorker({ openApiSpec, shardDO: ... })`, where
  `openApiSpec` is imported from `cirrus/_generated/openapi` so the studio's
  API-reference tab stays in sync on every `cirrus/` change

## Run it

```bash
pnpm install
pnpm --filter @cirrus-example/todo-app dev
```

That spins up Vite + Wrangler in Miniflare; open <http://localhost:5173>.

## Key snippets

### Schema (`cirrus/schema.ts`)

```ts
export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
```

### Mutation (`cirrus/todos.ts`)

```ts
export const add = mutation({
    args: { text: v.string() },
    handler: async (ctx, { text }) => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }),
});
```

### Optimistic client update (`src/client/App.tsx`)

```tsx
const { mutate: add } = useMutation(api.todos.add);

await add(
    { text },
    {
        optimistic: (current) => {
            const list = current ?? [];
            return [{ ...provisional }, ...list];
        },
    },
);
```

If the server rejects the mutation the runtime rolls the cache back; if it
succeeds the server-side delta replaces the optimistic entry.
