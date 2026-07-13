import { describe, expect, it } from "vitest";

import { codeTool, resolveReferences, runToolScript } from "../src/code-tool";
import type { AgentToolContext, AgentToolDefinition, AnyAgentTool } from "../src/types";

const UNKNOWN_REF_PATTERN = /unknown result "missing"/u;
const UNKNOWN_TOOL_PATTERN = /unknown tool "nope"/u;
const EMPTY_TOOLS_PATTERN = /non-empty map of tools/u;
const GATED_TOOL_PATTERN = /cannot compose "gated"/u;
const DUPLICATE_ID_PATTERN = /duplicate code step id "dup"/u;

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

    it("does not resolve a `$path` onto the prototype chain", () => {
        const resolved = resolveReferences({ x: { $from: "u", $path: "__proto__" }, y: { $from: "u", $path: "constructor" } }, { u: { a: 1 } }) as {
            x: unknown;
            y: unknown;
        };

        expect(resolved.x).toBeUndefined();
        expect(resolved.y).toBeUndefined();
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

    it("rejects duplicate step ids up front, before running any tool", async () => {
        const calls: unknown[] = [];
        const tools = { t: fakeTool("ok", calls) };

        await expect(
            runToolScript(
                {
                    steps: [
                        { id: "dup", tool: "t" },
                        { id: "dup", tool: "t" },
                    ],
                },
                tools,
                context,
                16,
            ),
        ).rejects.toThrow(DUPLICATE_ID_PATTERN);
        // Fail-fast: neither step executed (no partial side effects).
        expect(calls).toStrictEqual([]);
    });

    it("caps a large step output in the returned results while the full value still flows to refs", async () => {
        const big = "z".repeat(5000);
        let echoInput: unknown;
        const echo: AgentToolDefinition = {
            description: "echo",
            execute: (input) => {
                echoInput = input;

                return "done";
            },
            inputSchema: {} as never,
            isLunoraAgentTool: true,
        };

        const result = await runToolScript(
            {
                steps: [
                    { id: "b", tool: "big" },
                    { id: "e", input: { data: { $from: "b" } }, tool: "echo" },
                ],
            },
            { big: fakeTool(big), echo },
            context,
            16,
        );

        // The returned result for step "b" is truncated…
        expect((result.results[0]?.output as string).endsWith("… [truncated]")).toBe(true);
        // …but the FULL value flowed into step "e" via `$from`.
        expect((echoInput as { data: string }).data).toBe(big);
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

    it("gives each step its own idempotency key / tool-call id derived from the code tool's", async () => {
        const seen: { idempotencyKey: string; toolCallId: string }[] = [];
        const tool: AgentToolDefinition = {
            description: "t",
            execute: (_input, ctx) => {
                seen.push({ idempotencyKey: ctx.idempotencyKey, toolCallId: ctx.toolCallId });

                return "ok";
            },
            inputSchema: {} as never,
            isLunoraAgentTool: true,
        };
        const baseContext = { idempotencyKey: "tool:code:call_1", toolCallId: "call_1" } as AgentToolContext;

        await runToolScript(
            {
                steps: [
                    { id: "a", tool: "t" },
                    { id: "b", tool: "t" },
                ],
            },
            { t: tool },
            baseContext,
            16,
        );

        expect(seen).toStrictEqual([
            { idempotencyKey: "tool:code:call_1:a", toolCallId: "call_1:a" },
            { idempotencyKey: "tool:code:call_1:b", toolCallId: "call_1:b" },
        ]);
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

    it("rejects composing an approval-gated tool (a script can't pause for HITL)", () => {
        const gated: AgentToolDefinition = { ...fakeTool("x"), needsApproval: true };

        expect(() => codeTool({ gated })).toThrow(GATED_TOOL_PATTERN);
    });
});
