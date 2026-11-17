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
        let direction: "asc" | "desc" | undefined;

        // The only ordered reads the presence handlers issue go through the
        // `byTenantRoomLastSeen` index with `tenantId` + `roomId` eq-fixed, so ordering by
        // `lastSeen` emulates the index order faithfully.
        const sorted = (): Record<string, unknown>[] => {
            const resolved = resolveRows(rows, table, eqs, predicates);

            if (direction === undefined) {
                return resolved;
            }

            return resolved.toSorted((a, b) =>
                direction === "asc" ? (a["lastSeen"] as number) - (b["lastSeen"] as number) : (b["lastSeen"] as number) - (a["lastSeen"] as number),
            );
        };

        const reader = {
            collect: async () => sorted(),
            filter(predicate: Predicate) {
                predicates.push(predicate);

                return reader;
            },
            first: async () => sorted()[0] ?? null,
            order(requested: "asc" | "desc") {
                direction = requested;

                return reader;
            },
            take: async (limit: number) => sorted().slice(0, limit),
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
        delete: async (_table: string, id: string) => {
            rows.delete(id);
        },
        insert: async (table: string, document: Record<string, unknown>) => {
            const id = `${table}|${String(nextId)}`;

            nextId += 1;
            rows.set(id, { ...document, __table: table, _creationTime: Date.now(), _id: id });

            return id;
        },
        patch: async (_table: string, id: string, patch: Record<string, unknown>) => {
            const existing = rows.get(id);

            if (existing) {
                rows.set(id, { ...existing, ...patch });
            }
        },
        query: (table: string) => makeReader(table),
    } as unknown as MutationContext["db"];
};

/** The verified identity claims a context carries; `orgId` picks the presence tenant. */
type Claims = Record<string, unknown> | null;

const makeMutationContext = (db: MutationContext["db"], userId: string | null = null, claims: Claims = null): MutationContext =>
    ({
        auth: { getIdentity: async () => claims, userId },
        db,
        runMutation: vi.fn<MutationContext["runMutation"]>(),
        runQuery: vi.fn<MutationContext["runQuery"]>(),
        scheduler: {} as MutationContext["scheduler"],
        storage: {} as MutationContext["storage"],
        vectors: {} as MutationContext["vectors"],
    }) as unknown as MutationContext;

const makeQueryContext = (db: MutationContext["db"], claims: Claims = null): QueryContext =>
    ({
        auth: { getIdentity: async () => claims, userId: null },
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

    it("listPresent caps the read at maxSessions, keeping the newest heartbeats", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ maxSessions: 3, ttlMs: 10_000 });

        // Five distinct anonymous sessions (no userId, so no dedup), each with
        // a fresher heartbeat than the last.
        for (let index = 0; index < 5; index += 1) {
            vi.setSystemTime(1000 + index * 100);
            // eslint-disable-next-line no-await-in-loop -- sequential heartbeats are the point
            await presence.functions.heartbeat.handler(makeMutationContext(db), { roomId: "room-1", sessionId: `sess-${String(index)}` });
        }

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(3);
        // Newest-first and truncated from the oldest end: 1400, 1300, 1200.
        expect(present.map((member) => member.lastSeen)).toEqual([1400, 1300, 1200]);
    });

    it("counts maxSessions in session rows, so one user's tabs consume several", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ maxSessions: 2, ttlMs: 10_000 });

        // "multi" has two tabs (two rows) and heartbeats last, so it fills the
        // whole cap and "solo" — equally live — falls off the bottom. This is
        // why the option is named for sessions: sizing it by head count would
        // drop currently-heartbeating members from "who's here".
        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "solo"), { roomId: "room-1", sessionId: "solo-1" });
        vi.setSystemTime(2000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "multi"), { roomId: "room-1", sessionId: "multi-1" });
        vi.setSystemTime(3000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "multi"), { roomId: "room-1", sessionId: "multi-2" });

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present.map((member) => member.userId)).toEqual(["multi"]);

        // Raising the cap past the session count restores the dropped member.
        const roomy = definePresence({ maxSessions: 3, ttlMs: 10_000 });
        const all = await roomy.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(all.map((member) => member.userId)).toEqual(["multi", "solo"]);
    });

    it("falls back to the default cap for a non-finite maxSessions", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        // `Math.max(1, Math.floor(NaN))` is NaN, which would reach the reader
        // as `LIMIT NaN` and return nothing.
        const presence = definePresence({ maxSessions: Number.NaN, ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), { roomId: "room-1", sessionId: "sess-1" });

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present.map((member) => member.userId)).toEqual(["user-1"]);
    });

    it("heartbeat reaps long-expired rows but never one inside the grace window", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const deleteSpy = vi.spyOn(db, "delete");
        const presence = definePresence({ disconnectGraceMs: 5000, ttlMs: 10_000 });

        // A row that will age far past every cutoff.
        vi.setSystemTime(0);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "old"), { roomId: "room-1", sessionId: "ancient" });

        // A gracefully-closed session: aged, but revivable within the grace window.
        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "graced"), { roomId: "room-1", sessionId: "graced" });
        await presence.functions.disconnect.handler(
            makeMutationContext(db, "graced"),
            lifecycleEvent({ context: { roomId: "room-1", sessionId: "graced" }, userId: "graced" }),
        );

        // At t=2_000 the reap cutoff is 2_000 - 10_000 - 10_000 = -18_000:
        // neither "ancient" (lastSeen 0) nor the aged "graced" row (lastSeen
        // -4_000) is old enough — a graced reconnect must keep working.
        vi.setSystemTime(2000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "beater"), { roomId: "room-1", sessionId: "beater" });

        expect(deleteSpy).not.toHaveBeenCalled();

        // At t=50_000 the cutoff is 30_000: both aged-out rows are reclaimed by
        // the next heartbeat, no sweep scheduled.
        vi.setSystemTime(50_000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "beater"), { roomId: "room-1", sessionId: "beater" });

        expect(deleteSpy).toHaveBeenCalledTimes(2);

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present.map((member) => member.userId)).toEqual(["beater"]);
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
        const result = await presence.functions.sweep.handler(makeMutationContext(db), { roomId: "room-1", tenantId: "" });

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

    it("listPresent collapses multiple sessions of the same user to one member (newest wins)", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        // Same user, two tabs: distinct sessionIds, distinct rows.
        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), { data: { tab: "a" }, roomId: "room-1", sessionId: "tab-a" });

        vi.setSystemTime(3000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), { data: { tab: "b" }, roomId: "room-1", sessionId: "tab-b" });

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        // One member for the user, carrying the most-recent heartbeat's data.
        expect(present).toHaveLength(1);
        expect(present[0]?.userId).toBe("user-1");
        expect(present[0]?.data).toEqual({ tab: "b" });
    });

    it("listPresent keeps anonymous sessions distinct (no userId to dedup on)", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db), { roomId: "room-1", sessionId: "anon-1" });
        await presence.functions.heartbeat.handler(makeMutationContext(db), { roomId: "room-1", sessionId: "anon-2" });

        const present = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(present).toHaveLength(2);
    });

    it("disconnect with a grace window ages the row out instead of deleting it", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const presence = definePresence({ disconnectGraceMs: 2000, ttlMs: 10_000 });

        const deleteSpy = vi.spyOn(db, "delete");

        vi.setSystemTime(1000);
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), { roomId: "room-1", sessionId: "sess-1" });

        // Socket drops at t=1000 with a 2s grace: the row is patched, not deleted.
        await presence.functions.disconnect.handler(
            makeMutationContext(db, "user-1"),
            lifecycleEvent({ context: { roomId: "room-1", sessionId: "sess-1" }, userId: "user-1" }),
        );

        expect(deleteSpy).not.toHaveBeenCalled();

        // Within the grace window (t=2000 < 1000+2000): still present.
        vi.setSystemTime(2000);
        const during = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(during).toHaveLength(1);

        // Past the grace window (t=3500 > 1000+2000): the TTL filter hides it.
        vi.setSystemTime(3500);
        const after = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "room-1" });

        expect(after).toHaveLength(0);
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

    it("heartbeat measures the data cap in UTF-8 bytes, not UTF-16 code units", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        vi.setSystemTime(1000);

        // 2000 CJK chars: 2000 UTF-16 code units (well under the 4096 cap by the
        // old `.length` check) but ~6000 UTF-8 bytes (over it). The byte-based
        // cap must reject this; a code-unit cap would have let it through.
        const multibyte = "中".repeat(2000);

        expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(4096);

        await expect(
            presence.functions.heartbeat.handler(makeMutationContext(db, "user-1"), {
                data: { blob: multibyte },
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

describe("definePresence tenant isolation", () => {
    const orgA = { orgId: "org-a" };
    const orgB = { orgId: "org-b" };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("files the same room name under two organizations as two rooms", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        await presence.functions.heartbeat.handler(makeMutationContext(db, "alice", orgA), { roomId: "doc-1", sessionId: "s-a" });
        await presence.functions.heartbeat.handler(makeMutationContext(db, "bob", orgB), { roomId: "doc-1", sessionId: "s-b" });

        const inA = await presence.functions.listPresent.handler(makeQueryContext(db, orgA), { roomId: "doc-1" });
        const inB = await presence.functions.listPresent.handler(makeQueryContext(db, orgB), { roomId: "doc-1" });
        const appWide = await presence.functions.listPresent.handler(makeQueryContext(db), { roomId: "doc-1" });

        expect(inA.map((member) => member.userId)).toStrictEqual(["alice"]);
        expect(inB.map((member) => member.userId)).toStrictEqual(["bob"]);
        // No orgId claim is the app-wide tenant, which holds no organization's rooms.
        expect(appWide).toStrictEqual([]);
    });

    it("never lets a heartbeat reach another organization's row with the same room and session", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });
        const insertSpy = vi.spyOn(db, "insert");
        const patchSpy = vi.spyOn(db, "patch");

        await presence.functions.heartbeat.handler(makeMutationContext(db, "alice", orgA), { data: { color: "blue" }, roomId: "doc-1", sessionId: "s-1" });

        // Org B reuses org A's exact (roomId, sessionId): it lands in its own
        // tenant as a fresh row — neither refused as a hijack nor patching A's.
        await presence.functions.heartbeat.handler(makeMutationContext(db, "mallory", orgB), { data: { color: "red" }, roomId: "doc-1", sessionId: "s-1" });

        expect(insertSpy).toHaveBeenCalledTimes(2);
        expect(patchSpy).not.toHaveBeenCalled();

        const inA = await presence.functions.listPresent.handler(makeQueryContext(db, orgA), { roomId: "doc-1" });

        expect(inA).toEqual([{ data: { color: "blue" }, lastSeen: 1000, roomId: "doc-1", userId: "alice" }]);
    });

    it("never reaps another organization's expired rows from a heartbeat", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        await presence.functions.heartbeat.handler(makeMutationContext(db, "alice", orgA), { roomId: "doc-1", sessionId: "s-a" });

        // Far past every reap cutoff for org A's row.
        vi.setSystemTime(100_000);

        const deleteSpy = vi.spyOn(db, "delete");

        await presence.functions.heartbeat.handler(makeMutationContext(db, "bob", orgB), { roomId: "doc-1", sessionId: "s-b" });

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("scopes the disconnect cleanup to the socket's own organization", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        // Same user id in both orgs, so the ownership gate alone would let it through.
        await presence.functions.heartbeat.handler(makeMutationContext(db, "user-1", orgA), { roomId: "doc-1", sessionId: "s-1" });

        const deleteSpy = vi.spyOn(db, "delete");

        await presence.functions.disconnect.handler(
            makeMutationContext(db, "user-1", orgB),
            lifecycleEvent({ context: { roomId: "doc-1", sessionId: "s-1" }, userId: "user-1" }),
        );

        expect(deleteSpy).not.toHaveBeenCalled();

        await presence.functions.disconnect.handler(
            makeMutationContext(db, "user-1", orgA),
            lifecycleEvent({ context: { roomId: "doc-1", sessionId: "s-1" }, userId: "user-1" }),
        );

        expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    it("sweeps only the named tenant's room", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ ttlMs: 10_000 });

        await presence.functions.heartbeat.handler(makeMutationContext(db, "alice", orgA), { roomId: "doc-1", sessionId: "s-a" });
        await presence.functions.heartbeat.handler(makeMutationContext(db, "bob", orgB), { roomId: "doc-1", sessionId: "s-b" });

        vi.setSystemTime(20_000);

        const result = await presence.functions.sweep.handler(makeMutationContext(db), { roomId: "doc-1", tenantId: "org-a" });

        expect(result.deleted).toBe(1);

        // Org B's stale row is still there for its own sweep to reclaim.
        const leftForB = await presence.functions.sweep.handler(makeMutationContext(db), { roomId: "doc-1", tenantId: "org-b" });

        expect(leftForB.deleted).toBe(1);
    });

    it("takes the tenant from the `tenant` option when one is given", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const presence = definePresence({ tenant: (identity) => (typeof identity?.["teamId"] === "string" ? identity["teamId"] : ""), ttlMs: 10_000 });

        await presence.functions.heartbeat.handler(makeMutationContext(db, "alice", { orgId: "org-a", teamId: "team-1" }), {
            roomId: "doc-1",
            sessionId: "s-a",
        });

        const sameTeam = await presence.functions.listPresent.handler(makeQueryContext(db, { orgId: "org-b", teamId: "team-1" }), { roomId: "doc-1" });
        const sameOrg = await presence.functions.listPresent.handler(makeQueryContext(db, { orgId: "org-a", teamId: "team-2" }), { roomId: "doc-1" });

        expect(sameTeam.map((member) => member.userId)).toStrictEqual(["alice"]);
        expect(sameOrg).toStrictEqual([]);
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

    it("declares the tenant-led (tenantId, roomId, sessionId) and (tenantId, roomId, lastSeen) indexes", () => {
        expect.assertions(1);

        const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(presenceExtension);
        const indexes = schema.tables[PRESENCE_TABLE]?.indexes.map((index) => [index.name, index.fields]);

        expect(indexes).toStrictEqual([
            ["byTenantRoomSession", ["tenantId", "roomId", "sessionId"]],
            ["byTenantRoomLastSeen", ["tenantId", "roomId", "lastSeen"]],
        ]);
    });
});
