import { describe, expect, it } from "vitest";

import { defineAgent, defineAgentTool, isAgentDefinition } from "../src/define-agent";
import { agentBindingName, agentClassName, agentDefaultName } from "../src/naming";
import { defineSkill } from "../src/skill";

const MODEL_PATTERN = /model/u;
const MAX_TURNS_PATTERN = /maxTurns/u;
const VOICE_MAX_TURNS_PATTERN = /`voice\.maxTurns` must be a positive integer/u;
const TOOL_NAME_PATTERN = /tool name/u;
const DESCRIPTION_PATTERN = /description/u;
const EXECUTE_PATTERN = /execute/u;
const AGENTIC_COLLISION_PATTERN = /agentic-memory tool "searchMemory" collides/u;
const ACTIVE_TOOLS_MEMORY_PATTERN = /`activeTools` omits the agentic-memory tool\(s\) "searchMemory"/u;
const MEMORY_SOURCE_PATTERN = /`memory` requires a `source`/u;
const SKILL_KNOWLEDGE_SOURCE_PATTERN = /skill "billing" `knowledge` requires a `source`/u;

describe(defineAgent, () => {
    it("brands the definition and preserves the config", () => {
        const agent = defineAgent({ instructions: "hi", maxTurns: 4, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });

        expect(agent.isLunoraAgent).toBe(true);
        expect(agent.maxTurns).toBe(4);
        expect(isAgentDefinition(agent)).toBe(true);
        expect(isAgentDefinition({})).toBe(false);
    });

    it("rejects a missing model, bad maxTurns, and invalid tool names", () => {
        expect(() => defineAgent({ model: "" })).toThrow(MODEL_PATTERN);
        expect(() => defineAgent({ maxTurns: 0, model: "m" })).toThrow(MAX_TURNS_PATTERN);
        // `voice.maxTurns: 0` silently became the 100-turn default while `maxTurns: 0` threw.
        expect(() => defineAgent({ model: "m", voice: { maxTurns: 0 } })).toThrow(VOICE_MAX_TURNS_PATTERN);
        expect(() => defineAgent({ model: "m", voice: { maxTurns: 1.5 } })).toThrow(VOICE_MAX_TURNS_PATTERN);
        expect(() =>
            defineAgent({
                model: "m",
                tools: {
                    "not a name": defineAgentTool({ description: "x", execute: () => "y", inputSchema: {} as never }),
                },
            }),
        ).toThrow(TOOL_NAME_PATTERN);
    });

    it("derives class, binding and workflow names from the export name", () => {
        expect(agentClassName("support")).toBe("SupportAgentWorkflow");
        expect(agentClassName("supportBot")).toBe("SupportBotAgentWorkflow");
        expect(agentBindingName("support")).toBe("AGENT_SUPPORT");
        expect(agentBindingName("supportBot")).toBe("AGENT_SUPPORT_BOT");
        expect(agentDefaultName("supportBot")).toBe("agent-support-bot");
    });

    it("validates tool configs", () => {
        expect(() => defineAgentTool({ description: "", execute: () => "x", inputSchema: {} as never })).toThrow(DESCRIPTION_PATTERN);
        expect(() => defineAgentTool({ description: "d", execute: undefined as never, inputSchema: {} as never })).toThrow(EXECUTE_PATTERN);
    });

    it("routes an inject-mode memory to `memorySources`, not a minted tool", () => {
        const agent = defineAgent({ memory: { source: "rag:searchDocs", topK: 3 }, model: "m" });

        expect(agent.memorySources).toStrictEqual([{ key: "default", source: "rag:searchDocs", topK: 3 }]);
        // No `mode` set ⇒ inject (the historic behavior): no `searchMemory` tool.
        expect(agent.tools).toBeUndefined();
    });

    it("routes an agentic-mode memory to a minted `searchMemory` tool, not `memorySources`", () => {
        const agent = defineAgent({ memory: { mode: "agentic", source: "rag:searchDocs", topK: 3 }, model: "m" });

        // Agentic sources never auto-inject: no `memorySources`.
        expect(agent.memorySources).toBeUndefined();
        expect(Object.keys(agent.tools ?? {})).toStrictEqual(["searchMemory"]);
        expect(agent.tools?.["searchMemory"]?.isLunoraAgentTool).toBe(true);
    });

    it("mints a companion `readMemory` tool when the agentic memory sets `read`", () => {
        const agent = defineAgent({ memory: { mode: "agentic", read: "rag:getDoc", source: "rag:searchDocs" }, model: "m" });

        expect(new Set(Object.keys(agent.tools ?? {}))).toStrictEqual(new Set(["readMemory", "searchMemory"]));
    });

    it("keys a skill's agentic knowledge tool by the skill name", () => {
        const agent = defineAgent({
            memory: { source: "rag:searchDocs" },
            model: "m",
            skills: [defineSkill({ knowledge: { mode: "agentic", source: "rag:searchBilling" }, name: "billing" })],
        });

        // Agent's own inject memory stays on the retrieval path…
        expect(agent.memorySources).toStrictEqual([{ key: "default", source: "rag:searchDocs" }]);
        // …while the skill's agentic knowledge mints a namespaced tool.
        expect(Object.keys(agent.tools ?? {})).toStrictEqual(["search_billing"]);
    });

    it("throws when a minted memory tool collides with a real tool", () => {
        expect(() =>
            defineAgent({
                memory: { mode: "agentic", source: "rag:searchDocs" },
                model: "m",
                tools: {
                    searchMemory: defineAgentTool({ description: "x", execute: () => "y", inputSchema: {} as never }),
                },
            }),
        ).toThrow(AGENTIC_COLLISION_PATTERN);
    });

    it("throws when `activeTools` omits a minted agentic-memory tool", () => {
        // Enabling agentic memory but pinning `activeTools` to a set that excludes
        // `searchMemory` makes the memory tool unreachable — fail loud, don't hide.
        expect(() =>
            defineAgent({
                activeTools: ["someOtherTool"],
                memory: { mode: "agentic", source: "rag:searchDocs" },
                model: "m",
            }),
        ).toThrow(ACTIVE_TOOLS_MEMORY_PATTERN);
    });

    it("accepts `activeTools` that includes the minted agentic-memory tool", () => {
        expect(() =>
            defineAgent({
                activeTools: ["searchMemory"],
                memory: { mode: "agentic", source: "rag:searchDocs" },
                model: "m",
            }),
        ).not.toThrow();
    });

    it("routes a graph-kind memory to `memorySources` (no `source`) and mints no tool", () => {
        const agent = defineAgent({ memory: { graph: { depth: 3 }, kind: "graph" }, model: "m" });

        // A graph source is always auto-injected (traversed per run) and needs no RAG `source`.
        expect(agent.memorySources).toStrictEqual([{ graph: { depth: 3 }, key: "default", kind: "graph" }]);
        expect(agent.tools).toBeUndefined();
    });

    it("requires a `source` for a semantic memory but not for a graph one", () => {
        // Semantic (the default kind) without a `source` is a declaration-time error…
        expect(() => defineAgent({ memory: {}, model: "m" })).toThrow(MEMORY_SOURCE_PATTERN);
        // …a skill's semantic knowledge too…
        expect(() => defineAgent({ model: "m", skills: [defineSkill({ knowledge: {}, name: "billing" })] })).toThrow(SKILL_KNOWLEDGE_SOURCE_PATTERN);
        // …while a graph memory with no `source` is accepted.
        expect(() => defineAgent({ memory: { kind: "graph" }, model: "m" })).not.toThrow();
    });
});
