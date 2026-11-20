import { describe, expect, it, vi } from "vitest";

import type { CronTarget } from "../src/fanout/cron";
import { CRON_DISPATCH_CONCURRENCY, cronDue, dueTicks, fanOutCron, MAX_CRON_TICKS_PER_INVOCATION } from "../src/fanout/cron";

// 2026-06-15 09:05 UTC is a Monday.
const at = (iso: string): Date => new Date(iso);

describe(cronDue, () => {
    it("matches a plain minute/hour expression", () => {
        expect(cronDue("5 9 * * *", at("2026-06-15T09:05:00Z"))).toBe(true);
        expect(cronDue("5 9 * * *", at("2026-06-15T09:06:00Z"))).toBe(false);
        expect(cronDue("5 9 * * *", at("2026-06-15T10:05:00Z"))).toBe(false);
    });

    it("handles step and wildcard fields", () => {
        expect(cronDue("*/15 * * * *", at("2026-06-15T09:00:00Z"))).toBe(true);
        expect(cronDue("*/15 * * * *", at("2026-06-15T09:15:00Z"))).toBe(true);
        expect(cronDue("*/15 * * * *", at("2026-06-15T09:07:00Z"))).toBe(false);
        expect(cronDue("* * * * *", at("2026-06-15T09:05:00Z"))).toBe(true);
    });

    it("handles ranges and lists", () => {
        expect(cronDue("0 9-17 * * 1-5", at("2026-06-15T13:00:00Z"))).toBe(true); // Mon 13:00
        expect(cronDue("0 9-17 * * 1-5", at("2026-06-13T13:00:00Z"))).toBe(false); // Saturday
        expect(cronDue("0 0 1,15 * *", at("2026-06-15T00:00:00Z"))).toBe(true);
    });

    it("oRs day-of-month and day-of-week when both are restricted", () => {
        // dom=1 OR dow=1(Mon): the 15th is a Monday, so the dow side matches.
        expect(cronDue("0 0 1 * 1", at("2026-06-15T00:00:00Z"))).toBe(true);
        // Neither the 2nd-of-month nor Monday: a Tuesday that isn't the 1st.
        expect(cronDue("0 0 1 * 1", at("2026-06-16T00:00:00Z"))).toBe(false);
    });

    it("rejects malformed expressions", () => {
        expect(cronDue("not a cron", at("2026-06-15T09:05:00Z"))).toBe(false);
        expect(cronDue("* * * *", at("2026-06-15T09:05:00Z"))).toBe(false);
    });
});

const targets: CronTarget[] = [
    { adminToken: "tok-a", cronSpecs: ["5 9 * * *", "0 0 * * *"], scriptName: "app-a" },
    { adminToken: "tok-b", cronSpecs: ["*/10 * * * *"], scriptName: "app-b" },
];

describe(dueTicks, () => {
    it("returns only the (script, cron) pairs due at the given minute", () => {
        const ticks = dueTicks(targets, at("2026-06-15T09:05:00Z"));

        expect(ticks).toStrictEqual([{ adminToken: "tok-a", cron: "5 9 * * *", scriptName: "app-a" }]);
    });

    it("can fire several tenants at once", () => {
        const ticks = dueTicks(targets, at("2026-06-15T00:00:00Z"));

        expect(ticks.map((tick) => tick.scriptName).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["app-a", "app-b"]);
    });
});

describe(fanOutCron, () => {
    it("dispatches each due tick and counts outcomes", async () => {
        const dispatch = vi.fn<(tick: { scriptName: string }) => Promise<boolean>>().mockResolvedValue(true);
        const result = await fanOutCron({ dispatch, now: at("2026-06-15T00:00:00Z"), targets });

        expect(result).toStrictEqual({ delivered: 2, failed: 0, skipped: 0 });
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it("counts a failed/throwing tick without aborting the rest", async () => {
        const dispatch = vi.fn<(tick: { scriptName: string }) => Promise<boolean>>().mockImplementation((tick: { scriptName: string }) => {
            if (tick.scriptName === "app-a") {
                throw new Error("tenant unreachable");
            }

            return Promise.resolve(true);
        });

        const result = await fanOutCron({ dispatch, now: at("2026-06-15T00:00:00Z"), targets });

        expect(result).toStrictEqual({ delivered: 1, failed: 1, skipped: 0 });
    });

    it("caps the ticks of one invocation, reports the overflow, and bounds how many are in flight", async () => {
        expect.assertions(5);

        const many: CronTarget[] = Array.from({ length: MAX_CRON_TICKS_PER_INVOCATION + 37 }, (_, index) => {
            return { adminToken: "t", cronSpecs: ["* * * * *"], scriptName: `app-${String(index)}` };
        });
        let inFlight = 0;
        let peak = 0;
        const dispatch = vi.fn<(tick: { scriptName: string }) => Promise<boolean>>().mockImplementation(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            // Yield so every worker the pool started is in flight before any finishes.
            await Promise.resolve();
            inFlight -= 1;

            return true;
        });

        const result = await fanOutCron({ dispatch, now: at("2026-06-15T00:00:00Z"), targets: many });

        expect(result).toStrictEqual({ delivered: MAX_CRON_TICKS_PER_INVOCATION, failed: 0, skipped: 37 });
        expect(dispatch).toHaveBeenCalledTimes(MAX_CRON_TICKS_PER_INVOCATION);
        expect(peak).toBeLessThanOrEqual(CRON_DISPATCH_CONCURRENCY);
        expect(peak).toBeGreaterThan(1);

        // The next minute's window starts elsewhere, so the overflow is not always the same tenants.
        const next = vi.fn<(tick: { scriptName: string }) => Promise<boolean>>().mockResolvedValue(true);

        await fanOutCron({ dispatch: next, now: at("2026-06-15T00:01:00Z"), targets: many });

        expect(next.mock.calls[0]?.[0].scriptName).not.toBe(dispatch.mock.calls[0]?.[0].scriptName);
    });
});
