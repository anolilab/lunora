import type { LifecycleEvent } from "@lunora/server";
import { definePresence, defineSchema, defineTable, presenceExtension, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

// A lifecycle hook forwards its event verbatim, so its registered handler types
// the event arg as the framework-fixed `never`. Build a shape-checked event and
// cast only at that boundary.
const lifecycleEvent = (overrides: Partial<LifecycleEvent>): never =>
    ({ connectionId: "conn-1", shardKey: "root", userId: null, ...overrides }) satisfies LifecycleEvent as never;

/**
 * End-to-end (in-memory, no workerd) proof that the presence `onDisconnect` hook
 * removes a member the instant the socket drops — the immediate-departure path,
 * not the TTL fallback. The hook runs against the harness's real `node:sqlite`
 * db through `@lunora/do`'s ctx-db, so the `byRoomSession` index lookup + delete
 * are exercised exactly as production dispatches them on `webSocketClose`.
 */
const presence = definePresence({ ttlMs: 10_000 });
const schema = defineSchema({ rooms: defineTable({ name: v.string() }) }).extend(presenceExtension);

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema);

    open.push(t);

    return t;
};

describe("presence onDisconnect (end-to-end)", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("removes the presence row immediately on disconnect, before any TTL elapses", async () => {
        expect.assertions(3);

        const t = start();

        // A live member, seeded through the public heartbeat mutation.
        await t.mutation(presence.functions.heartbeat, { roomId: "room-1", sessionId: "sess-1" });

        const before = (await t.query(presence.functions.listPresent, { roomId: "room-1" })) as unknown[];

        expect(before).toHaveLength(1);

        // What the DO dispatches on socket close: the internal disconnect hook
        // with the `{ roomId, sessionId }` context recorded at connect. Internal,
        // so it routes through `run` (the trusted server-dispatch surface).
        await t.run((context) => presence.functions.disconnect.handler(context, lifecycleEvent({ context: { roomId: "room-1", sessionId: "sess-1" } })));

        // Gone now — no clock advanced, so this is the immediate delete, not the
        // TTL aging the row out.
        const after = (await t.query(presence.functions.listPresent, { roomId: "room-1" })) as unknown[];

        expect(after).toHaveLength(0);

        // A second member in the same room is untouched: the hook targets exactly
        // the disconnecting `(roomId, sessionId)`.
        await t.mutation(presence.functions.heartbeat, { roomId: "room-1", sessionId: "sess-2" });
        await t.run((context) =>
            presence.functions.disconnect.handler(context, lifecycleEvent({ connectionId: "conn-2", context: { roomId: "room-1", sessionId: "sess-1" } })),
        );

        const survivors = (await t.query(presence.functions.listPresent, { roomId: "room-1" })) as unknown[];

        expect(survivors).toHaveLength(1);
    });
});
