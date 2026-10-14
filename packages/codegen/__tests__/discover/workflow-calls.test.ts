import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverWorkflowCalls from "../../src/discover/workflow-calls";
import { markerLine, scopeName } from "../call-site-fixture";

const CHANNELS = `
    import { mutation } from "@lunora/server";

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

    // Not exported and never referenced — kept with exportName "".
    const helper = (ctx) => ctx.workflows.get("secret"); // @secret

    // Referenced from an export — attributed to it.
    const welcome = (ctx) => ctx.workflows.get("channelWelcome"); // @welcome
    export const rejoin = mutation({ args: {}, handler: (ctx) => welcome(ctx) });
`;

let workdir: string;
let project: Project;

describe("discoverWorkflowCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-wf-calls-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "channels.ts"), CHANNELS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("attributes each workflow get call to its exported function and file", () => {
        expect.assertions(2);

        const calls = discoverWorkflowCalls(project, join(workdir, "lunora")).map(({ file, scope, workflow }) => {
            return { file, scope, workflow };
        });

        // Conventional + assigned-to-const both attribute correctly.
        expect(calls).toContainEqual({ file: "channels", scope: { kind: "export", name: "create" }, workflow: "channelWelcome" });
        expect(calls).toContainEqual({ file: "channels", scope: { kind: "export", name: "restart" }, workflow: "channelWelcome" });
    });

    it("records a non-literal name argument as an empty workflow", () => {
        expect.assertions(1);

        const dynamic = discoverWorkflowCalls(project, join(workdir, "lunora")).find((call) => scopeName(call.scope) === "dynamic");

        expect(dynamic).toMatchObject({ workflow: "" });
    });

    it("ignores `.get(...)` calls whose receiver isn't `workflows`", () => {
        expect.assertions(1);

        const calls = discoverWorkflowCalls(project, join(workdir, "lunora"));

        expect(calls.some((call) => scopeName(call.scope) === "headers")).toBe(false);
    });

    it("keeps a call in a helper no export calls, scoped to the helper with no callers", () => {
        expect.assertions(1);

        const calls = discoverWorkflowCalls(project, join(workdir, "lunora")).filter((call) => call.workflow === "secret");

        expect(calls).toStrictEqual([
            { file: "channels", line: markerLine(CHANNELS, "secret"), scope: { callers: [], kind: "helper", name: "helper" }, workflow: "secret" },
        ]);
    });

    it("scopes a call in a helper to the helper and the export calling it", () => {
        expect.assertions(1);

        const calls = discoverWorkflowCalls(project, join(workdir, "lunora"));

        expect(calls).toContainEqual({
            file: "channels",
            line: markerLine(CHANNELS, "welcome"),
            scope: { callers: ["rejoin"], kind: "helper", name: "welcome" },
            workflow: "channelWelcome",
        });
    });
});
