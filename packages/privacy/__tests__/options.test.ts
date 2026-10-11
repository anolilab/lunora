import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { germany } from "../src/de";
import { definePrivacy } from "../src/define";
import { eu } from "../src/eu";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-11T10:00:00.000Z");

const voucherYearsOf = (preset: ReturnType<typeof germany>): number | undefined => preset.retention.find((rule) => rule.id === "de.voucher")?.years;

const codeOf = (run: () => unknown): string => {
    try {
        run();
    } catch (error) {
        return error instanceof LunoraError ? error.code : "not-lunora";
    }

    return "no-error";
};

describe("the voucher period option", () => {
    it("keeps 10 years by default, the decided value", () => {
        expect(voucherYearsOf(germany())).toBe(10);
    });

    it("sets the statutory 8 years when asked, and says so in the note", () => {
        const voucher = germany({ voucherYears: 8 }).retention.find((rule) => rule.id === "de.voucher");

        expect(voucher?.years).toBe(8);
        expect(voucher?.note).toContain("Set to the statutory 8 years");
    });

    it("leaves the regulated-institution period at 10 years either way", () => {
        for (const voucherYears of [8, 10] as const) {
            const regulated = germany({ voucherYears }).retention.find((rule) => rule.id === "de.voucher.regulated");

            expect(regulated?.years).toBe(10);
        }
    });

    it("leaves books and correspondence unchanged", () => {
        const rules = germany({ voucherYears: 8 }).retention;

        expect(rules.find((rule) => rule.id === "de.books")?.years).toBe(10);
        expect(rules.find((rule) => rule.id === "de.correspondence")?.years).toBe(6);
    });
});

describe("the erasure grace option", () => {
    it("keeps 14 days by default, the decided value", () => {
        expect(eu().policy?.erasureGraceDays).toBe(14);
    });

    it("sets any whole number of days from 0 to 14", () => {
        expect(eu({ erasureGraceDays: 0 }).policy?.erasureGraceDays).toBe(0);
        expect(eu({ erasureGraceDays: 7 }).policy?.erasureGraceDays).toBe(7);
    });

    it("refuses a grace above 14 days, a negative grace, and a fraction", () => {
        expect(codeOf(() => eu({ erasureGraceDays: 15 }))).toBe("BAD_REQUEST");
        expect(codeOf(() => eu({ erasureGraceDays: -1 }))).toBe("BAD_REQUEST");
        expect(codeOf(() => eu({ erasureGraceDays: 1.5 }))).toBe("BAD_REQUEST");
    });

    it("applies the preset's grace when the app does not set one in definePrivacy", async () => {
        const tasks = defineDataset("tasks", {
            legalBasis: "contract",
            origin: "provided",
            purpose: "Tasks",
            tables: { tasks: {} },
        });
        const privacy = definePrivacy({
            data: memoryData({ tasks: 0 }),
            datasets: [tasks],
            files: memoryFiles(),
            newId: () => "r1",
            now: () => now,
            presets: [eu({ erasureGraceDays: 3 })],
            store: memoryRequests(),
        });

        const opened = await privacy.requestErasure({ sessionAgeMs: 1000, subjectId: "u1" });

        expect(opened.erasureGraceUntil?.getTime()).toBe(now.getTime() + 3 * DAY_MS);
    });
});
