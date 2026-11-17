import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { defineAgent } from "../src/define-agent";
import { createAgentGenerate } from "../src/generate";

const TOOL_JSON_SCHEMA = { properties: { id: { type: "string" } }, required: ["id"], type: "object" };

/** A Standard Schema whose JSON Schema conversion is counted, the way `toJSONSchema` runs for a zod schema. */
const countedSchema = () => {
    const toJsonSchema = vi.fn<() => Record<string, unknown>>(() => structuredClone(TOOL_JSON_SCHEMA));

    return {
        schema: {
            "~standard": {
                jsonSchema: { input: toJsonSchema, output: toJsonSchema },
                validate: (value: unknown) => {
                    return { value };
                },
                vendor: "counted",
                version: 1,
            },
        },
        toJsonSchema,
    };
};

const textModel = (): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doGenerate: async () => {
            return {
                content: [{ text: "ok", type: "text" }],
                finishReason: { raw: "stop", unified: "stop" },
                usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
                warnings: [],
            };
        },
    });

describe("agent tool schemas", () => {
    it("are converted to JSON Schema once per seam, not once per turn", async () => {
        expect.assertions(5);

        const { schema, toJsonSchema } = countedSchema();
        const model = textModel();
        const agent = defineAgent({
            model,
            tools: { lookup: { description: "Look a row up.", execute: async () => "row", inputSchema: schema as never, isLunoraAgentTool: true } },
        });
        const generate = createAgentGenerate(agent, {});

        for (let turn = 0; turn < 3; turn += 1) {
            // eslint-disable-next-line no-await-in-loop -- turns are sequential
            await generate({ messages: [{ content: "hi", role: "user" }] });
        }

        expect(toJsonSchema).toHaveBeenCalledTimes(1);
        expect(model.doGenerateCalls).toHaveLength(3);

        // Every turn still sends the converted schema, not just the first.
        for (const call of model.doGenerateCalls) {
            expect(call.tools?.[0]).toMatchObject({ inputSchema: TOOL_JSON_SCHEMA, name: "lookup" });
        }
    });

    it("are converted again by a new seam, so the conversion lives no longer than the run that built it", async () => {
        expect.assertions(1);

        const { schema, toJsonSchema } = countedSchema();
        const agent = defineAgent({
            model: textModel(),
            tools: { lookup: { description: "Look a row up.", execute: async () => "row", inputSchema: schema as never, isLunoraAgentTool: true } },
        });

        await createAgentGenerate(agent, {})({ messages: [{ content: "hi", role: "user" }] });
        await createAgentGenerate(agent, {})({ messages: [{ content: "hi", role: "user" }] });

        expect(toJsonSchema).toHaveBeenCalledTimes(2);
    });
});
