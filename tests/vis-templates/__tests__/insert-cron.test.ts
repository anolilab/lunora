import { describe, expect, test } from "vitest";

import { insertCronJob } from "../../../.vis/templates/_helpers/insert-cron.js";

const baseCrons = `import { cronJobs } from "@lunora/scheduler";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("clear presence", { minutes: 30 }, internal.presence.clear, {});

export default crons;
`;

describe("insertCronJob", () => {
    test("appends a new job to an existing crons registry", () => {
        const result = insertCronJob(baseCrons, "send digest");

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        expect(result.text).toContain(`crons.interval("clear presence"`);
        expect(result.text).toContain(`crons.interval("send digest"`);
    });

    test("preserves the original job and the default export", () => {
        const result = insertCronJob(baseCrons, "send digest");

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        // The original registration survives verbatim and the new job is
        // inserted before `export default crons` — that's the whole point of
        // going through ts-morph rather than string-splicing.
        expect(result.text).toContain("internal.presence.clear");
        expect(result.text).toContain("export default crons;");
        expect(result.text.indexOf(`crons.interval("send digest"`)).toBeLessThan(result.text.indexOf("export default crons;"));
    });

    test("inserts after the registry when there are no jobs yet", () => {
        const source = `import { cronJobs } from "@lunora/scheduler";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

export default crons;
`;
        const result = insertCronJob(source, "first job");

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        expect(result.text).toContain(`crons.interval("first job"`);
        expect(result.text.indexOf("const crons = cronJobs();")).toBeLessThan(result.text.indexOf(`crons.interval("first job"`));
    });

    test("rejects a duplicate job name", () => {
        const result = insertCronJob(baseCrons, "clear presence");

        expect(result).toEqual({ ok: false, reason: "duplicate" });
    });

    test("rejects a file without a cronJobs() registry", () => {
        const source = `export default {};\n`;
        const result = insertCronJob(source, "send digest");

        expect(result).toEqual({ ok: false, reason: "no-cron-jobs" });
    });
});
