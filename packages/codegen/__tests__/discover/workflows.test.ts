import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverWorkflows } from "../../src/discover/workflows";
import { emitServer, emitShard, emitWorkflows } from "../../src/emit";
import type { SchemaIR } from "../../src/ir";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeWorkflows = (source: string): void => {
    writeFileSync(join(workdir, "workflows.ts"), source);
};

const EMPTY_SCHEMA: SchemaIR = { tables: [], vectorIndexes: [] };

describe("discover/workflows", () => {
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
                steps: [],
            },
            {
                bindingName: "WORKFLOW_ORDER_PIPELINE",
                className: "OrderPipelineWorkflow",
                exportName: "orderPipeline",
                name: "order-pipeline",
                steps: [],
            },
        ]);
    });

    it("resolves a config passed through a local const", () => {
        expect.assertions(3);

        // The scan matched only an inline object literal, so
        // passing a typed `WorkflowConfig` variable was rejected — but that is
        // exactly what you reach for once the handlers grow, since putting three
        // 100-line handlers in the registry file is worse code.
        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            const config = {
                name: "order-pipeline",
                handler: async (ctx) => {
                    await ctx.step.do("charge", async () => 1);

                    return ctx.params;
                },
            };

            export const orderPipeline = defineWorkflow(config);
        `);

        const [workflow] = discoverWorkflows(newProject(), workdir);

        expect(workflow?.exportName).toBe("orderPipeline");
        // The declared `name` is read through the hop — registering the default
        // instead would make `ctx.workflows.get("order-pipeline")` throw at runtime.
        expect(workflow?.name).toBe("order-pipeline");
        expect(workflow?.steps.map((step) => step.name)).toStrictEqual(["charge"]);
    });

    it("still fails loudly when the config cannot be read statically", () => {
        expect.assertions(1);

        // One local hop, deliberately. A config assembled by a call cannot be
        // read, and silently registering it under the default name would make a
        // `ctx.workflows.get("<declared name>")` throw with nothing pointing here.
        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            const build = () => ({ handler: async (ctx) => ctx.params });

            export const orderPipeline = defineWorkflow(build());
        `);

        expect(() => discoverWorkflows(newProject(), workdir)).toThrow(/must be an object literal, or a local `const` holding one/u);
    });

    it("lifts the durable step labels from the handler body", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            export const orderPipeline = defineWorkflow({
                handler: async (ctx) => {
                    const order = await ctx.step.do("load", () => ctx.run(api.orders.get, {}));
                    await ctx.step.sleep("cool-off", "1 minute");
                    await ctx.step.do("charge", () => ctx.run(api.payments.charge, {}));
                    return order;
                },
            });
        `);

        expect(discoverWorkflows(newProject(), workdir)[0]?.steps).toEqual([
            { line: 6, method: "do", name: "load" },
            { line: 7, method: "sleep", name: "cool-off" },
            { line: 8, method: "do", name: "charge" },
        ]);
    });

    it("resolves a destructured step and omits dynamically-named steps", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            export const fanOut = defineWorkflow({
                handler: async (ctx) => {
                    const { step } = ctx;
                    await step.do("seed", () => undefined);
                    for (const id of ctx.params.ids) {
                        await step.do(\`process-\${id}\`, () => undefined);
                    }
                },
            });
        `);

        // The template-with-substitution name is not statically comparable, so it
        // is omitted — only the literal "seed" survives.
        expect(discoverWorkflows(newProject(), workdir)[0]?.steps).toEqual([{ line: 7, method: "do", name: "seed" }]);
    });

    it("omits the framework-minted step names of ctx.runStep and ctx.waitForEvent", () => {
        expect.assertions(1);

        // The documented scope boundary of the advisor's duplicate-step-name lint,
        // made executable. `ctx.runStep(stepDef)` resolves its durable step name to
        // `options?.name ?? step.name` and `ctx.waitForEvent(eventDef)` to
        // `options?.name ?? \`event:\${event.type}\``, both from a definition in
        // another file — the receiver here is `ctx`, not `.step`, so neither
        // reaches the feeder and neither can reach the lint. That is affordable
        // rather than a hole: the engine caches a step under its name AND its
        // occurrence number within the run, so a repeated wait gets occurrence 2
        // and genuinely waits instead of replaying the first payload.
        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";
            import { chargeStep } from "./steps";
            import { orderApproved } from "./events";

            export const approvals = defineWorkflow({
                handler: async (ctx) => {
                    await ctx.step.do("open", () => undefined);
                    await ctx.waitForEvent(orderApproved);
                    await ctx.runStep(chargeStep, {});
                    await ctx.waitForEvent(orderApproved);
                },
            });
        `);

        expect(discoverWorkflows(newProject(), workdir)[0]?.steps).toEqual([{ line: 8, method: "do", name: "open" }]);
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

    it("discovers a defineWorkflow initializer wrapped in satisfies/as/parens (CODEGEN-02)", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow, type WorkflowDefinition } from "@lunora/workflow";

            export const viaSatisfies = defineWorkflow({ handler: async () => undefined }) satisfies WorkflowDefinition;
            export const viaAs = defineWorkflow({ handler: async () => undefined }) as WorkflowDefinition;
            export const viaParens = (defineWorkflow({ handler: async () => undefined }));
        `);

        expect(discoverWorkflows(newProject(), workdir).map((workflow) => workflow.exportName)).toEqual(["viaAs", "viaParens", "viaSatisfies"]);
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

    it("rejects two workflows that deploy under the same name", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            export const first = defineWorkflow({ name: "shared", handler: async () => undefined });
            export const second = defineWorkflow({ name: "shared", handler: async () => undefined });
        `);

        expect(() => discoverWorkflows(newProject(), workdir)).toThrow(/Duplicate workflow name "shared"/u);
    });

    it("rejects two workflow exports that collapse to the same binding name", () => {
        expect.assertions(1);

        writeWorkflows(`
            import { defineWorkflow } from "@lunora/workflow";

            export const myFlow = defineWorkflow({ name: "one", handler: async () => undefined });
            export const myFLOW = defineWorkflow({ name: "two", handler: async () => undefined });
        `);

        expect(() => discoverWorkflows(newProject(), workdir)).toThrow(/Duplicate workflow binding "WORKFLOW_MY_FLOW"/u);
    });
});
