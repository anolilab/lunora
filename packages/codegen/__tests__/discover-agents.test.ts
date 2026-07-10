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

    it("tolerates a hand-written runtime-function re-export without lifting it", () => {
        expect.assertions(1);

        // Auto-registration makes this re-export unnecessary, but a user who
        // writes it anyway must not break discovery: the initializer is a
        // property access, not a defineAgent call, so only `support` is lifted.
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

    it("lifts the publicRun opt-in into IR only when the literal is true", () => {
        expect.assertions(2);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";

            export const opened = defineAgent({ model: "m", publicRun: true });
            export const closed = defineAgent({ model: "m", publicRun: false });
        `);

        const [closed, opened] = discoverAgents(newProject(), workdir);

        // A `true` literal sets the flag; `false` (like absent) leaves it off, so
        // the emitted spec stays byte-identical for a non-opted-in agent.
        expect(opened?.publicRun).toBe(true);
        expect(closed && "publicRun" in closed).toBe(false);
    });

    it("rejects a non-literal publicRun with a located diagnostic", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            const flag = true;
            export const support = defineAgent({ model: "m", publicRun: flag });
        `);

        expect(() => discoverAgents(newProject(), workdir)).toThrow("`publicRun` must be a static boolean literal");
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

    it("emits a VoiceSessionDO subclass only when the agent declares a voice block", () => {
        expect.assertions(7);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            export const support = defineAgent({ model: "m", voice: { greeting: "hi" } });
        `);

        const [agent] = discoverAgents(newProject(), workdir);

        expect(agent).toMatchObject({ voice: true, voiceBindingName: "VOICE_SUPPORT", voiceClassName: "SupportVoiceDO" });

        const content = emitAgents(discoverAgents(newProject(), workdir));

        expect(content).toContain('import { compileAgentWorkflow, VoiceSessionDO } from "@lunora/agent";');
        expect(content).toContain("export class SupportVoiceDO extends VoiceSessionDO {");
        expect(content).toContain('super(ctx, env, support, "support");');
        // The workflow class is still emitted alongside the voice DO.
        expect(content).toContain("export class SupportAgentWorkflow extends LunoraWorkflow<AgentRunInput, AgentRunResult> {");

        // A voice-free agent emits neither the import nor the DO class (byte-identical path).
        const voiceless = emitAgents(discoverSupportAgent());

        expect(voiceless).toContain('import { compileAgentWorkflow } from "@lunora/agent";');
        expect(voiceless).not.toContain("VoiceSessionDO");
    });

    it("rejects a non-object voice literal with a located diagnostic", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            export const support = defineAgent({ model: "m", voice: true });
        `);

        expect(() => discoverAgents(newProject(), workdir)).toThrow(/`voice` must be an inline object literal/u);
    });

    it("exposes agents.<name>Voice as a typed stream reference only for voice agents", () => {
        expect.assertions(2);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";
            export const support = defineAgent({ model: "m", voice: {} });
        `);

        const content = emitApi({ agents: discoverAgents(newProject(), workdir), functions: [] });

        expect(content).toContain('supportVoice: FunctionReference<"stream", { threadKey: string }, Record<string, unknown>>;');
        // A voice-free agent adds no Voice member.
        expect(emitApi({ agents: discoverSupportAgent(), functions: [] })).not.toContain("Voice");
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
        expect.assertions(12);

        const content = emitFunctions({ agents: discoverSupportAgent(), functions: [] });

        expect(content).toContain('import { agentComponent } from "@lunora/agent/component";');
        expect(content).toContain("const lunoraAgentRuntimeFunctions = agentComponent().functions;");

        for (const name of [
            "agentAppendMessage",
            "agentEnsureThread",
            "agentMessages",
            "agentPatchThread",
            "agentResolveApproval",
            "agentRun",
            "agentSetState",
            "agentState",
            "agentThread",
        ]) {
            expect(content).toContain(`"agents:${name}": lunoraAgentRuntimeFunctions.${name} as unknown as RegisteredLunoraFunction,`);
        }

        expect(emitFunctions({ functions: [] })).not.toContain("@lunora/agent");
    });

    it("lets an app-registered agents:* function win over auto-registration", () => {
        expect.assertions(2);

        const content = emitFunctions({ agents: discoverSupportAgent(), functions: [appAgentsFunction("agentMessages")] });

        expect(content).not.toContain("lunoraAgentRuntimeFunctions.agentMessages");
        expect(content).toContain("lunoraAgentRuntimeFunctions.agentThread");
    });

    it("exposes the public thread queries and approval mutation as typed api references", () => {
        expect.assertions(7);

        const content = emitApi({ agents: discoverSupportAgent(), functions: [] });

        expect(content).toContain('agentMessages: FunctionReference<"query", { key: string; limit?: number }, Record<string, unknown>[]>;');
        expect(content).toContain('agentState: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;');
        expect(content).toContain('agentThread: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;');
        expect(content).toContain(
            'agentResolveApproval: FunctionReference<"mutation", { decision: "approve" | "reject"; instanceId: string; note?: string; threadKey: string; toolCallId: string }, { resolved: boolean }>;',
        );
        expect(content).toContain(
            'agentRun: FunctionReference<"mutation", { agent: string; input: string; threadKey: string; title?: string }, { id: string; threadKey: string }>;',
        );
        // The internal thread-write mutations never surface on the api objects.
        expect(content).not.toContain("agentAppendMessage");
        expect(emitApi({ functions: [] })).not.toContain("agentMessages");
    });

    it("does not duplicate an api member the app already registered", () => {
        expect.assertions(1);

        const content = emitApi({ agents: discoverSupportAgent(), functions: [appAgentsFunction("agentMessages")] });

        expect(content.match(/agentMessages: FunctionReference/gu)).toHaveLength(1);
    });

    it("stays in sync with the runtime component (drift guard)", () => {
        expect.assertions(3);

        const content = emitFunctions({ agents: discoverSupportAgent(), functions: [] });
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
        ).toStrictEqual(["agentAppendMessage", "agentEnsureThread", "agentPatchThread", "agentSetState"]);
        expect(
            Object.entries(runtime)
                .filter(([, definition]) => definition.visibility === undefined)
                .map(([name]) => name)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["agentMessages", "agentResolveApproval", "agentRun", "agentState", "agentThread"]);
    });

    it("pins the synthetic api arg shapes to the runtime component (drift guard)", () => {
        expect.assertions(5);

        // The api types for the public queries are hand-pinned in
        // syntheticAgentApiFunctions (codegen cannot read a published package's
        // types) — at least the arg KEY SETS must match the runtime validators.
        // A type-level change still needs a manual mirror; see the KEEP IN SYNC
        // breadcrumbs in emit.ts and @lunora/agent's component.ts.
        const runtime = agentComponent().functions;

        expect(Object.keys(runtime.agentMessages.args as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["key", "limit"]);
        expect(Object.keys(runtime.agentState.args as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["key"]);
        expect(Object.keys(runtime.agentThread.args as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["key"]);
        expect(Object.keys(runtime.agentResolveApproval.args as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "decision",
            "instanceId",
            "note",
            "threadKey",
            "toolCallId",
        ]);
        expect(Object.keys(runtime.agentRun.args as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "agent",
            "input",
            "threadKey",
            "title",
        ]);
    });
});
