import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { RequestRecord } from "../src/requests";
import { cancelRequest, extendRequest, fromStepRecord, openRequest, toStepRecord } from "../src/requests";
import { codeOf, memoryRequests } from "./harness";

const now = new Date("2026-04-10T09:00:00.000Z");
const erasure = { drainBudgetDays: 3, freshAgeMs: 24 * 60 * 60 * 1000, graceDays: 14 };

describe(openRequest, () => {
    it("opens an export straight into received, with a one-month deadline", async () => {
        const store = memoryRequests();
        const record = await openRequest(store, { id: "r1", now, subjectId: "u1", type: "export" });

        expect(record).toMatchObject({ dueAt: new Date("2026-05-10T09:00:00.000Z"), status: "received" });
        expect(store.events).toStrictEqual(["r1:received"]);
    });

    it("opens an export when the subject's earlier one expired, even if the store still finds it", async () => {
        // An app's findOpen may still return a request that has since expired; the service judges it again.
        const harnessStore = memoryRequests();
        const store = { ...harnessStore, findOpen: async (subjectId: string) => [...harnessStore.rows.values()].find((row) => row.subjectId === subjectId) };

        await openRequest(store, { id: "r1", now, subjectId: "u1", type: "export" });
        store.rows.set("r1", { ...store.rows.get("r1")!, status: "expired" });

        await expect(openRequest(store, { id: "r2", now, subjectId: "u1", type: "export" })).resolves.toMatchObject({ status: "received" });
    });

    it("opens an erasure into the grace window when a grace is configured", async () => {
        const store = memoryRequests();
        const record = await openRequest(store, { erasure, id: "r2", now, sessionAgeMs: 1000, subjectId: "u1", type: "erasure" });

        expect(record.status).toBe("grace");
        expect(record.erasureGraceUntil?.toISOString()).toBe("2026-04-24T09:00:00.000Z");
    });

    it("refuses an erasure from a session older than the fresh window", async () => {
        const store = memoryRequests();

        await expect(
            codeOf(openRequest(store, { erasure, id: "r3", now, sessionAgeMs: erasure.freshAgeMs + 1, subjectId: "u1", type: "erasure" })),
        ).resolves.toBe("PRIVACY_SESSION_NOT_FRESH");
    });

    it("refuses a second open request of the same type for the same subject", async () => {
        const store = memoryRequests();

        await openRequest(store, { id: "r4", now, subjectId: "u1", type: "export" });

        await expect(codeOf(openRequest(store, { id: "r5", now, subjectId: "u1", type: "export" }))).resolves.toBe("PRIVACY_REQUEST_OPEN");
    });

    it("allows an export and an erasure to be open at once for the same subject", async () => {
        const store = memoryRequests();

        await openRequest(store, { id: "r6", now, subjectId: "u1", type: "export" });

        await expect(openRequest(store, { id: "r7", now, subjectId: "u1", type: "erasure" })).resolves.toMatchObject({ type: "erasure" });
    });
});

describe(cancelRequest, () => {
    it("cancels an erasure during its grace window", async () => {
        const store = memoryRequests();

        await openRequest(store, { erasure, id: "r8", now, sessionAgeMs: 1000, subjectId: "u1", type: "erasure" });

        await expect(cancelRequest(store, { id: "r8", now })).resolves.toMatchObject({ status: "cancelled" });
    });

    it("refuses to cancel an erasure once it is processing", async () => {
        const store = memoryRequests();

        await openRequest(store, { erasure, id: "r9", now, sessionAgeMs: 1000, subjectId: "u1", type: "erasure" });
        store.rows.set("r9", { ...store.rows.get("r9")!, status: "processing" });

        await expect(codeOf(cancelRequest(store, { id: "r9", now }))).resolves.toBe("UNPROCESSABLE");
    });

    it("refuses a cancel whose conditional write lost to a run that started first", async () => {
        const store = memoryRequests();

        await openRequest(store, { erasure, id: "r10", now, sessionAgeMs: 1000, subjectId: "u1", type: "erasure" });

        await expect(codeOf(cancelRequest({ ...store, claim: async () => false }, { id: "r10", now }))).resolves.toBe("UNPROCESSABLE");
        expect(store.rows.get("r10")?.status).toBe("grace");
    });

    it("reports a missing request as not found", async () => {
        await expect(codeOf(cancelRequest(memoryRequests(), { id: "missing", now }))).resolves.toBe("NOT_FOUND");
    });
});

describe(extendRequest, () => {
    it("extends once to three months and records the reason", async () => {
        const store = memoryRequests();

        await openRequest(store, { id: "r10", now, subjectId: "u1", type: "export" });
        const extended = await extendRequest(store, { id: "r10", now: new Date("2026-04-20T00:00:00.000Z"), reason: "Complex request" });

        expect(extended.extendedDueAt?.toISOString()).toBe("2026-07-10T09:00:00.000Z");
        expect(extended.reason).toBe("Complex request");
    });

    it("refuses a second extension", async () => {
        const store = memoryRequests();

        await openRequest(store, { id: "r11", now, subjectId: "u1", type: "export" });
        await extendRequest(store, { id: "r11", now, reason: "first" });

        await expect(codeOf(extendRequest(store, { id: "r11", now, reason: "second" }))).resolves.toBe("UNPROCESSABLE");
    });

    it("refuses an extension once the first month has passed", async () => {
        const store = memoryRequests();

        await openRequest(store, { id: "r12", now, subjectId: "u1", type: "export" });

        await expect(codeOf(extendRequest(store, { id: "r12", now: new Date("2026-05-11T00:00:00.000Z"), reason: "late" }))).resolves.toBe("UNPROCESSABLE");
    });
});

const NAMES_ID = /"id"/u;
const NAMES_DUEAT = /"dueAt"/u;
const NAMES_STATUS = /"status"/u;
const NAMES_TYPE = /"type"/u;

describe("the workflow step form of a request", () => {
    const record: RequestRecord = {
        dueAt: new Date("2026-11-11T10:00:00.000Z"),
        erasureGraceUntil: new Date("2026-10-25T10:00:00.000Z"),
        id: "r1",
        receivedAt: new Date("2026-10-11T10:00:00.000Z"),
        status: "grace",
        subjectId: "u1",
        type: "erasure",
    };

    it("round-trips through JSON with every date a Date again", () => {
        // A durable host stores the step result as JSON text, so the dates arrive as strings.
        const text = JSON.stringify(toStepRecord(record));
        const stored: unknown = JSON.parse(text);

        expect(fromStepRecord(stored)).toStrictEqual(record);
    });

    it("refuses a step result with a missing, mistyped or unknown field", () => {
        const step = toStepRecord(record);

        expect(() => fromStepRecord(undefined)).toThrow(LunoraError);
        expect(() => fromStepRecord({ ...step, id: 7 })).toThrow(NAMES_ID);
        expect(() => fromStepRecord({ ...step, dueAt: "not a date" })).toThrow(NAMES_DUEAT);
        expect(() => fromStepRecord({ ...step, status: "archived" })).toThrow(NAMES_STATUS);
        expect(() => fromStepRecord({ ...step, type: undefined })).toThrow(NAMES_TYPE);
    });
});
