import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import { defineSkill, isSkillDefinition } from "../src/skill";
import type { AgentDefinition, AgentGenerate, AgentGenerateResult, AgentInstructionsContext } from "../src/types";
import { memoryRuntime } from "./loop-harness";

const NAME_PATTERN = /identifier/u;
const COLLIDES_PATTERN = /collides/u;
const COLLISION_NAMES_PATTERN = /billing.*lookup|lookup.*billing/u;
const INVALID_IDENTIFIER_PATTERN = /is not a valid identifier/u;
const DUPLICATE_SKILL_PATTERN = /more than one skill/u;
const RESERVED_NAME_PATTERN = /reserved/u;
const DUPLICATE_SKILL_NAME_PATTERN = /billing/u;

/**
 * Faithful in-memory model of Cloudflare Workflows' `step.do` memoization (a
 * recorded step name returns its output without re-invoking the callback),
 * recording invoked step names so a test can assert the memory step names.
 */
class DurableStepJournal {
    public readonly invoked: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    public async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const existing = this.entries.get(name);

        if (existing) {
            return existing.output as T;
        }

        this.invoked.push(name);

        const output = await callback();

        this.entries.set(name, { output });

        return output;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, class-methods-use-this -- mirrors AgentStepLike.waitForEvent's generic host signature so the mock stays assignable
    public async waitForEvent<T>(_name: string, _options: { timeout?: number | string; type: string }): Promise<{ payload: T; type: string }> {
        return new Promise<{ payload: T; type: string }>(() => {});
    }
}

/**
 * The shared runtime double, adapted to this suite's shape: each skill-knowledge
 * source is an extra dispatch handler returning a fixed result.
 */
const skillRuntime = (memories: ReadonlyArray<{ path: string; result: unknown }> = []) =>
    memoryRuntime({ handlers: Object.fromEntries(memories.map((memory) => [memory.path, (): unknown => memory.result])) });

/** A scripted LLM: pops one decision per turn, recording what it was shown. */
const scriptedGenerate = (script: AgentGenerateResult[]): AgentGenerate & { seen: ReadonlyArray<unknown>[] } => {
    const seen: ReadonlyArray<unknown>[] = [];
    const remaining = [...script];

    const generate = (async ({ messages }: { messages: ReadonlyArray<unknown> }) => {
        seen.push(messages);

        const next = remaining.shift();

        if (!next) {
            throw new Error("scripted generate exhausted");
        }

        return next;
    }) as AgentGenerate & { seen: ReadonlyArray<unknown>[] };

    generate.seen = seen;

    return generate;
};

const finalTurn = (text: string): AgentGenerateResult => {
    return { text, toolCalls: [] };
};

const loopDefaults = (agent: AgentDefinition, overrides?: Partial<Parameters<typeof runAgentLoop>[0]>): Parameters<typeof runAgentLoop>[0] => {
    return {
        agent,
        env: { LUNORA_TEST: true },
        exportName: "support",
        generate: scriptedGenerate([finalTurn("hi")]),
        instanceId: "wf-1",
        params: { input: "hello", threadKey: "thread-1" },
        paths: DEFAULT_AGENT_FUNCTION_PATHS,
        run: skillRuntime().run,
        step: new DurableStepJournal(),
        ...overrides,
    };
};

const tool = (description: string) => defineAgentTool({ description, execute: () => "ok", inputSchema: { jsonSchema: { type: "object" } } as never });

describe(defineSkill, () => {
    it("brands the definition and preserves the config", () => {
        const skill = defineSkill({ instructions: "be terse", name: "brevity" });

        expect(skill.isLunoraSkill).toBe(true);
        expect(skill.name).toBe("brevity");
        expect(skill.instructions).toBe("be terse");
        expect(isSkillDefinition(skill)).toBe(true);
        expect(isSkillDefinition({})).toBe(false);
        expect(isSkillDefinition(null)).toBe(false);
    });

    it("rejects a missing or non-identifier name", () => {
        expect(() => defineSkill({ name: "" })).toThrow(NAME_PATTERN);
        expect(() => defineSkill({ name: "not a name" })).toThrow(NAME_PATTERN);
        expect(() => defineSkill({ name: undefined as never })).toThrow(NAME_PATTERN);
    });

    it("rejects the reserved name `default` (the agent's own memory-source key)", () => {
        // `default` is identifier-shaped but reserved for the agent's `memory`
        // source (the historic `memory:retrieve` step) — it must not be author-supplied.
        expect(() => defineSkill({ knowledge: { source: "rag:billing" }, name: "default" })).toThrow(RESERVED_NAME_PATTERN);
        expect(() => defineSkill({ name: "default" })).toThrow(RESERVED_NAME_PATTERN);
    });
});

describe("defineAgent with skills", () => {
    it("merges skill tools into the flat namespace", () => {
        const billing = defineSkill({ name: "billing", tools: { lookupInvoice: tool("Look up an invoice.") } });
        const shipping = defineSkill({ name: "shipping", tools: { trackParcel: tool("Track a parcel.") } });

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            skills: [billing, shipping],
            tools: { escalate: tool("Escalate to a human.") },
        });

        expect(Object.keys(agent.tools ?? {}).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["escalate", "lookupInvoice", "trackParcel"]);
    });

    it("throws on a tool-name collision, naming the skill and tool", () => {
        const skill = defineSkill({ name: "billing", tools: { lookup: tool("Skill lookup.") } });

        expect(() =>
            defineAgent({
                model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                skills: [skill],
                tools: { lookup: tool("Agent lookup.") },
            }),
        ).toThrow(COLLIDES_PATTERN);

        // The message names the offending skill and tool.
        expect(() =>
            defineAgent({
                model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                skills: [skill],
                tools: { lookup: tool("Agent lookup.") },
            }),
        ).toThrow(COLLISION_NAMES_PATTERN);
    });

    it("throws when two skills contribute the same tool name", () => {
        const a = defineSkill({ name: "a", tools: { shared: tool("A.") } });
        const b = defineSkill({ name: "b", tools: { shared: tool("B.") } });

        expect(() => defineAgent({ model: "m", skills: [a, b] })).toThrow(COLLIDES_PATTERN);
    });

    it("still validates a skill-contributed tool name against the identifier pattern", () => {
        const bad = defineSkill({ name: "bad", tools: { "not a name": tool("Bad.") } });

        expect(() => defineAgent({ model: "m", skills: [bad] })).toThrow(INVALID_IDENTIFIER_PATTERN);
    });

    it("throws when two skills share a name, even without a tool collision", () => {
        // Two knowledge-only skills named the same would key the same durable
        // memory step (`memory:retrieve:billing`); the second retrieval would
        // silently return the first's memoized output. `mergeSkillTools` does not
        // fire (disjoint/no tools), so this guard must catch it.
        const a = defineSkill({ knowledge: { source: "rag:billingA" }, name: "billing" });
        const b = defineSkill({ knowledge: { source: "rag:billingB" }, name: "billing" });

        expect(() => defineAgent({ model: "m", skills: [a, b] })).toThrow(DUPLICATE_SKILL_PATTERN);

        // The message names the offending skill.
        expect(() => defineAgent({ model: "m", skills: [a, b] })).toThrow(DUPLICATE_SKILL_NAME_PATTERN);
    });

    it("throws on duplicate skill names that carry no knowledge or tools at all", () => {
        const a = defineSkill({ instructions: "A guidance.", name: "search" });
        const b = defineSkill({ instructions: "B guidance.", name: "search" });

        expect(() => defineAgent({ model: "m", skills: [a, b] })).toThrow(DUPLICATE_SKILL_PATTERN);
    });

    it("composes instruction fragments in order: agent first, then skills", () => {
        const a = defineSkill({ instructions: "Skill A guidance.", name: "a" });
        const b = defineSkill({ instructions: (context: AgentInstructionsContext) => `Skill B for ${context.input}.`, name: "b" });

        const agent = defineAgent({
            instructions: "Agent base.",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            skills: [a, b],
        });

        // Several fragments collapse to a single thunk resolved at run start.
        expect(agent.instructions).toBeTypeOf("function");

        const resolved = (agent.instructions as (context: AgentInstructionsContext) => string)({
            env: {},
            input: "orders",
            threadKey: "t",
        });

        expect(resolved).toBe("Agent base.\n\nSkill A guidance.\n\nSkill B for orders.");
    });

    it("keeps a single skill instruction as-is when the agent has none", () => {
        const only = defineSkill({ instructions: "Sole skill guidance.", name: "only" });
        const agent = defineAgent({ model: "m", skills: [only] });

        expect(agent.instructions).toBe("Sole skill guidance.");
    });

    it("collects memory sources from agent memory plus each skill's knowledge", () => {
        const billing = defineSkill({ knowledge: { source: "rag:billing", topK: 4 }, name: "billing" });
        const shipping = defineSkill({ knowledge: { source: "rag:shipping" }, name: "shipping" });
        // A skill without knowledge contributes no memory source.
        const noKnowledge = defineSkill({ instructions: "no knowledge", name: "plain" });

        const agent = defineAgent({
            memory: { source: "rag:general", topK: 5 },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            skills: [billing, noKnowledge, shipping],
        });

        expect(agent.memorySources).toStrictEqual([
            { key: "default", source: "rag:general", topK: 5 },
            { key: "billing", source: "rag:billing", topK: 4 },
            { key: "shipping", source: "rag:shipping" },
        ]);
    });
});

describe("skill knowledge retrieval in the loop", () => {
    it("retrieves from N sources with deterministic step names and injects each context", async () => {
        const billing = defineSkill({ knowledge: { source: "rag:billing", topK: 2 }, name: "billing" });
        const agent = defineAgent({
            memory: { source: "rag:general", topK: 5 },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            skills: [billing],
        });

        const runtime = skillRuntime([
            { path: "rag:general", result: { context: "General runtime facts." } },
            { path: "rag:billing", result: { context: "Invoices are billed monthly." } },
        ]);
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([finalTurn("answered")]);

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        // The default source keeps the historic step name; the skill source is keyed.
        expect(journal.invoked.filter((name) => name.startsWith("memory:retrieve"))).toStrictEqual(["memory:retrieve", "memory:retrieve:billing"]);

        // Each source was dispatched with the run's input as the query.
        expect(runtime.dispatches.find((dispatch) => dispatch.path === "rag:general")?.args).toStrictEqual({ query: "hello", topK: 5 });
        expect(runtime.dispatches.find((dispatch) => dispatch.path === "rag:billing")?.args).toStrictEqual({ query: "hello", topK: 2 });

        // Both retrieved contexts reached the model, joined into the memory prompt.
        const shown = generate.seen[0] as { content: unknown; role: string }[];
        const memoryMessage = shown.find((message) => message.role === "system" && String(message.content).includes("General runtime facts."));

        expect(String(memoryMessage?.content)).toContain("Invoices are billed monthly.");
    });

    it("keeps the exact `memory:retrieve` step for a plain memory agent (back-compat, no skills)", async () => {
        const agent = defineAgent({ memory: { source: "rag:general", topK: 3 }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = skillRuntime([{ path: "rag:general", result: { context: "Just the default source." } }]);
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([finalTurn("answered")]);

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        // Exactly one memory step, under the unchanged name.
        expect(journal.invoked.filter((name) => name.startsWith("memory:retrieve"))).toStrictEqual(["memory:retrieve"]);
        expect(runtime.dispatches.find((dispatch) => dispatch.path === "rag:general")?.args).toStrictEqual({ query: "hello", topK: 3 });

        const shown = generate.seen[0] as { content: unknown; role: string }[];

        expect(shown.some((message) => message.role === "system" && String(message.content).includes("Just the default source."))).toBe(true);
    });

    it("runs no memory step for an agent with neither memory nor skill knowledge", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = skillRuntime();
        const journal = new DurableStepJournal();

        await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("hi")]), run: runtime.run, step: journal }));

        expect(journal.invoked.some((name) => name.startsWith("memory:retrieve"))).toBe(false);
        expect(agent.memorySources).toBeUndefined();
    });
});
