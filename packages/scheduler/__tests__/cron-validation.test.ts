import { describe, expect, it, vi } from "vitest";

import { assertValidCronExpression, isValidCronExpression, warnIfSecondsLeading } from "../src/validate-cron";

/**
 * The Cloudflare Cron Trigger dialect, enforced through `@visulima/cron-parser`.
 * This replaced a hand-written grammar; the cases below pin the acceptance set so
 * a parser or dialect change shows up as a test failure rather than as a deploy.
 */
describe("isValidCronExpression (Cloudflare dialect)", () => {
    it.each([
        "* * * * *",
        "*/15 * * * *",
        "1-5/2 * * * *",
        "0-59/5 * * * *",
        "5/10 * * * *",
        "1,2,3 * * * *",
        "1-5,10 * * * *",
        "0 0 L * *",
        "0 0 * * 5L",
        "0 0 * * 5#2",
        "0 0 1W * *",
        "0 0 L-3 * *",
        "0 0 * * MON#2",
        "0 9 * * MON-FRI",
        "0 9 * * mon,tue",
        "0 0 1 JAN *",
        "0 0 1 jan-mar *",
        "0 0 * * 1",
        "0 0 * * 7",
        "* * * * L",
        // 6-field (seconds-leading): the `.cron()` escape hatch, warned about but accepted.
        "* * * * * *",
        "*/15 * * * * *",
        "  0 0 * * *  ",
        "*\t*  * * *",
    ])("accepts %j", (expression) => {
        expect.assertions(1);

        expect(isValidCronExpression(expression)).toBe(true);
    });

    it.each([
        // Rejected by the dialect: Cloudflare runs neither the macros nor the `?`/`H` extensions.
        "@hourly",
        "@daily",
        "@weekly",
        "@monthly",
        "@yearly",
        "@annually",
        "@reboot",
        "? * * * *",
        "0 0 ? * *",
        "0 0 * * ?",
        "H * * * *",
        // A numbered last-day-of-month is only valid in the day-of-week field.
        "0 0 5L * *",
        // Cloudflare numbers weekdays 1 (Sunday) to 7 (Saturday); there is no 0.
        "0 0 * * 0",
        // Out-of-range and structurally malformed.
        "60 * * * *",
        "* 24 * * *",
        "* * 32 * *",
        "* * 0 * *",
        "* * * 13 *",
        "* * * 0 *",
        "* * * * 8",
        "* * * * * * *",
        "60 * * * * *",
        "*/0 * * * *",
        "5-1 * * * *",
        "1- * * * *",
        "a * * * *",
        "1.5 * * * *",
        "+1 * * * *",
        "1,,2 * * * *",
        "1/2/3 * * * *",
        "L",
        "* * * * 1#6",
        "* * * * 8#1",
        "",
        "   ",
    ])("rejects %j", (expression) => {
        expect.assertions(1);

        expect(isValidCronExpression(expression)).toBe(false);
    });

    it("rejects non-strings", () => {
        expect.assertions(1);

        expect(isValidCronExpression(undefined as unknown as string)).toBe(false);
    });

    it("throws a shaped error from assertValidCronExpression", () => {
        expect.assertions(1);

        expect(() => {
            assertValidCronExpression("not a cron", 'cron job "x"');
        }).toThrow(/invalid cron job "x"/u);
    });
});

describe("warnIfSecondsLeading", () => {
    it("warns for a 6-field expression and stays silent for a 5-field one", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        warnIfSecondsLeading("0 0 * * *", "cron expression");

        expect(warn).not.toHaveBeenCalled();

        warnIfSecondsLeading("*/15 * * * * *", "cron expression");

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("6-field (seconds-leading)");

        warn.mockRestore();
    });
});
