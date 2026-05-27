# @cirrus-example/realtime-cursors

Live multi-user cursor sharing built on Cirrus subscriptions and the
`.shardBy()` modifier. Open the URL in two browser tabs (or two devices)
pointed at the same room and watch each other's cursors move in real time.

## What it demonstrates

- `.shardBy("roomId")` — every room lives in its own Durable Object, so
  rooms scale horizontally without any extra wiring
- Live updates via `useQuery` with the `shardKey` option pinning each
  subscription to the right shard
- Throttling write-heavy mutations on the client (~30 fps)

## Run it

```bash
pnpm install
pnpm --filter @cirrus-example/realtime-cursors dev
```

The dev server listens on <http://localhost:5174>. Append `#<room>` to the
URL to enter a different room (defaults to `lobby`).

## Key snippets

### Sharding by room (`cirrus/schema.ts`)

```ts
cursors: defineTable({
    roomId: v.string(),
    sessionId: v.string(),
    x: v.number(),
    y: v.number(),
    /* ... */
})
    .shardBy("roomId")
    .index("by_room_session", ["roomId", "sessionId"], { unique: true }),
```

### Client subscription pinned to a shard (`src/client/App.tsx`)

```tsx
const cursors = useQuery(api.cursors.listCursors, { roomId }, { shardKey: roomId });
```

`shardKey` tells the runtime which DO to route the subscription to. Pass
the same value as the field you sharded on and Cirrus opens exactly one
DO connection per room.

### Throttling pointer moves to ~30fps

```tsx
const onPointerMove = (event) => {
    const now = performance.now();
    if (now - lastSentRef.current < 1000 / 30) return;
    lastSentRef.current = now;
    void move({ roomId, sessionId, x: event.clientX, y: event.clientY });
};
```
