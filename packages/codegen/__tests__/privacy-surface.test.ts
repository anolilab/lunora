import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

/**
 * Plan 468 §4.2: the whole privacy surface an app wires up, as codegen sees it.
 * The package ships declarations only, so every handler and the privacy object
 * come from `.d.ts`. The app declares its mutations, its internal tick target,
 * and its two workflows as builder calls and a literal config, and codegen must
 * register each one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;

const PACKAGE_DECLARATIONS = `
export type Ctx = { params: { requestId: string; subjectId: string }; step: { do: <T>(name: string, run: () => Promise<T>) => Promise<T>; sleepUntil: (name: string, when: Date) => Promise<void> } };
export declare const privacy: {
    handlers: {
        requestExport: (ctx: { params: { subjectId: string } }) => Promise<unknown>;
        requestErasure: (ctx: { params: { subjectId: string; sessionAgeMs: number } }) => Promise<unknown>;
        cancelRequest: (ctx: { params: { requestId: string } }) => Promise<unknown>;
        myRequests: (ctx: unknown) => Promise<unknown>;
        downloadUrl: (ctx: { params: { requestId: string; subjectId: string } }) => Promise<unknown>;
        tick: (ctx: unknown) => Promise<unknown>;
    };
    workflows: {
        exportHandler: (ctx: Ctx) => Promise<void>;
        erasureHandler: (ctx: Ctx) => Promise<void>;
    };
};
`;

const writePackage = (): void => {
    const directory = join(workdir, "node_modules", "@lunora", "privacy-fixture");

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@lunora/privacy-fixture", types: "index.d.ts", main: "index.js", type: "module" }));
    writeFileSync(join(directory, "index.d.ts"), PACKAGE_DECLARATIONS);
    writeFileSync(join(directory, "index.js"), "export {};\n");
};

describe("the privacy surface in an app", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-privacy-surface-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writePackage();
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("registers every mutation, query and internal function the app declares", () => {
        expect.assertions(6);

        writeFileSync(
            join(workdir, "lunora", "privacy-api.ts"),
            [
                `import { internalMutation, mutation, query, v } from "@lunora/server";`,
                `import { privacy } from "@lunora/privacy-fixture";`,
                ``,
                `export const requestExport = mutation({ args: { subjectId: v.string() }, handler: privacy.handlers.requestExport });`,
                `export const requestErasure = mutation({ args: { subjectId: v.string(), sessionAgeMs: v.number() }, handler: privacy.handlers.requestErasure });`,
                `export const cancelRequest = mutation({ args: { requestId: v.string() }, handler: privacy.handlers.cancelRequest });`,
                `export const myRequests = query({ args: {}, handler: privacy.handlers.myRequests });`,
                `export const downloadUrl = query({ args: { requestId: v.string(), subjectId: v.string() }, handler: privacy.handlers.downloadUrl });`,
                `export const privacyTick = internalMutation({ args: {}, handler: privacy.handlers.tick });`,
                ``,
            ].join("\n"),
        );

        runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });
        const api = readFileSync(join(workdir, "lunora", "_generated", "api.ts"), "utf8");
        const internal = readFileSync(join(workdir, "lunora", "_generated", "internal.ts"), "utf8");

        for (const name of ["requestExport", "requestErasure", "cancelRequest", "myRequests", "downloadUrl"]) {
            expect(api).toContain(name);
        }

        // Internal functions are generated into internal.ts, not the public api.
        expect(internal).toContain("privacyTick");
    });

    it("registers both durable workflows from literal configs that name the package's handlers", () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "lunora", "workflows.ts"),
            [
                `import { defineWorkflow } from "@lunora/workflow";`,
                `import { privacy } from "@lunora/privacy-fixture";`,
                ``,
                `export const privacyExport = defineWorkflow({ handler: privacy.workflows.exportHandler, limits: { steps: 25000 }, name: "privacy-export" });`,
                `export const privacyErasure = defineWorkflow({ handler: privacy.workflows.erasureHandler, limits: { steps: 25000 }, name: "privacy-erasure" });`,
                ``,
            ].join("\n"),
        );

        runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });
        const generated = readFileSync(join(workdir, "lunora", "_generated", "workflows.ts"), "utf8");

        expect(generated).toContain("export class PrivacyExportWorkflow");
        expect(generated).toContain("export class PrivacyErasureWorkflow");
    });

    it("schedules the deadline sweep as a daily cron on the internal tick", () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "lunora", "privacy-api.ts"),
            [
                `import { internalMutation } from "@lunora/server";`,
                `import { privacy } from "@lunora/privacy-fixture";`,
                ``,
                `export const privacyTick = internalMutation({ args: {}, handler: privacy.handlers.tick });`,
                ``,
            ].join("\n"),
        );
        writeFileSync(
            join(workdir, "lunora", "crons.ts"),
            [
                `import { cronJobs } from "lunorash/server";`,
                ``,
                `import { internal } from "./_generated/internal.js";`,
                ``,
                `const crons = cronJobs();`,
                ``,
                `crons.daily("privacy deadlines", { hourUTC: 6, minuteUTC: 0 }, internal.privacyApi.privacyTick, {});`,
                ``,
                `export default crons;`,
                ``,
            ].join("\n"),
        );

        runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });
        const cronsOutput = readFileSync(join(workdir, "lunora", "_generated", "crons.ts"), "utf8");

        expect(cronsOutput).toContain("LUNORA_CRON_TRIGGERS");
        expect(cronsOutput).toContain("0 6 * * *");
    });
});
