# @cirrus/client

Framework-agnostic browser/edge client for the Cirrus framework. Talks RPC over HTTP and real-time deltas over a single multiplexed WebSocket, with optimistic updates, an offline mutation queue, and decorrelated-jitter reconnect built in.

## Install

```bash
pnpm add @cirrus/client
```

No workspace deps beyond its own internals — `@cirrus/client` is the lowest-level user-facing entry point. Framework adapters layer on top: see [`@cirrus/react`](../react).

## Usage

```ts
import { CirrusClient } from "@cirrus/client";
import { api } from "./cirrus/_generated/api.js";

const client = new CirrusClient({ url: "https://app.acme.test" });

// One-shot query (HTTP, carries x-d1-bookmark for read-your-writes).
const messages = await client.query(api.messages.list, { room: "general" });

// Mutation with an optimistic update applied to any matching subscriber.
await client.mutation(
    api.messages.send,
    { body: "hi" },
    {
        optimistic: (current = []) => [...current, { body: "hi", pending: true }],
    },
);

// Live subscription over WS — returns an unsubscribe function.
const unsubscribe = client.subscribe(api.messages.list, { room: "general" }, (next) => {
    console.log("new value", next);
});

// Tear down on app exit.
client.close();
```

## Connection lifecycle

- A WebSocket is opened lazily on the first `subscribe()`. The same socket multiplexes every subscription.
- On disconnect the client schedules a reconnect with **decorrelated jitter** (`[delay/2, delay]` from `createReconnect`), capped at `maxDelayMs` (default 30s). On successful reconnect every live subscription is re-sent and the offline queue is flushed.
- Mutations issued while disconnected are queued (only after the first successful connect — before that, mutations travel directly over HTTP so the very first call doesn't deadlock).
- `x-d1-bookmark` is captured from mutation responses and attached to subsequent queries for D1 read-your-writes consistency. Storage is pluggable via `BookmarkStorage`.

## API

| Export                                  | Description                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `new CirrusClient(opts)`                | Construct a client. `opts.url` is required; the WS URL is derived from it.   |
| `client.query(fn, args, opts?)`         | RPC. Attaches the saved D1 bookmark.                                         |
| `client.mutation(fn, args, opts?)`      | RPC with optional `optimistic` + offline queueing. Captures the new bookmark. |
| `client.action(fn, args, opts?)`        | RPC for actions (no bookmark, no optimism).                                  |
| `client.subscribe(fn, args, cb, opts?)` | Open a live subscription. Returns an `unsubscribe` function.                 |
| `client.setAuthToken(token)`            | Set the bearer token sent on every RPC.                                      |
| `client.close()`                        | Tear down the socket and clear the offline queue.                            |
| `createInMemoryBookmarkStorage()`       | Default `BookmarkStorage` implementation.                                    |
| `createReconnect(opts?)`                | Standalone reconnect calculator with decorrelated jitter.                    |
| `OfflineQueue`                          | Underlying mutation queue (exposed for tests/custom transports).             |
| `SubscriptionRegistry`                  | Internal registry — exported for adapter authors.                            |

Types: `CirrusClientOptions`, `FunctionReference`, `ArgsOf`, `ReturnOf`, `RpcEnvelope`, `RpcResponseBody`, `ClientMessage`, `ServerMessage`, `Unsubscribe`, `User`, `BookmarkStorage`, `ReconnectOptions`, `OfflineQueueOptions`.

## Constructor options

```ts
new CirrusClient({
    url: "https://app.acme.test",
    wsUrl: "wss://app.acme.test/_cirrus/ws", // optional override
    fetch: customFetch, // optional — defaults to globalThis.fetch
    WebSocket: ws, // optional — defaults to globalThis.WebSocket
    bookmarkStorage: createInMemoryBookmarkStorage(),
    reconnect: { initialDelayMs: 250, maxDelayMs: 30_000, jitter: true },
    offlineQueue: { maxSize: 100 },
});
```

## Docs

- Repo root: [README.md](../../README.md)
- Client reference: [apps/docs/content/docs/api/client.mdx](../../apps/docs/content/docs/api/client.mdx)
- Realtime concepts: [apps/docs/content/docs/concepts/realtime.mdx](../../apps/docs/content/docs/concepts/realtime.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
