import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAdminRoutes from "../../src/discover/admin-routes";
import { discoverContainers } from "../../src/discover/containers";
import discoverCrons from "../../src/discover/crons";
import discoverProcedureMiddleware from "../../src/discover/procedure-middleware";
import { discoverQueues } from "../../src/discover/queues";
import discoverRlsProcedures from "../../src/discover/rls-procedures";
import { discoverShapes } from "../../src/discover/shapes";
import { discoverWorkflows } from "../../src/discover/workflows";

/** The 1-based line of the first source line containing `text`. */
const lineOf = (source: string, text: string): number => source.split("\n").findIndex((line) => line.includes(text)) + 1;

let workdir: string;
let lunoraDirectory: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

/** Write one fixture file under the project root (`containers`, `queues`, …) or under `lunora/`. */
const writeFile = (relative: string, source: string, underLunora = false): void => {
    const full = join(underLunora ? lunoraDirectory : workdir, relative);

    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, source, "utf8");
};

// Every fixture puts a JSDoc block above the declaration, so each assertion also pins that the
// recorded line is the declaring statement and not the comment above it.

describe("declaration sites on advisor evidence", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-decl-sites-"));
        lunoraDirectory = join(workdir, "lunora");
        mkdirSync(lunoraDirectory, { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records the admin route's export statement line, not its JSDoc", () => {
        expect.assertions(2);

        const source = `
            declare const httpRoute: any;

            /** Purges the cache. */
            export const purge = httpRoute.post("/admin/purge").handler(async () => new Response("ok"));
        `;

        writeFile("admin.ts", source, true);

        const [route] = discoverAdminRoutes(newProject(), lunoraDirectory);

        expect(route?.line).toBe(lineOf(source, "export const purge"));
        expect(route?.file).toBe("admin");
    });

    it("records the procedure's export statement line, not its JSDoc", () => {
        expect.assertions(2);

        const source = `
            import { mutation } from "@lunora/server";

            /** Creates an account. */
            export const signUp = mutation({
                args: {},
                handler: async (ctx) => {
                    await ctx.db.insert("users", { name: "x" });
                },
            });
        `;

        writeFile("signup.ts", source, true);

        const [procedure] = discoverProcedureMiddleware(newProject(), lunoraDirectory);

        expect(procedure?.line).toBe(lineOf(source, "export const signUp"));
        expect(procedure?.file).toBe("signup");
    });

    it("records the RLS procedure's export statement line, not its JSDoc", () => {
        expect.assertions(2);

        const source = `
            import { query } from "@lunora/server";

            /** Lists documents. */
            export const listDocuments = query({
                args: {},
                handler: async (ctx) => ctx.db.query("documents").collect(),
            });
        `;

        writeFile("documents.ts", source, true);

        const [procedure] = discoverRlsProcedures(newProject(), lunoraDirectory);

        expect(procedure?.line).toBe(lineOf(source, "export const listDocuments"));
        expect(procedure?.file).toBe("documents");
    });

    it("records the shape's export statement line, not its JSDoc", () => {
        expect.assertions(2);

        const source = `
            import { defineShape } from "@lunora/server";

            /** The room's messages. */
            export const room = defineShape({ table: "messages", where: () => ({}) });
        `;

        writeFile("shapes.ts", source);

        const [shape] = discoverShapes(newProject(), workdir);

        expect(shape?.line).toBe(lineOf(source, "export const room"));
        expect(shape?.exportName).toBe("room");
    });

    it("records the container's export statement line and the containers module", () => {
        expect.assertions(3);

        const source = `
            import { defineContainer } from "@lunora/container";

            /** Transcodes uploads. */
            export const transcoder = defineContainer({
                image: "./containers/transcoder",
                defaultPort: 8080,
                instanceType: "standard-1",
                maxInstances: 5,
                sleepAfter: "5m",
            });
        `;

        writeFile("containers.ts", source);

        const [container] = discoverContainers(newProject(), workdir);

        expect(container?.line).toBe(lineOf(source, "export const transcoder"));
        expect(container?.file).toBe("containers");
        expect(container?.exportName).toBe("transcoder");
    });

    it("records the line of the statement that registers the cron job", () => {
        expect.assertions(3);

        const source = `
            import { cronJobs } from "@lunora/scheduler";
            import { internal } from "./_generated/internal.js";

            const crons = cronJobs();

            /** Clears expired presence. */
            crons.interval("clear presence", { minutes: 30 }, internal.presence.clear, {});
        `;

        writeFile("crons.ts", source, true);

        const [job] = discoverCrons(newProject(), lunoraDirectory);

        expect(job?.line).toBe(lineOf(source, 'crons.interval("clear presence"'));
        expect(job?.file).toBe("crons");
        expect(job?.name).toBe("clear presence");
    });

    it("records the queue's export statement line and the queues module", () => {
        expect.assertions(3);

        const source = `
            import { defineQueue } from "@lunora/queue";

            /** Sends outbound email. */
            export const emailQueue = defineQueue({ handler: async () => {} });
        `;

        writeFile("queues.ts", source);

        const [queue] = discoverQueues(newProject(), workdir);

        expect(queue?.line).toBe(lineOf(source, "export const emailQueue"));
        expect(queue?.filePath).toBe("queues");
        expect(queue?.exportName).toBe("emailQueue");
    });

    it("records the workflow's export statement line and the workflows module", () => {
        expect.assertions(3);

        const source = `
            import { defineWorkflow } from "@lunora/workflow";

            /** Runs the order pipeline. */
            export const orderPipeline = defineWorkflow({
                handler: async (ctx) => ctx.params,
            });
        `;

        writeFile("workflows.ts", source);

        const [workflow] = discoverWorkflows(newProject(), workdir);

        expect(workflow?.line).toBe(lineOf(source, "export const orderPipeline"));
        expect(workflow?.file).toBe("workflows");
        expect(workflow?.exportName).toBe("orderPipeline");
    });
});
