import { describe, expect, it } from "vitest";

import type { AdvisorCron, AdvisorSchema } from "../src";
import { runAdvisor } from "../src";
import cronEveryMinute from "../src/lints/static/cron-every-minute";

const schema: AdvisorSchema = { tables: [] };

const job = (cron: string, overrides: Partial<AdvisorCron> = {}): AdvisorCron => {
    return { cron, functionPath: "presence:sweep", name: "sweep", ...overrides };
};

describe("cron_every_minute", () => {
    it("finds nothing without cron evidence (runtime caller)", () => {
        expect.assertions(1);

        expect(cronEveryMinute.run({ schema })).toHaveLength(0);
    });

    it.each([
        "* * * * *",
        "*/1 * * * *",
        "0-59 * * * *",
        "0-59/1 * * * *",
        "  *   * * * * ",
        "* 0-23 * * *",
        "* */1 1-31 1-12 1-7",
        "*/1 0-23/1 * * *",
        "0-29,30-59 * * * *",
        "* * * * 1-7",
        "* * * * SUN-SAT",
    ])("flags %j", (cron) => {
        expect.assertions(2);

        const findings = cronEveryMinute.run({ crons: [job(cron)], schema });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "cron_every_minute:sweep", level: "INFO", name: "cron_every_minute" });
    });

    it.each(["*/5 * * * *", "0 * * * *", "30 9 * * *", "* * * *", "* * * * * *", "0-29 * * * *", "not a cron"])("leaves %j alone", (cron) => {
        expect.assertions(1);

        expect(cronEveryMinute.run({ crons: [job(cron)], schema })).toHaveLength(0);
    });

    it.each(["* 9-17 * * 1-5", "* 0-12 * * *", "0-59 9-17 * * *", "* 9 * * *", "* * 1 * *", "* * * * 1"])(
        "flags the windowed %j without the all-day figure",
        (cron) => {
            expect.assertions(3);

            const [finding] = cronEveryMinute.run({ crons: [job(cron)], schema });

            expect(finding?.detail).toContain("while its window is open");
            expect(finding?.detail).not.toContain("43,200");
            expect(finding?.metadata).toMatchObject({ window: true });
        },
    );

    it("gives an all-week cron the all-day figure, not a windowed one", () => {
        expect.assertions(2);

        const [finding] = cronEveryMinute.run({ crons: [job("* * * * 1-7")], schema });

        expect(finding?.detail).toContain("43,200");
        expect(finding?.metadata).toMatchObject({ window: false });
    });

    it("names a workflow target by its export", () => {
        expect.assertions(1);

        const [finding] = cronEveryMinute.run({
            crons: [job("* * * * *", { functionPath: undefined, name: "poll", workflow: { exportName: "orderPipeline" } })],
            schema,
        });

        expect(finding?.detail).toContain('workflow "orderPipeline"');
    });

    it("runs through the default static set", () => {
        expect.assertions(1);

        const findings = runAdvisor({ crons: [job("* * * * *")], schema }, { source: "static" });

        expect(findings.some((finding) => finding.name === "cron_every_minute")).toBe(true);
    });
});
