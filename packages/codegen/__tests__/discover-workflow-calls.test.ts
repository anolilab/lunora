import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverWorkflowCalls from "../src/discover-workflow-calls";

const CHANNELS = `
    import { mutation } from "@cirrus/server";

    const dynamicName = "channelWelcome";

    // Conventional name.
    export const create = mutation({
        args: {},
        handler: async (ctx) => {
            const id = await ctx.db.insert("channels", { name: "general" });
            await ctx.workflows.get("channelWelcome").create({ params: { channelId: id } });
            return id;
        },
    });

    // The handle is assigned to a local const — still attributed to the export.
    export const restart = mutation({
        args: {},
        handler: async (ctx) => {
            const handle = ctx.workflows.get("channelWelcome");
            return handle;
        },
    });

    // Dynamic (non-literal) name — discovered but with workflow "".
    export const dynamic = mutation({ args: {}, handler: (ctx) => ctx.workflows.get(dynamicName) });

    // A read — not a workflow get.
    export const headers = mutation({ args: {}, handler: (ctx) => ctx.req.headers.get("x-token") });

    // Not exported — dropped.
    const helper = (ctx) => ctx.workflows.get("secret");
`;

let workdir: string;
let project: Project;

describe("discoverWorkflowCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-wf-calls-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "cirrus", "channels.ts"), CHANNELS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("attributes each workflow get call to its exported function and file", () => {
        expect.assertions(2);

        const calls = discoverWorkflowCalls(project, join(workdir, "cirrus")).map(({ exportName, file, workflow }) => {
            return { exportName, file, workflow };
        });

        // Conventional + assigned-to-const both attribute correctly.
        expect(calls).toContainEqual({ exportName: "create", file: "channels", workflow: "channelWelcome" });
        expect(calls).toContainEqual({ exportName: "restart", file: "channels", workflow: "channelWelcome" });
    });

    it("records a non-literal name argument as an empty workflow", () => {
        expect.assertions(1);

        const dynamic = discoverWorkflowCalls(project, join(workdir, "cirrus")).find((call) => call.exportName === "dynamic");

        expect(dynamic).toMatchObject({ workflow: "" });
    });

    it("ignores `.get(...)` calls whose receiver isn't `workflows`", () => {
        expect.assertions(1);

        const calls = discoverWorkflowCalls(project, join(workdir, "cirrus"));

        expect(calls.some((call) => call.exportName === "headers")).toBe(false);
    });

    it("drops calls that aren't inside an exported declaration", () => {
        expect.assertions(1);

        const calls = discoverWorkflowCalls(project, join(workdir, "cirrus"));

        expect(calls.some((call) => call.workflow === "secret")).toBe(false);
    });
});
