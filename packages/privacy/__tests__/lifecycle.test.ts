import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { REQUEST_STATUSES } from "../../../shared/privacy-request-status";
import { dueAt as dueAtOf } from "../src/deadlines";
import type { RequestType } from "../src/lifecycle";
import {
    canCancel,
    canExtend,
    canTransition,
    effectiveDueAt,
    erasureGraceUntil,
    InvalidTransitionError,
    isOverdue,
    isTerminal,
    transition,
} from "../src/lifecycle";

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string): Date => new Date(iso);

describe(transition, () => {
    it("allows the export path from received to ready", () => {
        expect(transition("received", "processing")).toBe("processing");
        expect(transition("processing", "ready")).toBe("ready");
    });

    it("lets an operator retry a failed request", () => {
        expect(transition("failed", "processing")).toBe("processing");
    });

    it("expires a ready export, and nothing moves out of expired", () => {
        expect(transition("ready", "expired")).toBe("expired");
        expect(() => transition("expired", "processing")).toThrow(InvalidTransitionError);
        expect(() => transition("processing", "expired")).toThrow(InvalidTransitionError);
    });

    it("refuses a move out of a completed request", () => {
        expect(() => transition("completed", "processing")).toThrow(InvalidTransitionError);
    });

    it("refuses an erasure that jumps from received straight to completed", () => {
        expect(() => transition("received", "completed")).toThrow(InvalidTransitionError);
    });

    it("refuses a transition with an UNPROCESSABLE LunoraError, like every other refused change", () => {
        expect(() => transition("completed", "processing")).toThrow(LunoraError);
        expect(() => transition("completed", "processing")).toThrow(expect.objectContaining({ code: "UNPROCESSABLE" }));
    });
});

describe(isTerminal, () => {
    it("treats completed, cancelled and expired as terminal, and failed as retryable", () => {
        expect(isTerminal("completed")).toBe(true);
        expect(isTerminal("expired")).toBe(true);
        expect(isTerminal("cancelled")).toBe(true);
        expect(isTerminal("failed")).toBe(false);
    });
});

describe(canCancel, () => {
    it("lets a subject cancel an export until it is handed over", () => {
        expect(canCancel("export", "received")).toBe(true);
        expect(canCancel("export", "processing")).toBe(false);
        expect(canCancel("export", "ready")).toBe(false);
    });

    it("lets a subject cancel an erasure only inside its grace window", () => {
        expect(canCancel("erasure", "grace")).toBe(true);
        expect(canCancel("erasure", "processing")).toBe(false);
    });
});

describe(canExtend, () => {
    const dueAt = at("2026-05-10T00:00:00.000Z");

    it("allows one extension while the first month is still running", () => {
        expect(canExtend({ dueAt }, at("2026-05-01T00:00:00.000Z"))).toBe(true);
    });

    it("refuses an extension after the first month has ended", () => {
        expect(canExtend({ dueAt }, at("2026-05-10T00:00:00.001Z"))).toBe(false);
    });

    it("refuses a second extension", () => {
        expect(canExtend({ dueAt, extendedDueAt: at("2026-07-10T00:00:00.000Z") }, at("2026-05-01T00:00:00.000Z"))).toBe(false);
    });
});

describe("effectiveDueAt and isOverdue", () => {
    const dueAt = at("2026-05-10T00:00:00.000Z");
    const extendedDueAt = at("2026-07-10T00:00:00.000Z");

    it("uses the stored extended deadline once an extension is granted", () => {
        expect(effectiveDueAt({ dueAt, extendedDueAt })).toBe(extendedDueAt);
        expect(effectiveDueAt({ dueAt })).toBe(dueAt);
    });

    it("flags an unfinished request after its deadline", () => {
        expect(isOverdue({ dueAt, status: "processing" }, at("2026-05-11T00:00:00.000Z"))).toBe(true);
    });

    it("does not flag a finished request, even past its deadline", () => {
        expect(isOverdue({ dueAt, status: "completed" }, at("2026-08-01T00:00:00.000Z"))).toBe(false);
        expect(isOverdue({ dueAt, status: "ready" }, at("2026-08-01T00:00:00.000Z"))).toBe(false);
    });

    it("honours the extension when one was granted", () => {
        expect(isOverdue({ dueAt, extendedDueAt, status: "processing" }, at("2026-06-01T00:00:00.000Z"))).toBe(false);
    });
});

describe(erasureGraceUntil, () => {
    it("runs the full 14-day grace when there is room before the deadline", () => {
        expect(erasureGraceUntil(at("2026-04-10T00:00:00.000Z"), dueAtOf(at("2026-04-10T00:00:00.000Z")), 14, 3).toISOString()).toBe(
            "2026-04-24T00:00:00.000Z",
        );
    });

    it("caps the grace before the deadline for a 30-day setting", () => {
        // Receipt on 1 February: the deadline is 1 March, so the cap is 25 days after receipt.
        const graceEnd = erasureGraceUntil(at("2027-02-01T00:00:00.000Z"), dueAtOf(at("2027-02-01T00:00:00.000Z")), 30, 3);

        expect(graceEnd.getTime() - at("2027-02-01T00:00:00.000Z").getTime()).toBe(25 * DAY_MS - 0);
    });

    it("never gives a drain budget under the 3-day floor", () => {
        const graceEnd = erasureGraceUntil(at("2027-02-01T00:00:00.000Z"), dueAtOf(at("2027-02-01T00:00:00.000Z")), 30, 0);

        expect(graceEnd.getTime() - at("2027-02-01T00:00:00.000Z").getTime()).toBe(25 * DAY_MS);
    });

    it("keeps the 14-day grace unchanged in the shortest month", () => {
        expect(erasureGraceUntil(at("2027-02-01T00:00:00.000Z"), dueAtOf(at("2027-02-01T00:00:00.000Z")), 14, 3).toISOString()).toBe(
            "2027-02-15T00:00:00.000Z",
        );
    });
});

describe("the cancel rule and the transition table", () => {
    const types: ReadonlyArray<RequestType> = ["erasure", "export"];

    it("allows a move to cancelled exactly from the statuses some request type may cancel in", () => {
        for (const status of REQUEST_STATUSES) {
            expect(canTransition(status, "cancelled")).toBe(types.some((type) => canCancel(type, status)));
        }
    });

    it("has no edge the package never takes: a ready export is not run again or cancelled, and grace is opened directly", () => {
        expect(canTransition("ready", "processing")).toBe(false);
        expect(canTransition("ready", "cancelled")).toBe(false);
        expect(canTransition("received", "grace")).toBe(false);
        expect(canTransition("ready", "expired")).toBe(true);
    });

    it("moves nothing out of a terminal status, failed included as a target", () => {
        for (const from of REQUEST_STATUSES.filter((status) => isTerminal(status))) {
            expect(REQUEST_STATUSES.filter((to) => canTransition(from, to))).toStrictEqual([]);
        }
    });
});
