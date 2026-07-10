import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent } from "../src/define-agent";
import type { McpCallResult, McpClientLike, McpToolInfo } from "../src/mcp";
import { adaptMcpResult, mcpTools } from "../src/mcp";
import { DurableStepJournal, loopDefaults, memoryRuntime, scriptedGenerate, toolTurn } from "./loop-harness";

/** A mock MCP client: canned tool list + a `callTool` recording its calls. */
const mockClient = (
    tools: ReadonlyArray<McpToolInfo>,
    respond: (name: string, args: Record<string, unknown> | undefined) => McpCallResult,
): McpClientLike & { calls: { arguments?: Record<string, unknown>; name: string }[] } => {
    const calls: { arguments?: Record<string, unknown>; name: string }[] = [];

    return {
        calls,
        callTool: async ({ arguments: args, name }) => {
            calls.push({ arguments: args, name });

            return respond(name, args);
        },
        listTools: async () => {
            return { tools };
        },
    };
};

const weatherTool: McpToolInfo = {
    description: "Look up the weather for a city.",
    inputSchema: { properties: { city: { type: "string" } }, required: ["city"], type: "object" },
    name: "get_weather",
};

const timeTool: McpToolInfo = {
    inputSchema: { properties: {}, type: "object" },
    name: "get_time",
};

const CRASH_AFTER_TOOL = /crash after tool/u;
const STDIO_UNSUPPORTED = /stdio transport.*cannot run in the Workers runtime/u;
const REQUIRES_URL = /requires a `url`/u;

describe(adaptMcpResult, () => {
    it("prefers structuredContent, falls back to joined text, and stringifies errors", () => {
        expect(adaptMcpResult({ structuredContent: { temperature: 21 } })).toStrictEqual({ temperature: 21 });
        expect(
            adaptMcpResult({
                content: [
                    { text: "sunny", type: "text" },
                    { text: "22C", type: "text" },
                ],
            }),
        ).toBe("sunny\n22C");
        expect(adaptMcpResult({ content: [{ text: "boom", type: "text" }], isError: true })).toBe("MCP tool error: boom");
        expect(adaptMcpResult({ isError: true })).toBe("MCP tool error: unknown error");
        expect(adaptMcpResult({ content: [{ data: "…", type: "image" }] })).toStrictEqual([{ data: "…", type: "image" }]);
    });
});

describe(mcpTools, () => {
    it("adapts each listed tool into an AgentToolDefinition, honoring `only` and `prefix`", async () => {
        const client = mockClient([weatherTool, timeTool], () => {
            return { content: [{ text: "ok", type: "text" }] };
        });

        const tools = await mcpTools({ client, only: ["get_weather"], prefix: "mcp_" });

        expect(Object.keys(tools)).toStrictEqual(["mcp_get_weather"]);

        const tool = tools["mcp_get_weather"];

        expect(tool?.isLunoraAgentTool).toBe(true);
        expect(tool?.description).toBe("Look up the weather for a city.");

        // A description-less server tool still gets a usable fallback.
        const all = await mcpTools({ client });

        expect(all["get_time"]?.description).toBe('MCP tool "get_time".');
    });

    it("execute calls the MCP tool and returns the adapted result", async () => {
        const client = mockClient([weatherTool], (_name, args) => {
            return { content: [{ text: `sunny in ${String(args?.["city"])}`, type: "text" }] };
        });

        const tools = await mcpTools({ client });
        const output = await tools["get_weather"]?.execute(
            { city: "Berlin" },
            {
                env: {},
                getState: async () => undefined,
                idempotencyKey: "tool:get_weather:call_1",
                reportProgress: () => {},
                run: async () => null,
                setState: async () => {},
                threadKey: "thread-1",
                toolCallId: "call_1",
            },
        );

        expect(output).toBe("sunny in Berlin");
        expect(client.calls).toStrictEqual([{ arguments: { city: "Berlin" }, name: "get_weather" }]);
    });

    it("runs each MCP call inside the loop's durable tool step and persists its result", async () => {
        const client = mockClient([weatherTool], (_name, args) => {
            return { structuredContent: { city: args?.["city"], forecast: "sunny" } };
        });

        const tools = await mcpTools({ client });

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: { ...tools },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([toolTurn("call_1", "get_weather", { city: "Berlin" }, "checking…"), { text: "Sunny.", toolCalls: [] }]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result.stopped).toBe("final");
        expect(journal.invoked).toStrictEqual(["llm:turn:0", "tool:get_weather:call_1", "llm:turn:1"]);
        expect(client.calls).toStrictEqual([{ arguments: { city: "Berlin" }, name: "get_weather" }]);

        const toolRow = [...runtime.messages.values()].find((message) => message.role === "tool");

        // The structured result is JSON-encoded as the persisted tool content.
        expect(toolRow?.content).toBe(JSON.stringify({ city: "Berlin", forecast: "sunny" }));
    });

    it("does not re-call the MCP tool across a crash + resume of the same instance", async () => {
        let calls = 0;
        const client: McpClientLike = {
            callTool: async () => {
                calls += 1;

                return { content: [{ text: "sunny", type: "text" }] };
            },
            listTools: async () => {
                return { tools: [weatherTool] };
            },
        };

        const tools = await mcpTools({ client });

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: { ...tools },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        // First attempt: the second turn throws AFTER the tool step completed.
        const throwing = scriptedGenerate([toolTurn("call_1", "get_weather", { city: "Berlin" })]);

        await expect(
            runAgentLoop(
                loopDefaults(agent, {
                    generate: async (options) => {
                        if (journal.invoked.includes("tool:get_weather:call_1")) {
                            throw new Error("crash after tool");
                        }

                        return throwing(options);
                    },
                    run: runtime.run,
                    step: journal,
                }),
            ),
        ).rejects.toThrow(CRASH_AFTER_TOOL);

        expect(calls).toBe(1);

        // Resume on the SAME journal: `llm:turn:0` and the tool step are both
        // memoized, so only `llm:turn:1` re-runs — the MCP tool is not called again.
        const resume = scriptedGenerate([{ text: "Sunny.", toolCalls: [] }]);

        await runAgentLoop(loopDefaults(agent, { generate: resume, run: runtime.run, step: journal }));

        expect(calls).toBe(1);
    });

    it("rejects a stdio `command` (unsupported in workerd) and a missing url", async () => {
        await expect(mcpTools({ command: "node server.js" })).rejects.toThrow(STDIO_UNSUPPORTED);
        await expect(mcpTools({})).rejects.toThrow(REQUIRES_URL);
    });
});
