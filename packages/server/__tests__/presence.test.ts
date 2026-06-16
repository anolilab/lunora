import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LifecycleEvent, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../src/index";
import { v } from "../src/index";
import { definePresence, PRESENCE_TABLE, presenceExtension } from "../src/presence";
import { defineSchema, defineTable } from "../src/schema";

/**
 * Minimal in-memory `db` matching the slice of `DatabaseWriter` the presence
 * handlers use: `query(table).withIndex(...).filter(...).first()/collect()`,
 * `insert`, `patch`, `delete`. Index args are ignored — the predicates the
 * handlers build via `q.eq(...)` are emulated by full-scan + the same eq logic,
 * which is faithful for the tiny presence row set under test.
 */
interface Eq {
    field: string;
    value: unknown;
}

type Predicate = (row: Record<string, unknown>) => boolean;

const matchesEq = (row: Record<string, unknown>, eq: Eq): boolean => row[eq.field] === eq.value;

const resolveRows = (rows: Map<string, Record<string, unknown>>, table: string, eqs: Eq[], predicates: Predicate[]): Record<string, unknown>[] =>
    [...rows.values()].filter(
        (row) => (row["__table"] as string) === table && eqs.every((eq) => matchesEq(row, eq)) && predicates.every((predicate) => predicate(row)),
    );

const createMemoryDb = (): MutationContext["db"] => {
    const rows = new Map<string, Record<string, unknown>>();
    let nextId = 1;

    const makeReader = (table: string) => {
        const eqs: Eq[] = [];
        const predicates: Predicate[] = [];

        const reader = {
            collect: async () => resolveRows(rows, table, eqs, predicates),
            filter(predicate: Predicate) {
                predicates.push(predicate);

                return reader;
            },
            first: async () => resolveRows(rows, table, eqs, predicates)[0] ?? null,
            withIndex(_name: string, range?: (q: unknown) => unknown) {
                const builder = {
                    eq(field: string, value: unknown) {
                        eqs.push({ field, value });

                        return builder;
                    },
                };

                range?.(builder);

                return reader;
            },
        };

        return reader;
    };

    return {
        delete: async (id: string) => {
            rows.delete(id);
        },
        insert: async (table: string, document: Record<string, unknown>) => {
            const id = `${table}|${String(nextId)}`;

            nextId += 1;
            rows.set(id, { ...document, __table: table, _creationTime: Date.now(), _id: id });

            return id;
        },
        patch: async (id: string, patch: Record<string, unknown>) => {
            const existing = rows.get(id);

            if (existing) {
                rows.set(id, { ...existing, ...patch });
            }
        },
        query: (table: string) => makeReader(table),
    } as unknown as MutationContext["db"];
};

const makeMutationContext = (db: MutationContext["db"], userId: string | null = null): MutationContext =>
    ({
        auth: { getIdentity: async () => null, userId },
        db,
        runMutation: vi.fn<MutationContext["runMutation"]>(),
        runQuery: vi.fn<MutationContext["runQuery"]>(),
        scheduler: {} as MutationContext["scheduler"],
        storage: {} as MutationContext["storage"],
        vectors: {} as MutationContext["vectors"],
    }) as unknown as MutationContext;

const makeQueryContext = (db: MutationContext["db"]): QueryContext =>
    ({
        auth: { getIdentity: async () => null, userId: null },
        db: db as unknown as QueryContext["db"],
        runQuery: vi.fn<QueryContext["runQuery"]>(),
        storage: {} as QueryContext["storage"],
        vectors: {} as QueryContext["vectors"],
    }) as unknown as QueryContext;

// A lifecycle hook forwards its event verbatim, so its registered handler types
// the event arg as the framework-fixed `never`. Build a shape-checked event and
// cast only at that boundary.
const lifecycleEvent = (overrides: Partial<LifecycleEvent>): never =>
    ({ connectionId: "conn-1", shardKey: "root", userId: null, ...overrides }) satisfies LifecycleEvent as never;

describe("definePresence", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("heartbeat inserts a presence row, then patches it on re-heartbeat (upsert)", async () => {
        expect.assertions(4);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        const insertSpy = vi.spyOn(db, "insert");
        const patchSpy = vi.spyOn(db, "patch");

        vi.setSystemTime(1000);
        const first = await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), {
            data: { color: "red" },
            roomId: "room-1",
            sessionId: "sess-1",
        });

        expect(first.lastSeen).toBe(1000);
        expect(insertSpy).toHaveBeenCalledTimes(1);

        // Same (roomId, sessionId) re-heartbeats → patch, not a second insert.
        vi.setSystemTime(2000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), {
            roomId: "room-1",
            sessionId: "sess-1",
        });

        expect(insertSpy).toHaveBeenCalledTimes(1);
        expect(patchSpy).toHaveBeenCalledTimes(1);
    });

    it("listPresent includes fresh members and excludes ones older than the ttl", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        // Stale member — heartbeats at t=0.
        vi.setSystemTime(0);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "old"), { roomId: "room-1", sessionId: "stale" });

        // Fresh member — heartbeats at t=15_000 (within ttl of "now").
        vi.setSystemTime(15_000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "new"), { roomId: "room-1", sessionId: "fresh" });

        // Now = 20_000 → cutoff = 10_000. "stale" (lastSeen 0) is out; "fresh" (15_000) is in.
        vi.setSystemTime(20_000);
        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(1);
        // `sessionId` is intentionally omitted from the public payload (it's a
        // connection secret); the member is identified by `userId`.
        expect(present[0]).not.toHaveProperty("sessionId");
        expect(present[0]?.userId).toBe("new");
    });

    it("listPresent scopes results to the requested room", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-a"), { roomId: "room-1", sessionId: "a" });
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-b"), { roomId: "room-2", sessionId: "b" });

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(1);
        expect(present[0]?.userId).toBe("user-a");
    });

    it("sweep hard-deletes only expired rows", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(0);
        await presence.functions.heartbeat.handler(makeMutationContext(db), { roomId: "room-1", sessionId: "stale" });
        vi.setSystemTime(15_000);
        await presence.functions.heartbeat.handler(makeMutationContext(db), { roomId: "room-1", sessionId: "fresh" });

        vi.setSystemTime(20_000);
        const result = await presence.functions.sweep.handler(makeMutationContext(db), { roomId: "room-1" });

        expect(result.deleted).toBe(1);

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(1);
    });

    it("sweep is registered as an internal mutation", () => {
        expect.assertions(2);

        const presence = definePresence();

        expect(presence.functions.sweep.kind).toBe("mutation");
        expect((presence.functions.sweep as { visibility?: string }).visibility).toBe("internal");
    });

    it("disconnect is registered as a `disconnect` lifecycle hook", () => {
        expect.assertions(3);

        const presence = definePresence();

        expect(presence.functions.disconnect.kind).toBe("mutation");
        expect(presence.functions.disconnect.visibility).toBe("internal");
        expect(presence.functions.disconnect.lifecycle).toBe("disconnect");
    });

    it("disconnect hard-deletes the row matching the connection context immediately", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        // A fresh member that the TTL filter would otherwise keep "present".
        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), { roomId: "room-1", sessionId: "sess-1" });

        // Socket drops: the hook fires with the client-stamped context, deleting now.
        await presence.functions.disconnect.handler(
            makeMutationContext(db, "user-1"),
            lifecycleEvent({ context: { roomId: "room-1", sessionId: "sess-1" }, userId: "user-1" }),
        );

        // Same instant — no TTL elapsed — and the member is already gone.
        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(0);

        // Only the targeted (roomId, sessionId) row is removed.
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-2"), { roomId: "room-1", sessionId: "sess-2" });
        await presence.functions.disconnect.handler(
            makeMutationContext(db, "user-1"),
            lifecycleEvent({ connectionId: "conn-2", context: { roomId: "room-1", sessionId: "sess-1" }, userId: "user-1" }),
        );

        const remaining = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(remaining).toHaveLength(1);
    });

    it("disconnect is a no-op when the context lacks roomId/sessionId", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), { roomId: "room-1", sessionId: "sess-1" });

        const deleteSpy = vi.spyOn(db, "delete");

        // No context at all — nothing to target, so the row survives for TTL/sweep.
        await presence.functions.disconnect.handler(makeMutationContext(db, "user-1"), lifecycleEvent({ userId: "user-1" }));

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("heartbeat refuses to overwrite a row owned by a different identity", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "victim"), { data: { color: "blue" }, roomId: "room-1", sessionId: "sess-1" });

        // Attacker heartbeats the victim's observable (roomId, sessionId).
        await expect(
            presence.functions.heartbeat.handler(makeMutationContext(db, "attacker"), { data: { color: "red" }, roomId: "room-1", sessionId: "sess-1" }),
        ).rejects.toThrow(/denied/u);

        // The victim's awareness data is untouched.
        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present[0]?.data).toEqual({ color: "blue" });
    });

    it("heartbeat rejects an oversized data blob", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);

        await expect(
            presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), {
                data: { blob: "x".repeat(5000) },
                roomId: "room-1",
                sessionId: "sess-1",
            }),
        ).rejects.toThrow(/limit/u);
    });

    it("disconnect does not evict a row owned by a different identity", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "victim"), { roomId: "room-1", sessionId: "sess-1" });

        // Attacker closes a socket carrying the victim's (roomId, sessionId) but
        // its own verified identity — the row must NOT be deleted.
        await presence.functions.disconnect.handler(
            makeMutationContext(db, "attacker"),
            lifecycleEvent({ context: { roomId: "room-1", sessionId: "sess-1" }, userId: "attacker" }),
        );

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(1);
    });
});

describe("presenceExtension", () => {
    it("namespaces the presence table under the `presence` key when merged", () => {
        expect.assertions(3);

        const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(presenceExtension);

        expect(schema.tables).toHaveProperty(PRESENCE_TABLE);
        expect(PRESENCE_TABLE).toBe("presence_present");
        // The bare name never leaks into the merged schema.
        expect(schema.tables).not.toHaveProperty("present");
    });

    it("declares the (roomId, sessionId) and roomId indexes on the table", () => {
        expect.assertions(2);

        const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(presenceExtension);
        const indexNames = schema.tables[PRESENCE_TABLE]?.indexes.map((index) => index.name);

        expect(indexNames).toContain("byRoomSession");
        expect(indexNames).toContain("byRoom");
    });
});
