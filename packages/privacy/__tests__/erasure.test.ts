import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { dispositionOf, drainUntilEmpty, ERASE_BATCH, verifyErasure } from "../src/erasure";
import type { RetentionRule } from "../src/rules";
import { retain } from "../src/rules";

const rules = new Map<string, RetentionRule>([
    ["de.correspondence", { citation: "HGB §257", id: "de.correspondence", reviewRequired: true, start: "endOfCalendarYear", years: 6 }],
    ["de.voucher", { citation: "HGB §257", id: "de.voucher", reviewRequired: true, start: "endOfCalendarYear", years: 10 }],
]);
const now = new Date("2026-10-11T00:00:00.000Z");
const DID_NOT_FINISH = /did not finish/u;

describe(dispositionOf, () => {
    it("deletes a row whose table is marked delete", () => {
        expect(dispositionOf("delete", {}, rules, now)).toStrictEqual({ kind: "delete" });
    });

    it("anonymises a row whose table is marked anonymise", () => {
        expect(dispositionOf("anonymise", {}, rules, now)).toStrictEqual({ kind: "anonymise" });
    });

    it("keeps a voucher issued in 2026 until the end of 2036", () => {
        const row = { issuedAt: new Date("2026-03-01T00:00:00.000Z") };

        expect(dispositionOf(retain("de.voucher", { from: "issuedAt" }), row, rules, now)).toStrictEqual({
            kind: "keep",
            until: new Date("2036-12-31T23:59:59.999Z"),
        });
    });

    it("deletes a correspondence row once its six years are over", () => {
        const row = { sentAt: 1000 };

        expect(dispositionOf(retain("de.correspondence", { from: "sentAt" }), row, rules, now)).toStrictEqual({ kind: "delete" });
    });

    it("starts a period at the erasure date when the row names no start column", () => {
        expect(dispositionOf(retain("de.voucher"), {}, rules, now)).toMatchObject({ kind: "keep" });
    });

    it("refuses a directive that names a rule outside the preset set", () => {
        expect(() => dispositionOf(retain("de.unknown"), {}, rules, now)).toThrow(LunoraError);
    });
});

describe(drainUntilEmpty, () => {
    it("stops after the first batch that reports nothing left", async () => {
        const batches = [true, true, false];
        const rounds = await drainUntilEmpty(async () => {
            return { hasMore: batches.shift() ?? false };
        });

        expect(rounds).toBe(3);
    });

    it("fails rather than reporting success when the table keeps refilling", async () => {
        await expect(
            drainUntilEmpty(async () => {
                return { hasMore: true };
            }, 5),
        ).rejects.toThrow(DID_NOT_FINISH);
    });

    it("uses a batch size of 100 rows", () => {
        expect(ERASE_BATCH).toBe(100);
    });
});

describe(verifyErasure, () => {
    it("is complete when every table reads zero", () => {
        expect(verifyErasure({ account: 0, session: 0 })).toStrictEqual({ complete: true, leftover: [] });
    });

    it("names each table that still has rows, sorted", () => {
        expect(verifyErasure({ tasks: 2, account: 0, goals: 1 })).toStrictEqual({ complete: false, leftover: ["goals", "tasks"] });
    });
});
