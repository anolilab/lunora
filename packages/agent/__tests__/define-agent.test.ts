import { describe, expect, it } from "vitest";

import { defineAgent, defineAgentTool, isAgentDefinition } from "../src/define-agent";
import { agentBindingName, agentClassName, agentDefaultName } from "../src/naming";

const MODEL_PATTERN = /model/u;
const MAX_TURNS_PATTERN = /maxTurns/u;
const TOOL_NAME_PATTERN = /tool name/u;
const DESCRIPTION_PATTERN = /description/u;
const EXECUTE_PATTERN = /execute/u;

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
});
