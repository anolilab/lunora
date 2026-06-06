import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverCrons from "../src/discover-crons.js";
import { emitCrons, emitWranglerCronTriggers } from "../src/emit.js";

let workdir: string;

describe("discover-crons", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cron-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeSource = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
        writeFileSync(full, source);
    };

    const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    it("lifts interval/daily/cron registrations into compiled cron expressions", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@cirrus/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.interval("clear presence", { minutes: 30 }, internal.presence.clear, {});
            crons.daily("send digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, { batch: 10 });
            crons.cron("custom", "0 * * * *", internal.foo.bar, {});
            export default crons;
        `,
        );

        const result = discoverCrons(newProject(), workdir);

        // Sorted by name: "clear presence", "custom", "send digest".
        expect(result).toEqual([
            { args: {}, cron: "*/30 * * * *", functionPath: "presence:clear", name: "clear presence" },
            { args: {}, cron: "0 * * * *", functionPath: "foo:bar", name: "custom" },
            { args: { batch: 10 }, cron: "0 9 * * *", functionPath: "email:digest", name: "send digest" },
        ]);
    });

    it("discovers cronJobs imported from the @cirrus/server re-export", () => {
        expect.assertions(1);

        // @cirrus/server re-exports cronJobs from @cirrus/scheduler; codegen must
        // recognize it (importing framework API from @cirrus/server is the
        // convention used by registry items + the presence/backup docs).
        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@cirrus/server";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.interval("heartbeat", { hours: 1 }, internal.jobs.run, {});
            export default crons;
        `,
        );

        const result = discoverCrons(newProject(), workdir);

        expect(result).toEqual([{ args: {}, cron: "0 */1 * * *", functionPath: "jobs:run", name: "heartbeat" }]);
    });

    it("resolves an aliased cronJobs import", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            import { cronJobs as defineCrons } from "@cirrus/scheduler";
            import { internal } from "./_generated/api.js";
            const c = defineCrons();
            c.weekly("report", { dayOfWeek: "monday", hourUTC: 8, minuteUTC: 0 }, internal.email.report, {});
            export default c;
        `,
        );

        const result = discoverCrons(newProject(), workdir);

        expect(result[0]).toEqual({ args: {}, cron: "0 8 * * 1", functionPath: "email:report", name: "report" });
    });

    it("supports a chained builder", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@cirrus/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons
                .interval("a", { hours: 1 }, internal.jobs.a, {})
                .monthly("b", { day: 1, hourUTC: 0, minuteUTC: 0 }, internal.jobs.b, {});
            export default crons;
        `,
        );

        const result = discoverCrons(newProject(), workdir);

        expect(result.map((cron) => `${cron.name}:${cron.cron}`)).toEqual(["a:0 */1 * * *", "b:0 0 1 * *"]);
    });

    it("ignores a local cronJobs not imported from @cirrus/scheduler", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            const cronJobs = () => ({ interval: (..._a: unknown[]) => undefined });
            const crons = cronJobs();
            crons.interval("nope", { minutes: 1 }, { __cirrusRef: "a:b" }, {});
        `,
        );

        const result = discoverCrons(newProject(), workdir);

        expect(result).toHaveLength(0);
    });

    it("throws on a duplicate cron name across files", () => {
        expect.assertions(2);

        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@cirrus/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.interval("dup", { minutes: 1 }, internal.a.b, {});
            export default crons;
        `,
        );
        writeSource(
            "more-crons.ts",
            `
            import { cronJobs } from "@cirrus/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.interval("dup", { minutes: 2 }, internal.a.c, {});
            export default crons;
        `,
        );

        const project = newProject();

        expect(() => discoverCrons(project, workdir)).toThrow(/Duplicate cron job name "dup"/u);

        let caught: unknown;

        try {
            discoverCrons(project, workdir);
        } catch (error: unknown) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: "DUPLICATE_CRON_NAME", name: "CirrusError", status: 500 });
    });

    it("throws on an invalid raw cron expression", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@cirrus/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.cron("bad", "every minute", internal.a.b, {});
            export default crons;
        `,
        );

        expect(() => discoverCrons(newProject(), workdir)).toThrow(/invalid cron expression/u);
    });

    it("throws when a job name is not a static string literal", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@cirrus/scheduler";
            import { internal } from "./_generated/api.js";
            const name = "dyn";
            const crons = cronJobs();
            crons.interval(name, { minutes: 1 }, internal.a.b, {});
            export default crons;
        `,
        );

        expect(() => discoverCrons(newProject(), workdir)).toThrow(/non-empty string-literal name/u);
    });
});

describe("emitCrons", () => {
    it("dedupes the trigger array but keeps every job in the dispatcher map", () => {
        expect.assertions(5);

        const output = emitCrons([
            { args: {}, cron: "0 * * * *", functionPath: "a:one", name: "one" },
            { args: { x: 1 }, cron: "0 * * * *", functionPath: "b:two", name: "two" },
            { args: {}, cron: "*/5 * * * *", functionPath: "c:three", name: "three" },
        ]);

        // Trigger array dedupes the shared "0 * * * *" expression.
        expect(output).toContain('export const CIRRUS_CRON_TRIGGERS: ReadonlyArray<string> = [\n    "0 * * * *",\n    "*/5 * * * *",\n];');

        // Dispatcher map keeps both jobs under the shared key…
        expect(output).toContain('"0 * * * *": [');
        expect(output).toContain('{ name: "one", functionPath: "a:one", args: {} },');
        expect(output).toContain('{ name: "two", functionPath: "b:two", args: {"x":1} },');

        // …and the distinct expression has its own list.
        expect(output).toContain('"*/5 * * * *": [');
    });

    it("emits empty structures when there are no crons", () => {
        expect.assertions(2);

        const output = emitCrons([]);

        expect(output).toContain("export const CIRRUS_CRON_TRIGGERS: ReadonlyArray<string> = [];");
        expect(output).toContain("export const CIRRUS_CRONS: Record<string, ReadonlyArray<CirrusCronJob>> = {};");
    });
});

describe("emitWranglerCronTriggers", () => {
    it("returns the deduped schedule list in first-seen order", () => {
        expect.assertions(1);

        const triggers = emitWranglerCronTriggers([
            { args: {}, cron: "0 * * * *", functionPath: "a:one", name: "one" },
            { args: {}, cron: "0 * * * *", functionPath: "b:two", name: "two" },
            { args: {}, cron: "*/5 * * * *", functionPath: "c:three", name: "three" },
        ]);

        expect(triggers).toEqual(["0 * * * *", "*/5 * * * *"]);
    });
});
