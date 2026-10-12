import { describe, expect, it } from "vitest";

import { isOverdue as sharedIsOverdue } from "../../../shared/privacy-deadlines";
import { isTerminal as sharedIsTerminal } from "../../../shared/privacy-request-status";
import { isOverdue, isTerminal, OPEN_STATUSES } from "../src/lifecycle";
import type { RequestRecord } from "../src/requests";
import { fromRequestRow, toRequestPatch, toRequestRow } from "../src/rows";
import { NOW, setup } from "./harness";

const record: RequestRecord = {
    dueAt: new Date("2026-11-11T10:00:00.000Z"),
    erasureGraceUntil: new Date("2026-10-25T10:00:00.000Z"),
    id: "r1",
    receivedAt: NOW,
    status: "grace",
    subjectId: "u1",
    type: "erasure",
};

describe("the privacy_requests row mapping", () => {
    it("round-trips a request through its row, leaving unset columns out", () => {
        const row = toRequestRow(record);

        expect(row).toStrictEqual({
            dueAt: record.dueAt.getTime(),
            erasureGraceUntil: record.erasureGraceUntil?.getTime(),
            receivedAt: NOW.getTime(),
            requestId: "r1",
            status: "grace",
            subjectId: "u1",
            type: "erasure",
        });
        expect(fromRequestRow(row)).toStrictEqual(record);
    });

    it("writes only the columns a patch sets, including a rewritten subject id", () => {
        expect(toRequestPatch({ expiresAt: NOW, status: "ready", subjectId: "key" })).toStrictEqual({
            expiresAt: NOW.getTime(),
            status: "ready",
            subjectId: "key",
        });
    });

    it("lists every status that is not terminal as open", () => {
        expect(OPEN_STATUSES.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["failed", "grace", "processing", "ready", "received"]);
        expect(OPEN_STATUSES.some((status) => isTerminal(status))).toBe(false);
    });

    it("reads the terminal and overdue rules the Studio reads, not a copy of them", () => {
        expect(isTerminal).toBe(sharedIsTerminal);
        expect(isOverdue).toBe(sharedIsOverdue);
    });
});

describe("myRequests", () => {
    it("lists every request of the subject, finished ones too, newest first", async () => {
        const { advance, as, privacy } = setup();
        const first = await privacy.requestExport();

        await privacy.cancelRequest({ requestId: first.id });
        advance(1);

        const second = await privacy.requestExport();

        await as({ sessionAgeMs: 0, subjectId: "u2" }).requestExport();

        await expect(privacy.myRequests()).resolves.toMatchObject([
            { id: second.id, status: "received" },
            { id: first.id, status: "cancelled" },
        ]);
    });
});
