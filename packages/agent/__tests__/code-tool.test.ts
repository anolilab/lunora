import { describe, expect, it } from "vitest";

import { codeTool, resolveReferences, runToolScript } from "../src/code-tool";
import type { AgentToolContext, AgentToolDefinition, AnyAgentTool } from "../src/types";

const UNKNOWN_REF_PATTERN = /unknown result "missing"/u;
const UNKNOWN_TOOL_PATTERN = /unknown tool "nope"/u;
const EMPTY_TOOLS_PATTERN = /non-empty map of tools/u;

const context = {} as AgentToolContext;

/** A fake tool that records the input it was called with and returns `output`. */
const fakeTool = (output: unknown, calls: unknown[] = []): AgentToolDefinition => {
    return {
        description: "fake",
        execute: (input) => {
            calls.push(input);

            return output;
        },
        inputSchema: {} as never,
        isLunoraAgentTool: true,
    };
};

describe(resolveReferences, () => {
    it("passes non-ref values through and recurses into objects/arrays", () => {
        expect(resolveReferences({ a: 1, b: [2, "x"] }, {})).toStrictEqual({ a: 1, b: [2, "x"] });
    });

    it("resolves a `$from` to a full earlier result and `$path` to a nested field", () => {
        const results = { user: { id: "u1", profile: { city: "Berlin" } } };

        expect(resolveReferences({ $from: "user" }, results)).toStrictEqual({ id: "u1", profile: { city: "Berlin" } });
        expect(resolveReferences({ who: { $from: "user", $path: "id" }, where: { $from: "user", $path: "profile.city" } }, results)).toStrictEqual({
            where: "Berlin",
            who: "u1",
        });
    });

    it("throws on an unknown `$from` reference", () => {
        expect(() => resolveReferences({ $from: "missing" }, {})).toThrow(UNKNOWN_REF_PATTERN);
    });
});

describe(runToolScript, () => {
    it("runs steps in order, flowing an earlier output into a later input", async () => {
        const ordersCalls: unknown[] = [];
        const tools: Record<string, AnyAgentTool> = {
            lookup: fakeTool({ id: "u1", name: "Alice" }),
            orders: fakeTool(["o1", "o2"], ordersCalls),
        };

        const result = await runToolScript(
            {
                steps: [
                    { id: "u", input: { email: "a@b.c" }, tool: "lookup" },
                    { id: "o", input: { userId: { $from: "u", $path: "id" } }, tool: "orders" },
                ],
            },
            tools,
            context,
            16,
        );

        // The second step received the first step's resolved output.
        expect(ordersCalls).toStrictEqual([{ userId: "u1" }]);
        expect(result.results).toStrictEqual([
            { id: "u", output: { id: "u1", name: "Alice" } },
            { id: "o", output: ["o1", "o2"] },
        ]);
        expect(result.final).toStrictEqual(["o1", "o2"]);
    });

    it("throws on a step calling an unknown tool", async () => {
        await expect(runToolScript({ steps: [{ id: "x", tool: "nope" }] }, { real: fakeTool(1) }, context, 16)).rejects.toThrow(UNKNOWN_TOOL_PATTERN);
    });

    it("caps the number of steps run", async () => {
        const calls: unknown[] = [];
        const tools = { t: fakeTool("ok", calls) };
        const steps = Array.from({ length: 10 }, (_, index) => {
            return { id: `s${String(index)}`, tool: "t" };
        });

        const result = await runToolScript({ steps }, tools, context, 3);

        expect(calls).toHaveLength(3);
        expect(result.results).toHaveLength(3);
    });
});

describe(codeTool, () => {
    it("mints a tool whose execute runs the script and whose description lists the tools", async () => {
        const tool = codeTool({ search: fakeTool(["hit"]) });

        expect(tool.isLunoraAgentTool).toBe(true);
        expect(tool.description).toContain('"search"');

        const result = (await tool.execute({ steps: [{ id: "s", input: { q: "x" }, tool: "search" }] }, context)) as { final: unknown };

        expect(result.final).toStrictEqual(["hit"]);
    });

    it("throws without any tools to compose", () => {
        expect(() => codeTool({})).toThrow(EMPTY_TOOLS_PATTERN);
    });
});
