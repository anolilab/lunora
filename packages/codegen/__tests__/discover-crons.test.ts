import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodegenDiagnosticError } from "../src/diagnostics";
import discoverCrons from "../src/discover-crons";
import { discoverWorkflows } from "../src/discover-workflows";
import { emitCrons, emitWranglerCronTriggers } from "../src/emit";

let workdir: string;

describe("discover-crons", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cron-disco-"));
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
            import { cronJobs } from "@lunora/scheduler";
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

    it("discovers cronJobs imported from the @lunora/server re-export", () => {
        expect.assertions(1);

        // @lunora/server re-exports cronJobs from @lunora/scheduler; codegen must
        // recognize it (importing framework API from @lunora/server is the
        // convention used by registry items + the presence/backup docs).
        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/server";
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
            import { cronJobs as defineCrons } from "@lunora/scheduler";
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
            import { cronJobs } from "@lunora/scheduler";
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

    it("ignores a local cronJobs not imported from @lunora/scheduler", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            const cronJobs = () => ({ interval: (..._a: unknown[]) => undefined });
            const crons = cronJobs();
            crons.interval("nope", { minutes: 1 }, { __lunoraRef: "a:b" }, {});
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
            import { cronJobs } from "@lunora/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.interval("dup", { minutes: 1 }, internal.a.b, {});
            export default crons;
        `,
        );
        writeSource(
            "more-crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
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

        expect(caught).toMatchObject({ code: "DUPLICATE_CRON_NAME", name: "LunoraError", status: 500 });
    });

    it("throws on an invalid raw cron expression", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
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
            import { cronJobs } from "@lunora/scheduler";
            import { internal } from "./_generated/api.js";
            const name = "dyn";
            const crons = cronJobs();
            crons.interval(name, { minutes: 1 }, internal.a.b, {});
            export default crons;
        `,
        );

        expect(() => discoverCrons(newProject(), workdir)).toThrow(/non-empty string-literal name/u);
    });

    it("throws a CodegenDiagnosticError with file:line:column when a cron passes a non-static value", () => {
        expect.assertions(5);

        // The schedule's `minutes` references a variable, so codegen cannot read
        // it as a literal — this drives the CRON_NON_STATIC_VALUE path through
        // literalValue, whose AST node must now carry a source location.
        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
            import { internal } from "./_generated/api.js";
            const everyMinutes = 30;
            const crons = cronJobs();
            crons.interval("clear presence", { minutes: everyMinutes }, internal.presence.clear, {});
            export default crons;
        `,
        );

        const cronPath = join(workdir, "crons.ts");

        let thrown: unknown;

        try {
            discoverCrons(newProject(), workdir);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(CodegenDiagnosticError);

        const diagnostic = thrown as CodegenDiagnosticError;

        expect(diagnostic.file).toBe(cronPath);
        expect(diagnostic.line).toBeGreaterThan(0);
        expect(diagnostic.message).toMatch(/@lunora\/codegen:/u);
        expect(diagnostic.message).toMatch(/non-static value/u);
    });

    it("resolves the generated `workflows.<name>` reference into a workflow target", () => {
        expect.assertions(1);

        writeSource(
            "workflows.ts",
            `
            import { defineWorkflow } from "@lunora/workflow";
            export const digestPipeline = defineWorkflow({ handler: async () => undefined });
        `,
        );
        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
            import { workflows } from "./_generated/api.js";
            const crons = cronJobs();
            crons.daily("nightly digest", { hourUTC: 9, minuteUTC: 0 }, workflows.digestPipeline, { region: "eu" });
            export default crons;
        `,
        );

        const project = newProject();
        const workflows = discoverWorkflows(project, workdir);

        expect(discoverCrons(project, workdir, workflows)).toEqual([
            {
                args: { region: "eu" },
                cron: "0 9 * * *",
                name: "nightly digest",
                workflow: { binding: "WORKFLOW_DIGEST_PIPELINE", exportName: "digestPipeline" },
            },
        ]);
    });

    it("also resolves a bare identifier naming a declared workflow (direct import)", () => {
        expect.assertions(1);

        writeSource(
            "workflows.ts",
            `
            import { defineWorkflow } from "@lunora/workflow";
            export const digestPipeline = defineWorkflow({ handler: async () => undefined });
        `,
        );
        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
            import { digestPipeline } from "./workflows.js";
            const crons = cronJobs();
            crons.daily("nightly digest", { hourUTC: 9, minuteUTC: 0 }, digestPipeline, {});
            export default crons;
        `,
        );

        const project = newProject();
        const workflows = discoverWorkflows(project, workdir);

        expect(discoverCrons(project, workdir, workflows)).toEqual([
            { args: {}, cron: "0 9 * * *", name: "nightly digest", workflow: { binding: "WORKFLOW_DIGEST_PIPELINE", exportName: "digestPipeline" } },
        ]);
    });

    it("throws when `workflows.<name>` names a workflow that isn't declared", () => {
        expect.assertions(1);

        writeSource(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
            import { workflows } from "./_generated/api.js";
            const crons = cronJobs();
            crons.daily("oops", { hourUTC: 9, minuteUTC: 0 }, workflows.missingFlow, {});
            export default crons;
        `,
        );

        expect(() => discoverCrons(newProject(), workdir, [])).toThrow(/no such workflow is declared/u);
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
        expect(output).toContain('export const LUNORA_CRON_TRIGGERS: ReadonlyArray<string> = [\n    "0 * * * *",\n    "*/5 * * * *",\n];');

        // Dispatcher map keeps both jobs under the shared key…
        expect(output).toContain('"0 * * * *": [');
        expect(output).toContain('{ name: "one", functionPath: "a:one", args: {} },');
        expect(output).toContain('{ name: "two", functionPath: "b:two", args: {"x":1} },');

        // …and the distinct expression has its own list.
        expect(output).toContain('"*/5 * * * *": [');
    });

    it("emits a workflow binding target instead of a functionPath for a workflow cron", () => {
        expect.assertions(3);

        const output = emitCrons([
            { args: { region: "eu" }, cron: "0 9 * * *", name: "nightly digest", workflow: { binding: "WORKFLOW_DIGEST", exportName: "digest" } },
            { args: {}, cron: "0 9 * * *", functionPath: "email:report", name: "report" },
        ]);

        // The workflow job carries `workflow: "<binding>"` and no functionPath…
        expect(output).toContain('{ name: "nightly digest", workflow: "WORKFLOW_DIGEST", args: {"region":"eu"} },');
        // …while the function job is unchanged.
        expect(output).toContain('{ name: "report", functionPath: "email:report", args: {} },');
        // The emitted interface allows either target.
        expect(output).toContain("workflow?: string;");
    });

    it("emits empty structures when there are no crons", () => {
        expect.assertions(2);

        const output = emitCrons([]);

        expect(output).toContain("export const LUNORA_CRON_TRIGGERS: ReadonlyArray<string> = [];");
        expect(output).toContain("export const LUNORA_CRONS: Record<string, ReadonlyArray<LunoraCronJob>> = {};");
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
