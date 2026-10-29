# presence

Collaborative-awareness presence for Lunora — the "who's here" + cursors primitive (Convex [`@convex-dev/presence`](https://www.npmjs.com/package/@convex-dev/presence) parity). A room (a document, board, or channel) and the set of users/sessions currently looking at it, each carrying an optional awareness `data` blob (cursor, selection, name, color…).

Built entirely from primitives Lunora already has — a live-query table, a read-time TTL filter and a table `.ttl()` — so there's no new package to install.

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

- **heartbeat** (mutation) upserts the caller's row for `(tenant, roomId, sessionId)` and stamps `lastSeen = now`. Re-heartbeats _patch_ the existing row, so subscribers receive a single-row delta rather than an insert/delete churn.
- **listPresent** (query) returns the non-expired members of the caller's room, newest first. It filters `lastSeen > now - PRESENCE_TTL_MS` at read time, so a client that stops heart-beating silently drops out — **no reaper needed**.
- **sweep** (internal mutation) hard-deletes expired rows to reclaim storage. It's _internal_ (server-only) so clients can't trigger bulk deletes; the table's `.ttl()` already deletes expired rows in every shard, so it is an on-demand pass (see [Expired rows](#expired-rows)).

## Rooms are scoped to the caller's tenant

A client names only the room. The server files it under the tenant it derives from the caller's verified identity (`presenceTenant` in `lunora/presence/index.ts`), so `roomId: "lobby"` in organization A and in organization B are two separate rooms, and no argument reaches another tenant's. The tenant is stored in its own `tenantId` column and never returned to clients.

The tenant is the identity's `orgId` claim — the one the `auth-auth0-jwt`, `auth-clerk-jwt` and `auth-workos-jwt` presets emit. Callers without one (anonymous, or an app with no organizations) share the app-wide tenant `""`, which is right for a single-tenant app and holds no organization's rooms.

With `@lunora/auth`, the built-in identity carries `orgId` whenever the organization plugin is on: the caller's active organization, emitted only while their membership still exists. A removal can lag by up to the identity cache window (60 s by default; immediate with the `strict` preset), and an open subscription keeps the claim it connected with until it reconnects, so a removed member can stay in a room's member list until then. A `resolveIdentity` of your own replaces the built-in one, so forward the membership-checked organization as `orgId` from it.

To scope by something else (a team, a workspace), change `presenceTenant` — it is the one place the policy lives. Read the tenant from the identity, never from `args`: a tenant the client chooses is no boundary.

Tune the time-to-live by editing `PRESENCE_TTL_MS` in `lunora/presence/schema.ts` (default 30s), and the `.ttl()` `after` beside it to match. Keep your client heartbeat cadence well under it.

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

## Expired rows

`listPresent` never returns stale rows, so deleting them is purely about reclaiming storage, and the table does it on its own: `.ttl("lastSeen", { after: 30_000 })` in `lunora/presence/schema.ts` has every Durable Object's alarm delete its own expired rows. That matters in a sharded app — an organization's rooms live in its own shard, and nothing else reaches all of them. Keep that `after` equal to `PRESENCE_TTL_MS` when you change the TTL; codegen reads the literal, not the constant.

The internal `sweep` mutation is an on-demand pass over **the shard it runs on**. Without arguments it deletes up to 500 expired rows across every tenant in that shard; with a `roomId` alone, up to 500 of that room's in every tenant (the shape crons written before rooms were tenant-scoped pass, so they keep working); with both `tenantId` (`""` for the app-wide tenant) and `roomId`, that one room's. A `tenantId` without a `roomId` is refused. A cron dispatches to the root shard, so a scheduled `sweep` cleans only rooms that live there:

```ts
// lunora/crons.ts
import { cronJobs } from "@lunora/server";

import { internal } from "./_generated/internal";

const crons = cronJobs();

crons.interval("sweep presence", { minutes: 5 }, internal.presence.sweep, {});

export default crons;
```

### Upgrading from untenanted rooms

Rows written before rooms were tenant-scoped have no `tenantId` — which is why the column is optional. Every heartbeat, `listPresent` and join-time cleanup looks rows up by tenant, so those rows are invisible to them: members re-appear with their next heartbeat as new rows, and the old ones sit in storage. The table's `.ttl()` alarm deletes them once they are past the TTL, in every shard.

The deploy's schema-drift gate reports two breaking changes for this upgrade. The `byRoomSession` index is replaced by `byTenantRoomSession`, and the gate cannot know that the only query using it was this item's own code, which the upgrade also replaced. The new `.ttl()` deletes every row already past the cutoff on its first alarm, which for presence only enforces the expiry `listPresent` already applies at read time — so there is nothing to back-fill. Accept the new shape once: `lunora prepare --update-schema-baseline`, or `--allow-schema-drift` on that one `lunora deploy`.

## What you own

Everything under `lunora/presence/` is copied into your repo — change the TTL, the tenant policy, the table columns (add a `name`/`color` column instead of stuffing them in `data`), the sort order, or the functions however you like. This component is the idiomatic Lunora glue; once added, it's just your code.
