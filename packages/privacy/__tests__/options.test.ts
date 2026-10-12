import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { germany } from "../src/de";
import { eu } from "../src/eu";
import type { PrivacyPreset } from "../src/rules";
import { DAY_MS, NOW, setup } from "./harness";

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
        const { privacy } = setup({ presets: [eu({ erasureGraceDays: 3 })] });

        const opened = await privacy.requestErasure();

        expect(opened.erasureGraceUntil?.getTime()).toBe(NOW.getTime() + 3 * DAY_MS);
    });
});

describe("the response periods", () => {
    const longer: PrivacyPreset = { id: "eu", policy: { extensionMonths: 1, responseMonths: 2 }, retention: [] };

    it("dates a request with the preset's responseMonths and extends it by its extensionMonths", async () => {
        const { operator, privacy } = setup({ presets: [eu(), longer] });
        const opened = await privacy.requestExport();

        expect(opened.dueAt.toISOString()).toBe("2026-12-11T10:00:00.000Z");
        await expect(operator.admin.extend(opened.id, "Complex request")).resolves.toMatchObject({
            extendedDueAt: new Date("2027-01-11T10:00:00.000Z"),
        });
    });

    it("reads the stored deadline when it lists overdue requests", async () => {
        const { operator, privacy, setClock } = setup({ presets: [longer] });

        await privacy.requestExport();
        // One month after receipt: overdue under the default policy, not under this one.
        setClock(new Date("2026-11-12T10:00:00.000Z"));

        await expect(operator.tick()).resolves.toMatchObject({ overdue: [] });
    });

    it("keeps the GDPR periods by default", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport();

        expect(opened.dueAt.toISOString()).toBe("2026-11-11T10:00:00.000Z");
    });

    it("refuses a response period that is not a whole number of months", () => {
        expect(() => setup({ presets: [{ id: "eu", policy: { responseMonths: 0 }, retention: [] }] })).toThrow(LunoraError);
        expect(() => setup({ presets: [{ id: "eu", policy: { extensionMonths: 1.5 }, retention: [] }] })).toThrow(LunoraError);
    });
});
