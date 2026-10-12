import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { TableErasure } from "../src/dataset";
import { defineDataset } from "../src/dataset";
import { dispositionFor, drainUntilEmpty, ERASE_BATCH, verifyErasure } from "../src/erasure";
import type { RetentionRule } from "../src/rules";
import { retain } from "../src/rules";

const rules = new Map<string, RetentionRule>([
    ["de.correspondence", { citation: "HGB §257", id: "de.correspondence", reviewRequired: true, start: "endOfCalendarYear", years: 6 }],
    ["de.voucher", { citation: "HGB §257", id: "de.voucher", reviewRequired: true, start: "endOfCalendarYear", years: 10 }],
]);
const now = new Date("2026-10-11T00:00:00.000Z");
const DID_NOT_FINISH = /did not finish/u;
const NAMES_THE_COLUMN = /billing\.invoices starts from column "issuedAt"/u;

/** The verdict for one row of a table whose erasure is `erase`, as `eraseBatch` receives it. */
const verdictFor = (erase: TableErasure, row: Readonly<Record<string, unknown>>) => {
    const billing = defineDataset("billing", { legalBasis: "legal_obligation", origin: "provided", purpose: "Invoices", tables: { invoices: { erase } } });

    return dispositionFor(rules)(billing, "invoices", row, now);
};

describe(dispositionFor, () => {
    it("deletes a row whose table is marked delete", () => {
        expect(verdictFor("delete", {})).toStrictEqual({ kind: "delete" });
    });

    it("anonymises a row whose table is marked anonymise", () => {
        expect(verdictFor("anonymise", {})).toStrictEqual({ kind: "anonymise" });
    });

    it("keeps a voucher issued in 2026 until the end of 2036", () => {
        const row = { issuedAt: new Date("2026-03-01T00:00:00.000Z") };

        expect(verdictFor(retain("de.voucher", { from: "issuedAt" }), row)).toStrictEqual({
            kind: "keep",
            until: new Date("2036-12-31T23:59:59.999Z"),
        });
    });

    it("deletes a correspondence row once its six years are over", () => {
        const row = { sentAt: 1000 };

        expect(verdictFor(retain("de.correspondence", { from: "sentAt" }), row)).toStrictEqual({ kind: "delete" });
    });

    it("starts a period at the erasure date when the row names no start column", () => {
        expect(verdictFor(retain("de.voucher"), {})).toMatchObject({ kind: "keep" });
    });

    it("refuses a start column that holds neither a Date nor a number, rather than starting at the erasure date", () => {
        const directive = retain("de.voucher", { from: "issuedAt" });

        expect(() => verdictFor(directive, { issuedAt: "2026-03-01" })).toThrow(NAMES_THE_COLUMN);
        expect(() => verdictFor(directive, {})).toThrow(NAMES_THE_COLUMN);
        expect(() => verdictFor(directive, { issuedAt: null })).toThrow(NAMES_THE_COLUMN);
        expect(() => verdictFor(directive, { issuedAt: new Date("invalid") })).toThrow(NAMES_THE_COLUMN);
        expect(() => verdictFor(directive, { issuedAt: Number.NaN })).toThrow(NAMES_THE_COLUMN);
    });

    it("refuses a directive that names a rule outside the preset set", () => {
        expect(() => verdictFor(retain("de.unknown"), {})).toThrow(LunoraError);
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

    it("drains a table larger than one batch in whole batches of ERASE_BATCH rows", async () => {
        let rows = 2 * ERASE_BATCH + 1;
        const taken: number[] = [];
        const rounds = await drainUntilEmpty(async () => {
            const batch = Math.min(rows, ERASE_BATCH);

            taken.push(batch);
            rows -= batch;

            // A port that took a full batch cannot know whether more rows wait, so it reports more.
            return { hasMore: batch === ERASE_BATCH };
        });

        expect(rows).toBe(0);
        expect(rounds).toBe(3);
        expect(Math.max(...taken)).toBeLessThanOrEqual(ERASE_BATCH);
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
