# @lunora-example/todo-app

A minimal CRUD demo for Lunora. List, create, toggle, and delete todos with
optimistic updates and live subscriptions over WebSocket.

## What it demonstrates

- `defineSchema` with a single root-scoped table and an index
- `query` + `mutation` handlers in `lunora/todos.ts`
- The full client pipeline: `useQuery` for live data, `useMutation` with the
  `optimistic` callback for zero-latency UI
- A minimal Worker entry: `createWorker({ openApiSpec, shardDO: ... })`, where
  `openApiSpec` is imported from `lunora/_generated/openapi` so the studio's
  API-reference tab stays in sync on every `lunora/` change

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/todo-app dev
```

That spins up Vite + Wrangler in Miniflare; open <http://localhost:5173>.

## Key snippets

### Schema (`lunora/schema.ts`)

```ts
export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
```

### Mutation (`lunora/todos.ts`)

```ts
export const add = mutation
    .input({ text: v.string() })
    .mutation(async ({ args: { text }, ctx }) => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }));
```

### Optimistic client update (`src/client/App.tsx`)

```tsx
const { mutate: add } = useMutation(api.todos.add);

await add(
    { text },
    {
        optimisticUpdate: (store) => {
            const list = store.getQuery(api.todos.list, {}) ?? [];
            store.setQuery(api.todos.list, {}, [{ ...provisional }, ...list]);
        },
    },
);
```

`optimisticUpdate` names the query the write affects — `todos.add` and
`todos.list` are different functions, so nothing can infer the link. (The
per-call `optimistic: (current) => next` shortcut patches only a subscription
registered under the mutation's own reference and args.)

If the server rejects the mutation the runtime rolls the cache back; if it
succeeds the server-side delta replaces the optimistic entry.
