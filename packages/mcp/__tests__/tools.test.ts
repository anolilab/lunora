import type { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { callTool, TOOL_DEFINITIONS } from "../src/tools";

/** Minimal mock exposing only the methods the tools touch. */
const mockClient = (): {
    action: ReturnType<typeof vi.fn>;
    asClient: LunoraClient;
    listFunctions: ReturnType<typeof vi.fn>;
    listGlobalTables: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
} => {
    const action = vi.fn<() => Promise<{ ran: string }>>(async () => {
        return { ran: "action" };
    });
    const listFunctions = vi.fn<() => Promise<{ kind: string; path: string }[]>>(async () => [{ kind: "query", path: "messages:list" }]);
    const listGlobalTables = vi.fn<() => Promise<{ columns: string[]; name: string }[]>>(async () => [{ columns: ["email"], name: "users" }]);
    const mutation = vi.fn<() => Promise<{ id: string }>>(async () => {
        return { id: "m1" };
    });
    const query = vi.fn<() => Promise<{ count: number }>>(async () => {
        return { count: 7 };
    });

    const client = { action, listFunctions, listGlobalTables, mutation, query } as unknown as LunoraClient;

    return { action, asClient: client, listFunctions, listGlobalTables, mutation, query };
};

describe("tOOL_DEFINITIONS", () => {
    it("exposes the five expected tools, each with an object input schema", () => {
        expect.assertions(2);

        const names = TOOL_DEFINITIONS.map((tool) => tool.name);

        expect(names).toStrictEqual(["lunora_list_functions", "lunora_list_tables", "lunora_run_query", "lunora_run_mutation", "lunora_run_action"]);
        expect(TOOL_DEFINITIONS.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    });
});

describe("callTool", () => {
    it("lunora_list_functions returns the function list as JSON text", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_list_functions", {});

        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual([{ kind: "query", path: "messages:list" }]);
    });

    it("lunora_run_query forwards the function reference, args, and shardKey", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_query", {
            args: { limit: 3 },
            functionPath: "messages:list",
            shardKey: "room-1",
        });

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: "messages:list" }, { limit: 3 }, { shardKey: "room-1" });
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual({ count: 7 });
    });

    it("lunora_run_mutation defaults args to an empty object when omitted", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await callTool(mock.asClient, "lunora_run_mutation", { functionPath: "messages:send" });

        expect(mock.mutation).toHaveBeenCalledWith({ __lunoraRef: "messages:send" }, {}, { shardKey: undefined });
    });

    it("coerces a non-object args payload (e.g. an array) to an empty bag", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await callTool(mock.asClient, "lunora_run_query", { args: [1, 2, 3], functionPath: "messages:list" });

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: "messages:list" }, {}, { shardKey: undefined });
    });

    it("returns an error result when functionPath is missing", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_query", {});

        expect(result.isError).toBe(true);
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("returns an error result for an unknown tool", async () => {
        expect.assertions(1);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_nope", {});

        expect(result.isError).toBe(true);
    });

    it('serializes a void (undefined) result to the string "null" rather than dropping it', async () => {
        expect.assertions(3);

        const mock = mockClient();

        // A mutation/action that returns nothing resolves to `undefined`.
        mock.mutation.mockResolvedValueOnce(undefined);

        const result = await callTool(mock.asClient, "lunora_run_mutation", { functionPath: "messages:send" });

        expect(result.isError).toBeUndefined();
        // `text` must always be a string per the MCP TextContent contract;
        // `JSON.stringify(undefined)` would otherwise yield the JS value undefined.
        expect(typeof result.content[0]!.text).toBe("string");
        expect(result.content[0]!.text).toBe("null");
    });

    it("surfaces a thrown client error as an error result rather than rejecting", async () => {
        expect.assertions(2);

        const mock = mockClient();

        mock.action.mockRejectedValueOnce(new Error("boom"));

        const result = await callTool(mock.asClient, "lunora_run_action", { functionPath: "x:y" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("boom");
    });
});
