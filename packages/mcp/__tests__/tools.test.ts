import type { CirrusClient } from "@cirrus/client";
import { describe, expect, it, vi } from "vitest";

import { callTool, TOOL_DEFINITIONS } from "../src/tools.js";

/** Minimal mock exposing only the methods the tools touch. */
const mockClient = (): {
    action: ReturnType<typeof vi.fn>;
    asClient: CirrusClient;
    listFunctions: ReturnType<typeof vi.fn>;
    listGlobalTables: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
} => {
    const action = vi.fn(async () => {
        return { ran: "action" };
    });
    const listFunctions = vi.fn(async () => [{ kind: "query", path: "messages:list" }]);
    const listGlobalTables = vi.fn(async () => [{ columns: ["email"], name: "users" }]);
    const mutation = vi.fn(async () => {
        return { id: "m1" };
    });
    const query = vi.fn(async () => {
        return { count: 7 };
    });

    const client = { action, listFunctions, listGlobalTables, mutation, query } as unknown as CirrusClient;

    return { action, asClient: client, listFunctions, listGlobalTables, mutation, query };
};

describe("tOOL_DEFINITIONS", () => {
    it("exposes the five expected tools, each with an object input schema", () => {
        expect.assertions(2);

        const names = TOOL_DEFINITIONS.map((tool) => tool.name);

        expect(names).toStrictEqual(["cirrus_list_functions", "cirrus_list_tables", "cirrus_run_query", "cirrus_run_mutation", "cirrus_run_action"]);
        expect(TOOL_DEFINITIONS.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    });
});

describe("callTool", () => {
    it("cirrus_list_functions returns the function list as JSON text", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "cirrus_list_functions", {});

        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual([{ kind: "query", path: "messages:list" }]);
    });

    it("cirrus_run_query forwards the function reference, args, and shardKey", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "cirrus_run_query", {
            args: { limit: 3 },
            functionPath: "messages:list",
            shardKey: "room-1",
        });

        expect(mock.query).toHaveBeenCalledWith({ __cirrusRef: "messages:list" }, { limit: 3 }, { shardKey: "room-1" });
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual({ count: 7 });
    });

    it("cirrus_run_mutation defaults args to an empty object when omitted", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await callTool(mock.asClient, "cirrus_run_mutation", { functionPath: "messages:send" });

        expect(mock.mutation).toHaveBeenCalledWith({ __cirrusRef: "messages:send" }, {}, { shardKey: undefined });
    });

    it("coerces a non-object args payload (e.g. an array) to an empty bag", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await callTool(mock.asClient, "cirrus_run_query", { args: [1, 2, 3], functionPath: "messages:list" });

        expect(mock.query).toHaveBeenCalledWith({ __cirrusRef: "messages:list" }, {}, { shardKey: undefined });
    });

    it("returns an error result when functionPath is missing", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "cirrus_run_query", {});

        expect(result.isError).toBe(true);
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("returns an error result for an unknown tool", async () => {
        expect.assertions(1);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "cirrus_nope", {});

        expect(result.isError).toBe(true);
    });

    it('serializes a void (undefined) result to the string "null" rather than dropping it', async () => {
        expect.assertions(3);

        const mock = mockClient();

        // A mutation/action that returns nothing resolves to `undefined`.
        mock.mutation.mockResolvedValueOnce(undefined);

        const result = await callTool(mock.asClient, "cirrus_run_mutation", { functionPath: "messages:send" });

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

        const result = await callTool(mock.asClient, "cirrus_run_action", { functionPath: "x:y" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("boom");
    });
});
