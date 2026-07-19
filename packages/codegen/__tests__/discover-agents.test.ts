import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentComponent } from "@lunora/agent";
import { Project, SyntaxKind } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAgents } from "../src/discover-agents";
import { emitAgents, emitApi, emitFunctions, emitServer, emitShard } from "../src/emit";
import type { FunctionIR, SchemaIR } from "../src/ir";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

/**
 * The monorepo-relative path to the `@lunora/agent` runtime component SOURCE
 * (not the built `dist`, which type-erases every function's return shape onto
 * the opaque `AgentRegisteredFunction` — see `component-shared.ts`). Reading
 * the source syntactically (no type-checker pass needed) is the only way to
 * recover each public function's declared return type for the drift guard
 * below.
 */
const AGENT_COMPONENT_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "src", "component.ts");

/**
 * Read `const &lt;constantName> = query|mutation.input({...}).query|mutation(async (...): Promise&lt;T> => ...)`'s
 * declared return-type text out of `component.ts`, unwrapped of its outer
 * `Promise&lt;…>` — mirroring codegen's own Promise-unwrap convention
 * (`unwrapHandlerReturn` in `discover-functions.ts`) so the comparison lines up
 * with what `syntheticAgentApiFunctions` hand-pins in `emit.ts`.
 */
const sourceReturnTypeOf = (constantName: string): string => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    const source = project.addSourceFileAtPath(AGENT_COMPONENT_SOURCE_PATH);
    // `getVariableDeclaration` only searches the source file's TOP-LEVEL
    // statements — `agentMessages` et al. are declared inside the
    // `agentComponent()` function body, so the declaration must be found by
    // walking every descendant instead.
    const declaration = source.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((candidate) => candidate.getName() === constantName);

    if (!declaration) {
        throw new Error(`test: expected to find a variable declaration named "${constantName}" in component.ts`);
    }

    const typedArrows = declaration.getDescendantsOfKind(SyntaxKind.ArrowFunction).filter((arrow) => arrow.getReturnTypeNode() !== undefined);

    if (typedArrows.length !== 1) {
        throw new Error(`test: expected exactly one typed handler arrow for "${constantName}", found ${String(typedArrows.length)}`);
    }

    const returnTypeText = typedArrows[0]!.getReturnTypeNodeOrThrow().getText();
    const promisePrefix = "Promise<";

    return returnTypeText.startsWith(promisePrefix) && returnTypeText.endsWith(">") ? returnTypeText.slice(promisePrefix.length, -1) : returnTypeText;
};

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

/** Canonical, comparable shape of a `v.*` validator used as an agent-function arg. */
interface ArgShape {
    kind: string;
    literals?: unknown[];
    optional: boolean;
}

/**
 * Reduce a runtime `v.*` validator to its {@link ArgShape} by reading the same
 * `kind` + `_meta` surface codegen's IR mirrors (`inner` for `optional`,
 * `members`/`value` for `union`/`literal`). Lets the drift guard compare the
 * runtime component's validators against the shape emit.ts hand-pins.
 */
const describeValidator = (validator: unknown): ArgShape => {
    const node = validator as { _meta?: Record<string, unknown>; kind: string };

    if (node.kind === "optional") {
        return { ...describeValidator(node._meta?.inner), optional: true };
    }

    if (node.kind === "union") {
        const members = (node._meta?.members ?? []) as ReadonlyArray<{ _meta?: Record<string, unknown>; kind: string }>;
        const literals = members.filter((member) => member.kind === "literal").map((member) => member._meta?.value);

        return { kind: "union", literals, optional: false };
    }

    return { kind: node.kind, optional: false };
};

const describeArgs = (args: unknown): Record<string, ArgShape> =>
    Object.fromEntries(Object.entries(args as Record<string, unknown>).map(([name, validator]) => [name, describeValidator(validator)]));

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

    it("discovers a defineAgent initializer wrapped in satisfies/as/parens (CODEGEN-02)", () => {
        expect.assertions(1);

        writeAgents(`
            import { defineAgent, type AgentDefinition } from "@lunora/agent";

            export const viaSatisfies = defineAgent({ model: "m" }) satisfies AgentDefinition;
            export const viaAs = defineAgent({ model: "m" }) as AgentDefinition;
            export const viaParens = (defineAgent({ model: "m" }));
        `);

        expect(discoverAgents(newProject(), workdir).map((agent) => agent.exportName)).toEqual(["viaAs", "viaParens", "viaSatisfies"]);
    });

    it("rejects duplicate agent names/bindings/classes with a located diagnostic (CODEGEN-01)", () => {
        expect.assertions(3);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";

            export const support = defineAgent({ model: "m", name: "helper" });
            export const helper = defineAgent({ model: "m", name: "helper" });
        `);

        expect(() => discoverAgents(newProject(), workdir)).toThrow(/Duplicate agent name "helper"/u);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";

            export const supportBot = defineAgent({ model: "m" });
            export const support_bot = defineAgent({ model: "m" });
        `);

        expect(() => discoverAgents(newProject(), workdir)).toThrow(/Duplicate agent binding "AGENT_SUPPORT_BOT"/u);

        // `aB` vs `AB`: bindingName is NOT invariant to a first-character case
        // change when the first two characters straddle a camelCase boundary
        // (`aB`'s "a"→"B" transition inserts an underscore that "AB" never
        // gets: AGENT_A_B vs AGENT_AB), so distinct `name:` overrides isolate a
        // className-only collision (both capitalize to "ABAgentWorkflow").
        writeAgents(`
            import { defineAgent } from "@lunora/agent";

            export const aB = defineAgent({ model: "m", name: "one" });
            export const AB = defineAgent({ model: "m", name: "two" });
        `);

        expect(() => discoverAgents(newProject(), workdir)).toThrow(/Duplicate agent class "ABAgentWorkflow"/u);
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

    it("flags onEmail by AST presence in any property form, and leaves it off when absent", () => {
        expect.assertions(4);

        writeAgents(`
            import { defineAgent } from "@lunora/agent";

            export const arrow = defineAgent({ model: "m", onEmail: (email) => ({ input: email.subject ?? "", threadKey: "t" }) });
            export const method = defineAgent({ model: "m", onEmail(email) { return { input: email.subject ?? "", threadKey: "t" }; } });
            export const plain = defineAgent({ model: "m" });
        `);

        const byName = new Map(discoverAgents(newProject(), workdir).map((agent) => [agent.exportName, agent]));

        // The closure is never evaluated — presence in any form (assignment or
        // method) sets the flag.
        expect(byName.get("arrow")?.onEmail).toBe(true);
        expect(byName.get("method")?.onEmail).toBe(true);
        // Absent leaves the field off entirely, so email-free output is byte-identical.
        expect(byName.get("plain")?.onEmail).toBeUndefined();
        expect(byName.get("plain") && "onEmail" in byName.get("plain")!).toBe(false);
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
        expect.assertions(16);

        const content = emitFunctions({ agents: discoverSupportAgent(), functions: [] });

        expect(content).toContain('import { agentComponent } from "@lunora/agent/component";');
        expect(content).toContain("const lunoraAgentRuntimeFunctions = agentComponent().functions;");

        for (const name of [
            "agentAppendMessage",
            "agentEnsureThread",
            "agentEpisodeRecall",
            "agentEpisodeUpsert",
            "agentGraphTraverse",
            "agentGraphUpsert",
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

    it("rejects an app registering one of the loop's INTERNAL dispatch names (CODEGEN-04)", () => {
        expect.assertions(1);

        // Unlike a PUBLIC name (`agentMessages`, silently won above),
        // `agentAppendMessage` is dispatched unconditionally BY PATH from the
        // durable loop — an app definition silently winning there would hijack
        // every thread-append the loop makes.
        expect(() => emitFunctions({ agents: discoverSupportAgent(), functions: [appAgentsFunction("agentAppendMessage")] })).toThrow(
            /"agents:agentAppendMessage" is reserved for the durable agent loop's internal dispatch/u,
        );
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
        ).toStrictEqual([
            "agentAppendMessage",
            "agentEnsureThread",
            "agentEpisodeRecall",
            "agentEpisodeUpsert",
            "agentGraphTraverse",
            "agentGraphUpsert",
            "agentPatchThread",
            "agentSetState",
        ]);
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
        // types), so codegen and @lunora/agent's `component.ts` validators can
        // drift silently. Reduce each runtime arg validator to a canonical
        // {kind, optional, literals?} descriptor and assert it against the shape
        // syntheticAgentApiFunctions encodes — this catches not just an added or
        // removed arg (KEY SET) but an optionality flip (e.g. `limit`/`title`
        // becoming required), a scalar-kind change, or a `decision` union member
        // added/removed/renamed. Return TYPES are covered separately by the
        // "pins the synthetic api RETURN shapes…" test below (source-level,
        // since the runtime component's public `AgentRegisteredFunction` shape
        // erases return types).
        const runtime = agentComponent().functions;

        expect(describeArgs(runtime.agentMessages.args)).toStrictEqual({
            key: { kind: "string", optional: false },
            limit: { kind: "number", optional: true },
        });
        expect(describeArgs(runtime.agentState.args)).toStrictEqual({ key: { kind: "string", optional: false } });
        expect(describeArgs(runtime.agentThread.args)).toStrictEqual({ key: { kind: "string", optional: false } });
        expect(describeArgs(runtime.agentResolveApproval.args)).toStrictEqual({
            decision: { kind: "union", literals: ["approve", "reject"], optional: false },
            instanceId: { kind: "string", optional: false },
            note: { kind: "string", optional: true },
            threadKey: { kind: "string", optional: false },
            toolCallId: { kind: "string", optional: false },
        });
        expect(describeArgs(runtime.agentRun.args)).toStrictEqual({
            agent: { kind: "string", optional: false },
            input: { kind: "string", optional: false },
            threadKey: { kind: "string", optional: false },
            title: { kind: "string", optional: true },
        });
    });

    it("pins the synthetic api RETURN shapes to the runtime component (drift guard)", () => {
        expect.assertions(5);

        // CODEGEN-04: unlike the args (validated at runtime, so `describeArgs`
        // above can introspect the LIVE `agentComponent().functions` object),
        // each public handler's return type is erased onto the opaque
        // `AgentRegisteredFunction.handler: (context, args) => unknown` shape —
        // codegen can't recover it from the built package at all. Read the
        // declared `: Promise<T>` annotation straight out of the `@lunora/agent`
        // SOURCE instead (syntactic, no type-checker pass) and assert it against
        // the same literal strings `syntheticAgentApiFunctions` hand-pins in
        // emit.ts (see the "exposes the public thread queries…" test), so a
        // return-shape change in component.ts fails here instead of silently
        // going stale in the generated `api.ts`.
        expect(sourceReturnTypeOf("agentMessages")).toBe("Record<string, unknown>[]");
        expect(sourceReturnTypeOf("agentState")).toBe("Record<string, unknown> | undefined");
        expect(sourceReturnTypeOf("agentThread")).toBe("Record<string, unknown> | undefined");
        expect(sourceReturnTypeOf("agentResolveApproval")).toBe("{ resolved: boolean }");
        expect(sourceReturnTypeOf("agentRun")).toBe("{ id: string; threadKey: string }");
    });
});
