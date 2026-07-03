import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorAiToolSideEffect } from "../src/ai-tool-side-effects";
import aiToolSideEffectPromptInjection from "../src/lints/static/ai-tool-side-effect-prompt-injection";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const rows: AdvisorAiToolSideEffect[] = [
    // user-derived input + side-effecting tool → flagged.
    { exportName: "agent", file: "agent", line: 4, method: "generateText", sideEffect: "ctx.db.insert", userInputDerived: true },
    // server-authored input + side-effecting tool → not flagged.
    { exportName: "report", file: "report", line: 9, method: "streamText", sideEffect: "ctx.fetch", userInputDerived: false },
];

describe("ai_tool_side_effect_prompt_injection", () => {
    it("flags only the generation whose model input is user-derived", () => {
        expect.assertions(3);

        const findings = aiToolSideEffectPromptInjection.run({ aiToolSideEffects: rows, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "agent", file: "agent", line: 4, method: "generateText", sideEffect: "ctx.db.insert" },
            name: "ai_tool_side_effect_prompt_injection",
        });
        expect(findings[0]?.detail).toContain("ctx.db.insert");
    });

    it("returns [] when aiToolSideEffects is undefined", () => {
        expect.assertions(1);

        expect(aiToolSideEffectPromptInjection.run({ schema: schema() })).toHaveLength(0);
    });

    it("returns [] when no generation has user-derived input", () => {
        expect.assertions(1);

        const serverAuthored = rows.filter((row) => !row.userInputDerived);

        expect(aiToolSideEffectPromptInjection.run({ aiToolSideEffects: serverAuthored, schema: schema() })).toHaveLength(0);
    });
});
