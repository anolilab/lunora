import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverWorkflows } from "../src/discover-workflows";
import { emitServer, emitShard, emitWorkflows } from "../src/emit";
import type { SchemaIR } from "../src/ir";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeWorkflows = (source: string): void => {
    writeFileSync(join(workdir, "workflows.ts"), source);
};

const EMPTY_SCHEMA: SchemaIR = { tables: [], vectorIndexes: [] };

describe("discover-workflows", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-workflow-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when lunora/workflows.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverWorkflows(newProject(), workdir)).toEqual([]);
    });

    it("lifts exported defineWorkflow declarations into IR, sorted by export name", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            export const orderPipeline = defineWorkflow({
                handler: async (ctx) => ctx.params,
            });

            export const etl = defineWorkflow({
                handler: async () => undefined,
                name: "nightly-etl",
            });
        `);

        expect(discoverWorkflows(newProject(), workdir)).toEqual([
            {
                bindingName: "WORKFLOW_ETL",
                className: "EtlWorkflow",
                exportName: "etl",
                name: "nightly-etl",
            },
            {
                bindingName: "WORKFLOW_ORDER_PIPELINE",
                className: "OrderPipelineWorkflow",
                exportName: "orderPipeline",
                name: "order-pipeline",
            },
        ]);
    });

    it("ignores non-defineWorkflow exports and unexported definitions", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            export const notAWorkflow = { handler: async () => undefined };
            const internalOnly = defineWorkflow({ handler: async () => undefined });
            export const cleanup = defineWorkflow({ handler: async () => undefined });
        `);

        expect(discoverWorkflows(newProject(), workdir).map((workflow) => workflow.exportName)).toEqual(["cleanup"]);
    });

    it("resolves an aliased defineWorkflow import", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow as dw } from "@lunora/workflow";

            export const cleanup = dw({ handler: async () => undefined });
        `);

        expect(discoverWorkflows(newProject(), workdir).map((workflow) => workflow.className)).toEqual(["CleanupWorkflow"]);
    });

    it("rejects a non-literal name with a located diagnostic", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";
            const label = "nightly";
            export const etl = defineWorkflow({ handler: async () => undefined, name: label });
        `);

        expect(() => discoverWorkflows(newProject(), workdir)).toThrow("`name` must be a static string literal");
    });
});

describe("emit (workflows)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-workflow-emit-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const discover = (): ReturnType<typeof discoverWorkflows> => {
        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";
            export const orderPipeline = defineWorkflow({ handler: async (ctx) => ctx.params });
        `);

        return discoverWorkflows(newProject(), workdir);
    };

    it("emitWorkflows renders one thin WorkflowEntrypoint class per definition", () => {
        expect.assertions(6);

        const content = emitWorkflows(discover());

        expect(content).toContain('import LunoraWorkflow from "@lunora/workflow/do";');
        expect(content).toContain('import { orderPipeline } from "../workflows.js";');

        expect(content).toContain(
            // eslint-disable-next-line no-secrets/no-secrets -- asserting on dense generated TS, not a credential
            "export class OrderPipelineWorkflow extends LunoraWorkflow<WorkflowParamsOf<typeof orderPipeline>, WorkflowOutputOf<typeof orderPipeline>> {",
        );
        expect(content).toContain('super(ctx, env, orderPipeline, "orderPipeline");');
        // eslint-disable-next-line no-secrets/no-secrets -- asserting on dense generated TS, not a credential
        expect(content).toContain("type WorkflowParamsOf<Definition>");
        expect(content).toContain("Re-export them from your worker entry");
    });

    it('emitWorkflows returns "" without workflows', () => {
        expect.assertions(1);

        expect(emitWorkflows([])).toBe("");
    });

    it("emitServer types ctx.workflows on Mutation/Action only when workflows exist", () => {
        expect.assertions(5);

        const withWorkflows = emitServer({ schema: EMPTY_SCHEMA, workflows: discover() });

        expect(withWorkflows).toContain('import type { WorkflowHandle } from "@lunora/workflow";');
        expect(withWorkflows).toContain("export interface LunoraWorkflows {");
        expect(withWorkflows).toContain('get(name: "orderPipeline"): WorkflowHandle<');
        expect(withWorkflows).toContain("readonly workflows: LunoraWorkflows;");

        expect(emitServer({ schema: EMPTY_SCHEMA })).not.toContain("LunoraWorkflows");
    });

    it("emitShard wires createWorkflowContext into the built ctx", () => {
        expect.assertions(4);

        const shard = emitShard({ schema: EMPTY_SCHEMA, workflows: discover() });

        expect(shard).toContain('import { createWorkflowContext } from "@lunora/workflow";');
        expect(shard).toContain('{ binding: "WORKFLOW_ORDER_PIPELINE", exportName: "orderPipeline" },');
        expect(shard).toContain("const workflows = createWorkflowContext(env, LUNORA_WORKFLOWS);");
        expect(shard).toContain("workflows,");
    });

    it("emitShard stays workflow-free without definitions", () => {
        expect.assertions(1);

        expect(emitShard({ schema: EMPTY_SCHEMA })).not.toContain("LUNORA_WORKFLOWS");
    });
});
