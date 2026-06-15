# presence

Collaborative-awareness presence for Lunora — the "who's here" + cursors primitive (Convex [`@convex-dev/presence`](https://www.npmjs.com/package/@convex-dev/presence) parity). A room (a document, board, or channel) and the set of users/sessions currently looking at it, each carrying an optional awareness `data` blob (cursor, selection, name, color…).

Built entirely from primitives Lunora already has — a live-query table plus a read-time TTL filter — so there's no new package and no Durable-Object-level support to enable.

## Install

```bash
lunora registry add presence
```

This:

1. Adds `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/presence/schema.ts` (the `present` table + the plugin) and `lunora/presence/index.ts` (the `heartbeat` / `listPresent` / `sweep` functions) into your project — these are **yours** to edit.
3. Splices a managed `.extend(presence.extension)` into `lunora/schema.ts`, merging the `present` table in as **`presence_present`** (extension tables are auto-prefixed with the plugin key).

Then regenerate types:

```bash
lunora codegen
```

The functions surface in the generated `api` as `presence/heartbeat`, `presence/listPresent`, and `presence/sweep` — i.e. `api.presence.heartbeat` and friends.

## How it works

- **heartbeat** (mutation) upserts the caller's row for `(roomId, sessionId)` and stamps `lastSeen = now`. Re-heartbeats _patch_ the existing row, so subscribers receive a single-row delta rather than an insert/delete churn.
- **listPresent** (query) returns the non-expired members of a room, newest first. It filters `lastSeen > now - PRESENCE_TTL_MS` at read time, so a client that stops heart-beating silently drops out — **no reaper needed**.
- **sweep** (internal mutation) hard-deletes expired rows to reclaim storage. It's _internal_ (server-only) so clients can't trigger bulk deletes; wire it to a cron or `runAfter` if your tables grow.

Tune the time-to-live by editing `PRESENCE_TTL_MS` in `lunora/presence/schema.ts` (default 30s). Keep your client heartbeat cadence well under it.

## Use it from React

The client half ships in `@lunora/react` as the `usePresence` hook — it calls `heartbeat` on an interval (and on tab-visibility changes) and subscribes to `listPresent`:

```tsx
import { usePresence } from "@lunora/react";

import { api } from "../lunora/_generated/api";

function Room({ roomId }: { roomId: string }) {
    const { present, setData } = usePresence(roomId, {
        heartbeat: api.presence.heartbeat,
        listPresent: api.presence.listPresent,
        data: { name: "Ada", color: "#7c3aed" },
    });

    return (
        <ul>
            {present?.map((m) => (
                <li key={m.sessionId} style={{ color: (m.data?.color as string) ?? "inherit" }}>
                    {(m.data?.name as string) ?? m.sessionId}
                </li>
            ))}
        </ul>
    );
}
```

`setData(next)` replaces the awareness blob sent with subsequent heartbeats (and heartbeats once immediately) — use it to publish a moving cursor or a changed selection. `sessionId` defaults to one row per tab; pass your own to dedupe across tabs by user.

## Sweep on a schedule (optional)

`listPresent` never returns stale rows, so sweeping is purely about reclaiming storage. To run it, schedule the internal mutation from a cron:

```ts
// lunora/crons.ts
import { cronJobs } from "@lunora/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep presence", { minutes: 5 }, internal.presence.sweep, { roomId: "lobby" });

export default crons;
```

## What you own

Everything under `lunora/presence/` is copied into your repo — change the TTL, the table columns (add a `name`/`color` column instead of stuffing them in `data`), the sort order, or the functions however you like. This component is the idiomatic Lunora glue; once added, it's just your code.
