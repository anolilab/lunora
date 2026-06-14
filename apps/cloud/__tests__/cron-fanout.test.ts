import { describe, expect, it, vi } from "vitest";

import type { CronTarget } from "../src/fanout/cron";
import { cronDue, dueTicks, fanOutCron } from "../src/fanout/cron";

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
        const dispatch = vi.fn().mockResolvedValue(true);
        const result = await fanOutCron({ dispatch, now: at("2026-06-15T00:00:00Z"), targets });

        expect(result).toStrictEqual({ delivered: 2, failed: 0 });
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it("counts a failed/throwing tick without aborting the rest", async () => {
        const dispatch = vi.fn().mockImplementation((tick: { scriptName: string }) => {
            if (tick.scriptName === "app-a") {
                throw new Error("tenant unreachable");
            }

            return Promise.resolve(true);
        });

        const result = await fanOutCron({ dispatch, now: at("2026-06-15T00:00:00Z"), targets });

        expect(result).toStrictEqual({ delivered: 1, failed: 1 });
    });
});
