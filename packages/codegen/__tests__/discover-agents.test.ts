import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentComponent } from "@lunora/agent";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAgents } from "../src/discover-agents";
import { emitAgents, emitApi, emitFunctions, emitServer, emitShard } from "../src/emit";
import type { FunctionIR, SchemaIR } from "../src/ir";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeAgents = (source: string): void => {
    writeFileSync(join(workdir, "agents.ts"), source);
};

/** Write a one-agent `agents.ts` and discover it (shared by the emit suites). */
const discoverSupportAgent = (): ReturnType<typeof discoverAgents> => {
    writeAgents(`
        import { defineAgent } from "@lunora/agent";
        export const support = defineAgent({ model: "m" });
    `);

    return discoverAgents(newProject(), workdir);
};

const EMPTY_SCHEMA: SchemaIR = { tables: [], vectorIndexes: [] };

describe("discover-agents", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-agent-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when lunora/agents.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverAgents(newProject(), workdir)).toEqual([]);
    });

    it("lifts exported defineAgent declarations into IR, sorted by export name", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";

            export const support = defineAgent({ instructions: "help", model: "m" });

            export const billing = defineAgent({ instructions: "bill", model: "m", name: "billing-bot" });
        `);

        expect(discoverAgents(newProject(), workdir)).toEqual([
            {
                bindingName: "AGENT_BILLING",
                className: "BillingAgentWorkflow",
                exportName: "billing",
                name: "billing-bot",
            },
            {
                bindingName: "AGENT_SUPPORT",
                className: "SupportAgentWorkflow",
                exportName: "support",
                name: "agent-support",
            },
        ]);
    });

    it("derives SNAKE binding and kebab name from a camelCase export", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            export const supportBot = defineAgent({ model: "m" });
        `);

        expect(discoverAgents(newProject(), workdir)[0]).toEqual({
            bindingName: "AGENT_SUPPORT_BOT",
            className: "SupportBotAgentWorkflow",
            exportName: "supportBot",
            name: "agent-support-bot",
        });
    });

    it("ignores the destructured runtime-function re-export in the same file", () => {
        expect.assertions(1);

        // `agentComponent().functions` is a property access, not a defineAgent
        // call — discovery lifts only the `defineAgent` export, never the
        // component functions the app re-exports for the `agents:*` namespace.
        writeAgents(`
            import { agentComponent, defineAgent } from "@lunora/agent";

            export const support = defineAgent({ model: "m" });
            export const { agentAppendMessage, agentEnsureThread, agentMessages, agentPatchThread, agentThread } = agentComponent().functions;
        `);

        expect(discoverAgents(newProject(), workdir).map((agent) => agent.exportName)).toEqual(["support"]);
    });

    it("ignores non-defineAgent exports and unexported definitions", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";

            export const notAnAgent = { model: "m" };
            const internalOnly = defineAgent({ model: "m" });
            export const support = defineAgent({ model: "m" });
        `);

        expect(discoverAgents(newProject(), workdir).map((agent) => agent.exportName)).toEqual(["support"]);
    });

    it("resolves an aliased defineAgent import", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent as da } from "@lunora/agent";

            export const support = da({ model: "m" });
        `);

        expect(discoverAgents(newProject(), workdir).map((agent) => agent.className)).toEqual(["SupportAgentWorkflow"]);
    });

    it("rejects a non-literal name with a located diagnostic", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            const label = "support";
            export const support = defineAgent({ model: "m", name: label });
        `);

        expect(() => discoverAgents(newProject(), workdir)).toThrow("`name` must be a static string literal");
    });
});

describe("emit (agents)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-agent-emit-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("emitAgents renders one WorkflowEntrypoint class per definition", () => {
        expect.assertions(5);

        const content = emitAgents(discoverSupportAgent());

        expect(content).toContain('import LunoraWorkflow from "@lunora/workflow/do";');
        expect(content).toContain('import { compileAgentWorkflow } from "@lunora/agent";');
        expect(content).toContain('import { support } from "../agents.js";');
        expect(content).toContain("export class SupportAgentWorkflow extends LunoraWorkflow<AgentRunInput, AgentRunResult> {");
        expect(content).toContain('super(ctx, env, compileAgentWorkflow(support, "support"), "support");');
    });

    it('emitAgents returns "" without agents', () => {
        expect.assertions(1);

        expect(emitAgents([])).toBe("");
    });

    it("emitServer types ctx.agents on Mutation/Action only when agents exist", () => {
        expect.assertions(5);

        const withAgents = emitServer({ agents: discoverSupportAgent(), schema: EMPTY_SCHEMA });

        expect(withAgents).toContain('import type { AgentHandle } from "@lunora/agent";');
        expect(withAgents).toContain("export interface LunoraAgents {");
        expect(withAgents).toContain("readonly support: AgentHandle;");
        // The field lands on BOTH MutationCtx and ActionCtx.
        expect(withAgents.match(/readonly agents: LunoraAgents;/g)).toHaveLength(2);

        expect(emitServer({ schema: EMPTY_SCHEMA })).not.toContain("LunoraAgents");
    });

    it("emitServer narrows the AGENT_* env binding when agents exist", () => {
        expect.assertions(2);

        expect(emitServer({ agents: discoverSupportAgent(), schema: EMPTY_SCHEMA })).toContain("readonly AGENT_SUPPORT?: unknown;");
        expect(emitServer({ schema: EMPTY_SCHEMA })).not.toContain("AGENT_SUPPORT");
    });

    it("emitShard wires createAgentContext into the built ctx", () => {
        expect.assertions(4);

        const shard = emitShard({ agents: discoverSupportAgent(), schema: EMPTY_SCHEMA });

        expect(shard).toContain('import { createAgentContext } from "@lunora/agent";');
        expect(shard).toContain('{ binding: "AGENT_SUPPORT", exportName: "support" },');
        expect(shard).toContain("const agents = createAgentContext(env, LUNORA_AGENTS);");
        expect(shard).toContain("agents,");
    });

    it("emitShard stays agent-free without definitions", () => {
        expect.assertions(1);

        expect(emitShard({ schema: EMPTY_SCHEMA })).not.toContain("LUNORA_AGENTS");
    });
});

describe("auto-registered agent runtime functions", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-agent-auto-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    /** A minimal app-registered function under the `agents` namespace. */
    const appAgentsFunction = (exportName: string): FunctionIR => {
        return { args: {}, exportName, filePath: "agents", kind: "query", returnType: "unknown" };
    };

    it("registers the runtime functions in the dispatch table, imported from @lunora/agent", () => {
        expect.assertions(8);

        const content = emitFunctions([], [], false, [], [], discoverSupportAgent());

        expect(content).toContain('import { agentComponent } from "@lunora/agent";');
        expect(content).toContain("const lunoraAgentRuntimeFunctions = agentComponent().functions;");

        for (const name of ["agentAppendMessage", "agentEnsureThread", "agentMessages", "agentPatchThread", "agentThread"]) {
            expect(content).toContain(`"agents:${name}": lunoraAgentRuntimeFunctions.${name} as unknown as RegisteredLunoraFunction,`);
        }

        expect(emitFunctions([])).not.toContain("@lunora/agent");
    });

    it("lets an app-registered agents:* function win over auto-registration", () => {
        expect.assertions(2);

        const content = emitFunctions([appAgentsFunction("agentMessages")], [], false, [], [], discoverSupportAgent());

        expect(content).not.toContain("lunoraAgentRuntimeFunctions.agentMessages");
        expect(content).toContain("lunoraAgentRuntimeFunctions.agentThread");
    });

    it("exposes the public thread queries as typed api references", () => {
        expect.assertions(4);

        const content = emitApi([], [], false, discoverSupportAgent());

        expect(content).toContain('agentMessages: FunctionReference<"query", { key: string; limit?: number }, Record<string, unknown>[]>;');
        expect(content).toContain('agentThread: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;');
        // The internal mutations never surface on the api objects.
        expect(content).not.toContain("agentAppendMessage");
        expect(emitApi([])).not.toContain("agentMessages");
    });

    it("does not duplicate an api member the app already registered", () => {
        expect.assertions(1);

        const content = emitApi([appAgentsFunction("agentMessages")], [], false, discoverSupportAgent());

        expect(content.match(/agentMessages: FunctionReference/gu)).toHaveLength(1);
    });

    it("stays in sync with the runtime component (drift guard)", () => {
        expect.assertions(3);

        const content = emitFunctions([], [], false, [], [], discoverSupportAgent());
        const emitted = [...content.matchAll(/"agents:(?<name>\w+)":/gu)]
            .map((match) => match.groups?.name)
            .toSorted((a, b) => String(a).localeCompare(String(b)));
        const runtime = agentComponent().functions;

        // Every runtime component function is auto-registered, and nothing else —
        // adding/removing/renaming a function in @lunora/agent must fail here
        // until codegen's AGENT_RUNTIME_FUNCTION_NAMES list is updated.
        expect(emitted).toStrictEqual(Object.keys(runtime).toSorted((a, b) => a.localeCompare(b)));

        // The loop dispatches the mutations over the admin channel (internal);
        // the queries are the public client surface.
        expect(
            Object.entries(runtime)
                .filter(([, definition]) => definition.visibility === "internal")
                .map(([name]) => name)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["agentAppendMessage", "agentEnsureThread", "agentPatchThread"]);
        expect(
            Object.entries(runtime)
                .filter(([, definition]) => definition.visibility === undefined)
                .map(([name]) => name)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["agentMessages", "agentThread"]);
    });
});
