import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CronScheduleKind } from "../src/jobs";
import { compileCronSchedule, cronJobs } from "../src/jobs";
import type { FunctionReference, WorkflowReference } from "../src/types";

interface ParityCase {
    expected: string;
    kind: string;
    schedule: Record<string, unknown>;
}

const parityCases: ParityCase[] = (JSON.parse(readFileSync(new URL("cron-parity.json", import.meta.url), "utf8")) as { cases: ParityCase[] }).cases;

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
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

    it("accepts the full cron grammar via cron-parser (names, lists, ranges, steps, L/#, seconds)", () => {
        expect.assertions(6);

        const crons = cronJobs();

        // Named months/weekdays, lists, ranges, and steps.
        crons.cron("named", "0 0 * JAN-MAR MON,FRI", fnRef("a.b"));
        // Quartz-style last-weekday-of-month.
        crons.cron("last-friday", "0 9 * * 5L", fnRef("a.c"));
        // Nth weekday of the month.
        crons.cron("second-monday", "0 0 * * 1#2", fnRef("a.d"));
        // 6-field, seconds-leading.
        crons.cron("with-seconds", "*/15 * * * * *", fnRef("a.e"));

        expect(crons.jobs()).toHaveLength(4);
        expect(crons.jobs()[0]?.cron).toBe("0 0 * JAN-MAR MON,FRI");
        expect(crons.jobs()[1]?.cron).toBe("0 9 * * 5L");
        expect(crons.jobs()[2]?.cron).toBe("0 0 * * 1#2");

        // Still rejects clearly malformed expressions and prose.
        expect(() => crons.cron("garbage", "0 0 0", fnRef("a.f"))).toThrow(/invalid cron expression/u);
        expect(() => crons.cron("prose", "hourly please", fnRef("a.g"))).toThrow(/invalid cron expression/u);
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

    it("points a daily-shaped interval at crons.daily instead of restating the range", () => {
        expect.assertions(6);

        // `{ hours: 24 }` is the ordinary Convex idiom for
        // "once a day"; the old message only said "must be an integer in
        // [1, 23]", so the natural next guess is `{ days: 1 }` — which the
        // "exactly one of" message then rejected without naming the fix either.
        // Both dead ends now name `crons.daily`.
        const crons = cronJobs();

        expect(() => crons.interval("d", { hours: 24 }, fnRef("a.b"))).toThrow(/interval\.hours is capped at 23, got 24/u);
        expect(() => crons.interval("d", { hours: 24 }, fnRef("a.b"))).toThrow(/crons\.daily\(name, \{ hourUTC, minuteUTC \}/u);

        // @ts-expect-error -- `days` is not a unit; codegen reads literals, so this reaches runtime validation.
        expect(() => crons.interval("days", { days: 1 }, fnRef("a.b"))).toThrow(/exactly one of \{ seconds, minutes, hours \}, got \{ days \}/u);
        // @ts-expect-error -- same call, asserting the hint rather than the constraint.
        expect(() => crons.interval("days", { days: 1 }, fnRef("a.b"))).toThrow(/crons\.daily\(name, \{ hourUTC, minuteUTC \}/u);

        // 23 is still the largest legal interval, and it must still divide 24.
        expect(() => crons.interval("h23", { hours: 23 }, fnRef("a.b"))).toThrow(/must evenly divide 24/u);
        expect(cronJobs().interval("h12", { hours: 12 }, fnRef("a.b")).jobs()[0]?.cron).toBe("0 */12 * * *");
    });

    it("registers an hourly job at a chosen minute past the hour", () => {
        expect.assertions(2);

        // Daily/weekly/monthly existed but hourly did not, so
        // hourly jobs had to go through `interval({ hours: 1 })` — which also
        // pins them to :00, where they stampede.
        const crons = cronJobs();

        crons.hourly("sweep", { minuteUTC: 17 }, fnRef("presence.sweep"));

        expect(crons.jobs()[0]).toEqual({ args: {}, cron: "17 * * * *", functionPath: "presence.sweep", name: "sweep" });
        expect(() => cronJobs().hourly("bad", { minuteUTC: 60 }, fnRef("a.b"))).toThrow(/hourly\.minuteUTC/u);
    });

    it("rejects an interval value that does not evenly divide its period", () => {
        expect.assertions(3);

        const crons = cronJobs();

        // 45 does not divide 60: cron "*/45" fires at :00 and :45 (a 45/15 sawtooth), not every 45 minutes.
        expect(() => crons.interval("m", { minutes: 45 }, fnRef("a.b"))).toThrow(/interval\.minutes/u);
        // 7 does not divide 24: cron "0 */7" fires at 00,07,14,21 then wraps to a 3h gap.
        expect(() => crons.interval("h", { hours: 7 }, fnRef("a.b"))).toThrow(/interval\.hours/u);
        // 25 does not divide 60 seconds.
        expect(() => crons.interval("s", { seconds: 25 }, fnRef("a.b"))).toThrow(/interval\.seconds/u);
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

    it("records a workflow target (no functionPath) when passed a workflow reference", () => {
        expect.assertions(2);

        const crons = cronJobs();

        // Shaped like the generated `workflows.<name>` reference object.
        crons.daily("nightly digest", { hourUTC: 9, minuteUTC: 0 }, { binding: "WORKFLOW_DIGEST", isLunoraWorkflow: true, name: "digest" }, { region: "eu" });
        crons.interval("anon flow", { minutes: 30 }, { isLunoraWorkflow: true });

        expect(crons.jobs()[0]).toEqual({ args: { region: "eu" }, cron: "0 9 * * *", name: "nightly digest", workflow: "digest" });
        // A workflow with no stable-name override records an empty marker (codegen resolves the real binding).
        expect(crons.jobs()[1]).toEqual({ args: {}, cron: "*/30 * * * *", name: "anon flow", workflow: "" });
    });

    it("infers a workflow target's args from its params type", () => {
        expect.assertions(1);

        const crons = cronJobs();
        // A generated `workflows.<name>` ref carries the workflow's params in `__params`.
        const digest: WorkflowReference<{ region: string }> = { binding: "WORKFLOW_DIGEST", isLunoraWorkflow: true, name: "digest" };

        crons.daily("digest", { hourUTC: 9, minuteUTC: 0 }, digest, { region: "eu" });
        // @ts-expect-error -- `region` must be a string (inferred from the workflow's params)
        crons.daily("typo", { hourUTC: 9, minuteUTC: 0 }, digest, { region: 123 });
        // @ts-expect-error -- `reglon` is not a declared param
        crons.daily("typo2", { hourUTC: 9, minuteUTC: 0 }, digest, { reglon: "eu" });

        expect(crons.jobs()).toHaveLength(3);
    });

    it("is chainable across builder methods", () => {
        expect.assertions(1);

        const crons = cronJobs();
        const result = crons.interval("a", { minutes: 1 }, fnRef("a.b")).daily("b", { hourUTC: 1, minuteUTC: 0 }, fnRef("c.d"));

        expect(result.jobs()).toHaveLength(2);
    });
});

// cron-compile-parity: the scheduler compiler and codegen's static mirror
// (@lunora/codegen src/cron-compile.ts) are both asserted against this one
// shared matrix so a drift in either copy fails CI.
describe("cron-compile-parity", () => {
    it.each(parityCases)("compiles $kind $schedule to $expected", ({ expected, kind, schedule }) => {
        expect.assertions(1);

        expect(compileCronSchedule(kind as CronScheduleKind, schedule as never)).toBe(expected);
    });
});
