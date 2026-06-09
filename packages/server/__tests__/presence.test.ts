import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "../src/index";
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
        expect(present[0]?.sessionId).toBe("fresh");
        expect(present[0]?.userId).toBe("new");
    });

    it("listPresent scopes results to the requested room", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db), { roomId: "room-1", sessionId: "a" });
        await presence.functions.heartbeat.handler(makeMutationContext(db), { roomId: "room-2", sessionId: "b" });

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(1);
        expect(present[0]?.sessionId).toBe("a");
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
