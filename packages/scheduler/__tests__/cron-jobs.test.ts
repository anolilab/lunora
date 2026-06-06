import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CronScheduleKind } from "../src/jobs.js";
import { compileCronSchedule, cronJobs } from "../src/jobs.js";
import type { FunctionReference } from "../src/types.js";

interface ParityCase {
    expected: string;
    kind: string;
    schedule: Record<string, unknown>;
}

const parityCases: ParityCase[] = (JSON.parse(readFileSync(new URL("cron-parity.json", import.meta.url), "utf8")) as { cases: ParityCase[] }).cases;

const fnRef = (ref: string): FunctionReference => {
    return { __cirrusRef: ref };
};

describe("cronJobs", () => {
    it("compiles .interval into a stepped cron expression for each unit", () => {
        expect.assertions(3);

        const crons = cronJobs();

        crons.interval("every-30-min", { minutes: 30 }, fnRef("presence.clear"));
        crons.interval("every-2-hours", { hours: 2 }, fnRef("jobs.sweep"));
        crons.interval("every-15-seconds", { seconds: 15 }, fnRef("jobs.tick"));

        expect(crons.jobs()[0]?.cron).toBe("*/30 * * * *");
        expect(crons.jobs()[1]?.cron).toBe("0 */2 * * *");
        expect(crons.jobs()[2]?.cron).toBe("*/15 * * * * *");
    });

    it("compiles .daily/.weekly/.monthly to fixed-UTC cron expressions", () => {
        expect.assertions(3);

        const crons = cronJobs();

        crons.daily("digest", { hourUTC: 9, minuteUTC: 5 }, fnRef("email.digest"));
        crons.weekly("report", { dayOfWeek: "monday", hourUTC: 8, minuteUTC: 0 }, fnRef("email.report"));
        crons.monthly("invoice", { day: 1, hourUTC: 0, minuteUTC: 30 }, fnRef("billing.invoice"));

        expect(crons.jobs()[0]?.cron).toBe("5 9 * * *");
        expect(crons.jobs()[1]?.cron).toBe("0 8 * * 1");
        expect(crons.jobs()[2]?.cron).toBe("30 0 1 * *");
    });

    it("passes raw expressions through .cron after validation", () => {
        expect.assertions(2);

        const crons = cronJobs();

        crons.cron("hourly", "0 * * * *", fnRef("foo.bar"), { tenant: "acme" });

        expect(crons.jobs()[0]).toEqual({ args: { tenant: "acme" }, cron: "0 * * * *", functionPath: "foo.bar", name: "hourly" });
        expect(() => crons.cron("bad", "every minute", fnRef("foo.bar"))).toThrow(/invalid cron expression/u);
    });

    it("defaults args to an empty object and records the function path", () => {
        expect.assertions(1);

        const crons = cronJobs();

        crons.interval("clear", { minutes: 30 }, fnRef("presence.clear"));

        expect(crons.jobs()[0]).toEqual({ args: {}, cron: "*/30 * * * *", functionPath: "presence.clear", name: "clear" });
    });

    it("rejects an interval that does not specify exactly one unit", () => {
        expect.assertions(2);

        const crons = cronJobs();

        expect(() => crons.interval("none", {}, fnRef("a.b"))).toThrow(/exactly one of/u);
        expect(() => crons.interval("two", { hours: 1, minutes: 1 }, fnRef("a.b"))).toThrow(/exactly one of/u);
    });

    it("validates numeric bounds on schedule fields", () => {
        expect.assertions(3);

        const crons = cronJobs();

        expect(() => crons.daily("d", { hourUTC: 24, minuteUTC: 0 }, fnRef("a.b"))).toThrow(/daily.hourUTC/u);
        expect(() => crons.monthly("m", { day: 0, hourUTC: 0, minuteUTC: 0 }, fnRef("a.b"))).toThrow(/monthly.day/u);
        expect(() => crons.interval("i", { minutes: 0 }, fnRef("a.b"))).toThrow(/interval.minutes/u);
    });

    it("rejects duplicate job names and missing function references", () => {
        expect.assertions(2);

        const crons = cronJobs();

        crons.interval("dup", { minutes: 1 }, fnRef("a.b"));

        expect(() => crons.interval("dup", { minutes: 2 }, fnRef("a.c"))).toThrow(/duplicate cron job name/u);
        // @ts-expect-error - intentional misuse: missing function reference
        expect(() => crons.interval("nofn", { minutes: 1 }, undefined)).toThrow(/requires a function reference/u);
    });

    it("is chainable across builder methods", () => {
        expect.assertions(1);

        const crons = cronJobs();
        const result = crons.interval("a", { minutes: 1 }, fnRef("a.b")).daily("b", { hourUTC: 1, minuteUTC: 0 }, fnRef("c.d"));

        expect(result.jobs()).toHaveLength(2);
    });
});

// cron-compile-parity: the scheduler compiler and codegen's static mirror
// (@cirrus/codegen src/cron-compile.ts) are both asserted against this one
// shared matrix so a drift in either copy fails CI.
describe("cron-compile-parity", () => {
    it.each(parityCases)("compiles $kind $schedule to $expected", ({ expected, kind, schedule }) => {
        expect.assertions(1);

        expect(compileCronSchedule(kind as CronScheduleKind, schedule as never)).toBe(expected);
    });
});
