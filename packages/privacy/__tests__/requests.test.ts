import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { RequestRecord, RequestStore } from "../src/requests";
import { cancelRequest, extendRequest, openRequest } from "../src/requests";

/** An in-memory store for the port. Each call is recorded, so a test can check what was written. */
const memoryStore = (): RequestStore & { events: string[]; rows: Map<string, RequestRecord> } => {
    const rows = new Map<string, RequestRecord>();
    const events: string[] = [];

    return {
        addEvent: async (requestId, _at, kind) => {
            events.push(`${requestId}:${kind}`);
        },
        events,
        findOpen: async (subjectId, type) =>
            [...rows.values()].find((row) => row.subjectId === subjectId && row.type === type && row.status !== "completed" && row.status !== "cancelled"),
        get: async (id) => rows.get(id),
        listOpen: async () => [...rows.values()],
        insert: async (record) => {
            rows.set(record.id, record);
        },
        rows,
        update: async (id, patch) => {
            const existing = rows.get(id);

            if (existing !== undefined) {
                rows.set(id, { ...existing, ...patch });
            }
        },
    };
};

const now = new Date("2026-04-10T09:00:00.000Z");
const erasure = { drainBudgetDays: 3, freshAgeMs: 24 * 60 * 60 * 1000, graceDays: 14 };

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
        await promise;
    } catch (error) {
        return error instanceof LunoraError ? error.code : "not-lunora";
    }

    return "no-error";
};

describe(openRequest, () => {
    it("opens an export straight into received, with a one-month deadline", async () => {
        const store = memoryStore();
        const record = await openRequest(store, { id: "r1", now, subjectId: "u1", type: "export" });

        expect(record).toMatchObject({ dueAt: new Date("2026-05-10T09:00:00.000Z"), status: "received" });
        expect(store.events).toStrictEqual(["r1:received"]);
    });

    it("opens an erasure into the grace window when a grace is configured", async () => {
        const store = memoryStore();
        const record = await openRequest(store, { erasure, id: "r2", now, sessionAgeMs: 1000, subjectId: "u1", type: "erasure" });

        expect(record.status).toBe("grace");
        expect(record.erasureGraceUntil?.toISOString()).toBe("2026-04-24T09:00:00.000Z");
    });

    it("refuses an erasure from a session older than the fresh window", async () => {
        const store = memoryStore();

        await expect(
            codeOf(openRequest(store, { erasure, id: "r3", now, sessionAgeMs: erasure.freshAgeMs + 1, subjectId: "u1", type: "erasure" })),
        ).resolves.toBe("PRIVACY_SESSION_NOT_FRESH");
    });

    it("refuses a second open request of the same type for the same subject", async () => {
        const store = memoryStore();

        await openRequest(store, { id: "r4", now, subjectId: "u1", type: "export" });

        await expect(codeOf(openRequest(store, { id: "r5", now, subjectId: "u1", type: "export" }))).resolves.toBe("PRIVACY_REQUEST_OPEN");
    });

    it("allows an export and an erasure to be open at once for the same subject", async () => {
        const store = memoryStore();

        await openRequest(store, { id: "r6", now, subjectId: "u1", type: "export" });

        await expect(openRequest(store, { id: "r7", now, subjectId: "u1", type: "erasure" })).resolves.toMatchObject({ type: "erasure" });
    });
});

describe(cancelRequest, () => {
    it("cancels an erasure during its grace window", async () => {
        const store = memoryStore();

        await openRequest(store, { erasure, id: "r8", now, sessionAgeMs: 1000, subjectId: "u1", type: "erasure" });

        await expect(cancelRequest(store, { id: "r8", now })).resolves.toMatchObject({ status: "cancelled" });
    });

    it("refuses to cancel an erasure once it is processing", async () => {
        const store = memoryStore();

        await openRequest(store, { erasure, id: "r9", now, sessionAgeMs: 1000, subjectId: "u1", type: "erasure" });
        store.rows.set("r9", { ...store.rows.get("r9")!, status: "processing" });

        await expect(codeOf(cancelRequest(store, { id: "r9", now }))).resolves.toBe("UNPROCESSABLE");
    });

    it("reports a missing request as not found", async () => {
        await expect(codeOf(cancelRequest(memoryStore(), { id: "missing", now }))).resolves.toBe("NOT_FOUND");
    });
});

describe(extendRequest, () => {
    it("extends once to three months and records the reason", async () => {
        const store = memoryStore();

        await openRequest(store, { id: "r10", now, subjectId: "u1", type: "export" });
        const extended = await extendRequest(store, { id: "r10", now: new Date("2026-04-20T00:00:00.000Z"), reason: "Complex request" });

        expect(extended.extendedDueAt?.toISOString()).toBe("2026-07-10T09:00:00.000Z");
        expect(extended.reason).toBe("Complex request");
    });

    it("refuses a second extension", async () => {
        const store = memoryStore();

        await openRequest(store, { id: "r11", now, subjectId: "u1", type: "export" });
        await extendRequest(store, { id: "r11", now, reason: "first" });

        await expect(codeOf(extendRequest(store, { id: "r11", now, reason: "second" }))).resolves.toBe("UNPROCESSABLE");
    });

    it("refuses an extension once the first month has passed", async () => {
        const store = memoryStore();

        await openRequest(store, { id: "r12", now, subjectId: "u1", type: "export" });

        await expect(codeOf(extendRequest(store, { id: "r12", now: new Date("2026-05-11T00:00:00.000Z"), reason: "late" }))).resolves.toBe("UNPROCESSABLE");
    });
});
