import type { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import type { CallAgentToolOptions, McpAgentExposure } from "../src/agent-tools";
import { agentToolDefinitions, callAgentTool, finalAnswer, parseAgentsEnv } from "../src/agent-tools";

/** The dispatch path off a `{ __lunoraRef }` reference. */
const refPath = (reference: unknown): string => (reference as { __lunoraRef: string }).__lunoraRef;

interface MockClientOptions {
    /** Messages returned by `agents:agentMessages`. */
    messages?: ReadonlyArray<Record<string, unknown>>;
    /** The `agents:agentRun` mutation result. */
    runResult?: { id: string; threadKey: string };
    /** Thread rows returned by successive `agents:agentThread` queries. */
    threads: ReadonlyArray<Record<string, unknown> | undefined>;
}

const mockClient = (
    options: MockClientOptions,
): {
    asClient: LunoraClient;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
} => {
    let threadPoll = 0;
    const mutation = vi.fn(async () => options.runResult ?? { id: "wf-run-1", threadKey: "t-x" });
    const query = vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
        const path = refPath(reference);

        if (path === "agents:agentThread") {
            const index = Math.min(threadPoll, options.threads.length - 1);

            threadPoll += 1;

            return options.threads[index];
        }

        if (path === "agents:agentMessages") {
            return options.messages ?? [];
        }

        throw new Error(`unexpected query path ${path} with ${JSON.stringify(args)}`);
    });

    const client = { mutation, query } as unknown as LunoraClient;

    return { asClient: client, mutation, query };
};

const exposures: ReadonlyArray<McpAgentExposure> = [
    { description: "Handles support questions", name: "support" },
    { description: "Billing help", name: "billing" },
];

/** Base options with an immediate wait so poll loops run without wall-clock delay. */
const baseOptions = (overrides: Partial<CallAgentToolOptions> = {}): CallAgentToolOptions => {
    return {
        allowAgents: true,
        exposures,
        wait: async () => undefined,
        ...overrides,
    };
};

const parseText = (result: { content: { text: string }[] }): Record<string, unknown> =>
    JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;

describe(parseAgentsEnv, () => {
    it("parses name:description pairs, keeping colons in the description", () => {
        expect(parseAgentsEnv("support:Handles support: questions;billing:Billing help")).toStrictEqual([
            { description: "Handles support: questions", name: "support" },
            { description: "Billing help", name: "billing" },
        ]);
    });

    it("returns an empty list for undefined and skips malformed entries", () => {
        expect(parseAgentsEnv(undefined)).toStrictEqual([]);
        expect(parseAgentsEnv(";  ;support:;:desc;valid:ok")).toStrictEqual([{ description: "ok", name: "valid" }]);
    });
});

describe(agentToolDefinitions, () => {
    it("advertises no agent tools when allowAgents is false", () => {
        expect(agentToolDefinitions(exposures, false)).toStrictEqual([]);
    });

    it("advertises no agent tools when there are no exposures", () => {
        expect(agentToolDefinitions([], true)).toStrictEqual([]);
    });

    it("advertises one tool per agent plus the generic status tool when opted in", () => {
        const tools = agentToolDefinitions(exposures, true);
        const names = tools.map((tool) => tool.name);

        expect(names).toStrictEqual(["agent_support", "agent_billing", "lunora_agent_status"]);
        expect(tools[0]?.description).toContain("Handles support questions");
        expect(tools[0]?.description).toContain("Starts a durable agent run");
        expect(tools[0]?.inputSchema.required).toStrictEqual(["prompt"]);
    });

    it("honours a toolName override", () => {
        const tools = agentToolDefinitions([{ description: "d", name: "support", toolName: "ask_support" }], true);

        expect(tools[0]?.name).toBe("ask_support");
    });

    it("rejects a non-boolean truthy allowAgents (fail-closed)", () => {
        expect(agentToolDefinitions(exposures, "true" as unknown as boolean)).toStrictEqual([]);
    });
});

describe(finalAnswer, () => {
    it("returns the last assistant turn with no pending tool calls", () => {
        expect(
            finalAnswer([
                { content: "thinking", role: "assistant", toolCalls: [{ id: "1", input: {}, name: "search" }] },
                { content: "result", role: "tool" },
                { content: "the answer", role: "assistant" },
            ]),
        ).toBe("the answer");
    });

    it("returns an empty string when there is no clean assistant turn", () => {
        expect(finalAnswer([{ content: "hi", role: "user" }])).toBe("");
    });
});

describe(callAgentTool, () => {
    it("starts a run via agents:agentRun and returns the final answer once terminal", async () => {
        const { asClient, mutation } = mockClient({
            messages: [{ content: "resolved!", role: "assistant" }],
            threads: [{ status: "idle" }],
        });

        const result = await callAgentTool(asClient, "agent_support", { prompt: "help me", threadKey: "t-1", title: "Case" }, baseOptions());

        expect(mutation).toHaveBeenCalledWith({ __lunoraRef: "agents:agentRun" }, { agent: "support", input: "help me", threadKey: "t-1", title: "Case" });
        expect(result.isError).toBeUndefined();
        expect(parseText(result)).toStrictEqual({ status: "idle", text: "resolved!", threadKey: "t-1" });
    });

    it("mints a fresh mcp-<uuid> threadKey when none is provided", async () => {
        const { asClient, mutation } = mockClient({ messages: [{ content: "hi", role: "assistant" }], threads: [{ status: "idle" }] });

        const result = await callAgentTool(asClient, "agent_support", { prompt: "hi" }, baseOptions());
        const runArguments = mutation.mock.calls[0]?.[1] as { threadKey: string };

        expect(runArguments.threadKey).toMatch(/^mcp-/u);
        expect(parseText(result).threadKey).toBe(runArguments.threadKey);
    });

    it("polls until the thread reaches a terminal status", async () => {
        const { asClient, query } = mockClient({
            messages: [{ content: "done", role: "assistant" }],
            threads: [{ status: "running" }, { status: "running" }, { status: "idle" }],
        });

        const result = await callAgentTool(asClient, "agent_support", { prompt: "go" }, baseOptions({ maxWaitMs: 6000, pollIntervalMs: 600 }));

        // Three agentThread polls + one agentMessages read.
        expect(query.mock.calls.filter((call) => refPath(call[0]) === "agents:agentThread")).toHaveLength(3);
        expect(parseText(result)).toStrictEqual({ status: "idle", text: "done", threadKey: expect.stringMatching(/^mcp-/u) });
    });

    it("returns a non-error pending payload when the wait budget is exhausted", async () => {
        const { asClient } = mockClient({ runResult: { id: "wf-9", threadKey: "t-9" }, threads: [{ status: "running" }] });

        const result = await callAgentTool(
            asClient,
            "agent_support",
            { prompt: "long task", threadKey: "t-9" },
            baseOptions({ maxWaitMs: 600, pollIntervalMs: 600 }),
        );

        expect(result.isError).toBeUndefined();
        expect(parseText(result)).toStrictEqual({
            hint: "call lunora_agent_status with this threadKey to poll for the answer",
            runId: "wf-9",
            status: "running",
            threadKey: "t-9",
        });
    });

    it("surfaces the thread error field on a terminal error status", async () => {
        const { asClient } = mockClient({ messages: [], threads: [{ error: "model blew up", status: "error" }] });

        const result = await callAgentTool(asClient, "agent_support", { prompt: "x", threadKey: "t-e" }, baseOptions());

        expect(parseText(result)).toStrictEqual({ error: "model blew up", status: "error", threadKey: "t-e" });
    });

    it("refuses fail-closed at dispatch when allowAgents is not exactly true", async () => {
        const { asClient, mutation } = mockClient({ threads: [{ status: "idle" }] });

        const result = await callAgentTool(asClient, "agent_support", { prompt: "hi" }, baseOptions({ allowAgents: "true" as unknown as boolean }));

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("agent tools are off");
        expect(mutation).not.toHaveBeenCalled();
    });

    it("errors when the named agent is not among the exposures", async () => {
        const { asClient, mutation } = mockClient({ threads: [{ status: "idle" }] });

        const result = await callAgentTool(asClient, "agent_unknown", { prompt: "hi" }, baseOptions());

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("not exposed");
        expect(mutation).not.toHaveBeenCalled();
    });

    it("errors when prompt is missing", async () => {
        const { asClient, mutation } = mockClient({ threads: [{ status: "idle" }] });

        const result = await callAgentTool(asClient, "agent_support", {}, baseOptions());

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('"prompt" is required');
        expect(mutation).not.toHaveBeenCalled();
    });

    it("lunora_agent_status reads the current status and answer for a threadKey", async () => {
        const { asClient, mutation } = mockClient({ messages: [{ content: "final", role: "assistant" }], threads: [{ status: "idle" }] });

        const result = await callAgentTool(asClient, "lunora_agent_status", { threadKey: "t-1" }, baseOptions());

        expect(mutation).not.toHaveBeenCalled();
        expect(parseText(result)).toStrictEqual({ status: "idle", text: "final", threadKey: "t-1" });
    });

    it("lunora_agent_status reports a still-running thread", async () => {
        const { asClient } = mockClient({ threads: [{ status: "running" }] });

        const result = await callAgentTool(asClient, "lunora_agent_status", { threadKey: "t-1" }, baseOptions());

        expect(parseText(result)).toStrictEqual({ status: "running", threadKey: "t-1" });
    });
});
