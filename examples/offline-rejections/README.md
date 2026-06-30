# @lunora-example/offline-rejections

A focused demo of **how Lunora surfaces a rejected offline write to the UI** — so
a rolled-back optimistic row never just silently vanishes (which users read as
data loss).

Optimistic + server-authoritative is clean until a queued write is _rejected_ on
flush: the optimistic row rolls back, and if the original `mutation()` Promise is
gone (you reloaded, or it was a fire-and-forget call) there's nothing left to
catch. This example wires the two channels that cover every case.

## The two channels

| Channel                    | Fires when                                                                                                                                             | Misses                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| awaited `mutate()` Promise | the caller is still awaiting — i.e. an **online** rejection                                                                                            | post-reload replays (no awaiter), fire-and-forget calls     |
| `client.onMutationSettled` | **every** queued write settles (`committed`/`rejected`), incl. post-reload replays (`hadAwaiter: false`), overflow evictions, identity-change discards | online writes that never queued (use the Promise for those) |

The UI shows both side by side so you can see which channel catches what.

> Using the [`@lunora/db`](../../packages/db) TanStack-DB collection layer instead
> of the raw client? It exposes the same idea as `defineCollections(client, defs,
{ onWriteRejected })`.

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/offline-rejections dev
```

Vite + Wrangler in Miniflare; open <http://localhost:5173>.

## Try it

### 1. Online rejection (the Promise channel)

Type a message containing the word **`fail`** and hit Send. The server throws a
coded `CONFLICT` (`lunora/messages.ts`), so:

- the optimistic row appears, then rolls back, and
- the rejection shows up under **awaited `mutate()` Promise** (the live channel).

`onMutationSettled` does **not** fire here — the write never queued.

### 2. Offline + reload rejection (the durable channel — the whole point)

1. Open DevTools → Network → set throttling to **Offline** (the status pill flips
   away from `connected`).
2. Send a message containing **`fail`**. It's queued (and persisted to IndexedDB);
   the optimistic row shows.
3. **Reload the page** while still offline. The original Promise is now gone, but
   the write is still in the durable outbox.
4. Set the network back to **Online**.

The client hydrates the queued write, replays it, the server rejects it — and the
only thing that reports it is **`onMutationSettled`**, with `hadAwaiter: false`.
That's the case a `try/catch` around `await send(...)` fundamentally cannot catch.

## Key snippets

### Deterministic server rejection (`lunora/messages.ts`)

```ts
export const send = mutation.input({ text: v.string(), author: v.string() }).mutation(async ({ args: { text, author }, ctx }) => {
    const trimmed = text.trim();
    if (trimmed === "") {
        throw new LunoraError("BAD_REQUEST", "message text cannot be empty");
    }
    if (/\bfail\b/i.test(trimmed)) {
        throw new LunoraError("CONFLICT", `the server refused to save "${trimmed}"`);
    }
    return ctx.db.insert("messages", { text: trimmed, author, createdAt: Date.now() });
});
```

### Durable persistence so writes survive a reload (`src/client/main.tsx`)

```ts
const client = new LunoraClient({ url, persistence: createIndexedDbPersistence() });
```

### Surfacing the verdict (`src/client/App.tsx`)

```tsx
useEffect(
    () =>
        client.onMutationSettled((event) => {
            if (event.status === "rejected") {
                // event.code, event.hadAwaiter, event.functionPath, event.args …
                showToast(event);
            }
        }),
    [client],
);
```
