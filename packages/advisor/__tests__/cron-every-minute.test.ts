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

    it.each(["* * * * *", "*/1 * * * *", "0-59 * * * *", "0-59/1 * * * *", "  *   * * * * ", "* 0-23 * * *", "* */1 1-31 1-12 0-6", "*/1 0-23/1 * * *"])(
        "flags %j",
        (cron) => {
            expect.assertions(2);

            const findings = cronEveryMinute.run({ crons: [job(cron)], schema });

            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({ cacheKey: "cron_every_minute:sweep", level: "INFO", name: "cron_every_minute" });
        },
    );

    it.each(["*/5 * * * *", "0 * * * *", "30 9 * * *", "* 9 * * *", "* * 1 * *", "* * * * 1", "* * * *", "* * * * * *", "* 9-17 * * 1-5", "* 0-12 * * *"])(
        "leaves %j alone",
        (cron) => {
            expect.assertions(1);

            expect(cronEveryMinute.run({ crons: [job(cron)], schema })).toHaveLength(0);
        },
    );

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
