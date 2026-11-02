import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "esbuild";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { emitAgents, emitWorkflows } from "../src/emit";
import type { AgentIR, WorkflowIR } from "../src/ir";

/**
 * With the lazy registry the generated `WorkflowEntrypoint` classes stay exported (wrangler binds
 * `class_name` at upload) but hand `LunoraWorkflow` a loader, so `lunora/workflows.ts`,
 * `lunora/agents.ts` and the `@lunora/agent` barrel evaluate on the first `run`, not at startup.
 * Bundled the way wrangler bundles a Worker, with recording stubs, so the assertions cover
 * evaluation order rather than text.
 */

interface Trace {
    agentPackageEvaluated: boolean;
    agentsEvaluated: boolean;
    workflowsLoaded: boolean;
}

const scratch = mkdtempSync(join(tmpdir(), "lunora-emit-lazy-entrypoints-"));

const STUBS: Record<string, string> = {
    "../agents.js": `globalThis.entryTrace.agentsEvaluated = true; export const support = { name: "support" };`,
    "../workflows.js": `globalThis.entryTrace.workflowsLoaded = true; export const orderPipeline = { name: "order" };`,
    "@lunora/agent": `globalThis.entryTrace.agentPackageEvaluated = true; export const compileAgentWorkflow = (definition, exportName) => ({ compiled: definition, exportName });`,
    "@lunora/workflow/do": `export default class LunoraWorkflow { constructor(ctx, env, definition, exportName) { this.definition = definition; this.exportName = exportName; } }`,
};

const stubs: Plugin = {
    name: "generated-entrypoint-stubs",
    setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /.*/ }, (arguments_) => (arguments_.path in STUBS ? { namespace: "stub", path: arguments_.path } : undefined));
        pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (arguments_) => {
            return { contents: STUBS[arguments_.path], loader: "js" };
        });
    },
};

type EntrypointClass = new (ctx: unknown, env: unknown) => { definition: unknown; exportName: string };

const load = async (source: string): Promise<{ module: Record<string, EntrypointClass>; trace: Trace }> => {
    const trace: Trace = { agentPackageEvaluated: false, agentsEvaluated: false, workflowsLoaded: false };
    const outfile = join(scratch, `entry-${randomUUID()}.mjs`);

    (globalThis as { entryTrace?: Trace }).entryTrace = trace;

    await build({
        bundle: true,
        format: "esm",
        logLevel: "silent",
        outfile,
        platform: "neutral",
        plugins: [stubs],
        stdin: { contents: source, loader: "ts", resolveDir: scratch },
    });

    return { module: (await import(pathToFileURL(outfile).href)) as Record<string, EntrypointClass>, trace };
};

const WORKFLOWS: WorkflowIR[] = [{ className: "OrderPipelineWorkflow", exportName: "orderPipeline", name: "order-pipeline", steps: [] }];
const AGENTS: AgentIR[] = [{ className: "SupportAgentWorkflow", exportName: "support", name: "agent-support" }];

describe("lazy workflow and agent entrypoints", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
        delete (globalThis as { entryTrace?: Trace }).entryTrace;
    });

    it("keeps the eager workflow shape without the lazy option", () => {
        expect.assertions(2);

        const content = emitWorkflows(WORKFLOWS);

        expect(content).toContain('import { orderPipeline } from "../workflows.js";');
        expect(content).toContain('super(ctx, env, orderPipeline, "orderPipeline");');
    });

    it("exports the workflow class but loads lunora/workflows.ts when a run resolves the definition", async () => {
        expect.assertions(4);

        const content = emitWorkflows(WORKFLOWS, { lazy: true });

        expect(content).toContain('import type { orderPipeline } from "../workflows.js";');

        const { module, trace } = await load(content);
        const entrypoint = new module.OrderPipelineWorkflow!({}, {});

        expect(trace.workflowsLoaded).toBe(false);
        await expect((entrypoint.definition as () => Promise<unknown>)()).resolves.toStrictEqual({ name: "order" });
        expect(trace.workflowsLoaded).toBe(true);
    });

    it("loads lunora/agents.ts and the @lunora/agent barrel when an agent run resolves its workflow", async () => {
        expect.assertions(4);

        const { module, trace } = await load(emitAgents(AGENTS, { lazy: true }));
        const entrypoint = new module.SupportAgentWorkflow!({}, {});

        expect(trace.agentsEvaluated).toBe(false);
        expect(trace.agentPackageEvaluated).toBe(false);
        await expect((entrypoint.definition as () => Promise<unknown>)()).resolves.toStrictEqual({ compiled: { name: "support" }, exportName: "support" });
        expect(trace.agentsEvaluated && trace.agentPackageEvaluated).toBe(true);
    });

    it("keeps agents eager when one is voice-enabled, whose session DO reads the definition in its constructor", () => {
        expect.assertions(2);

        const content = emitAgents([{ ...AGENTS[0]!, voice: true, voiceBindingName: "VOICE_SUPPORT", voiceClassName: "SupportVoiceDO" }], { lazy: true });

        expect(content).toBe(emitAgents([{ ...AGENTS[0]!, voice: true, voiceBindingName: "VOICE_SUPPORT", voiceClassName: "SupportVoiceDO" }]));
        expect(content).toContain('import { support } from "../agents.js";');
    });
});
