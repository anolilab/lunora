import type { FunctionDescriptor, LunoraClient } from "@lunora/client";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { describe, expect, it, vi } from "vitest";

import { ERROR_TOOL_DEFINITIONS } from "../src/error-tools";
import type { ToolResult } from "../src/tools";
import { callTool, READ_ONLY_TOOL_DEFINITIONS, ROW_READ_TOOL_DEFINITIONS, toolDefinitions, WRITE_TOOL_DEFINITIONS } from "../src/tools";

const MOCK_FUNCTIONS: FunctionDescriptor[] = [
    {
        args: [
            { kind: "string", name: "cursor", optional: true },
            { kind: "number", name: "limit", optional: true },
        ],
        kind: "query",
        path: "messages:list",
    },
    {
        args: [
            { kind: "string", name: "text", optional: false },
            { kind: "string", name: "roomId", optional: false },
        ],
        kind: "mutation",
        path: "messages:send",
    },
    {
        args: [],
        kind: "action",
        path: "sync:stripe",
    },
];

/**
 * Minimal mock exposing only the methods the tools touch.
 *
 * `url` + `getAuthToken` are part of that surface now: the write-confirmation
 * digest is keyed by the deployment's identity, which is exactly those two.
 * `deploymentUrl` lets a test mint a client for a *different* deployment and
 * check that its digests don't carry over.
 */
const mockClient = (
    deploymentUrl = "https://app.example.workers.dev",
    token = "admin-token",
): {
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
    const listFunctions = vi.fn<() => Promise<FunctionDescriptor[]>>(async () => MOCK_FUNCTIONS);
    const listGlobalTables = vi.fn<() => Promise<{ columns: string[]; name: string }[]>>(async () => [{ columns: ["email"], name: "users" }]);
    const mutation = vi.fn<() => Promise<{ id: string }>>(async () => {
        return { id: "m1" };
    });
    const query = vi.fn<() => Promise<{ count: number }>>(async () => {
        return { count: 7 };
    });

    const client = {
        action,
        getAuthToken: () => token,
        listFunctions,
        listGlobalTables,
        mutation,
        query,
        url: deploymentUrl,
    } as unknown as LunoraClient;

    return { action, asClient: client, listFunctions, listGlobalTables, mutation, query };
};

/** The parsed `action_required` payload a first write call returns. */
interface ActionRequired {
    actionDigest: string;
    nextStep: string;
    proposedAction: {
        args: Record<string, unknown>;
        functionPath: string;
        idempotencyKey?: string;
        kind: string;
        shardKey?: string;
        tool: string;
    };
    status: string;
}

const parseResult = (result: ToolResult): unknown => JSON.parse(result.content[0]!.text);

/** Step one of the handshake: propose the write and read back its digest. */
const propose = async (client: LunoraClient, name: string, input: Record<string, unknown>): Promise<ActionRequired> =>
    parseResult(await callTool(client, name, input, true)) as ActionRequired;

/** Both steps, for the tests that care about what happens AFTER a valid confirmation. */
const proposeAndConfirm = async (client: LunoraClient, name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const { actionDigest } = await propose(client, name, input);

    return callTool(client, name, { ...input, actionDigest, confirmed: true }, true);
};

describe("toolDefinitions", () => {
    it("exposes only the read-only and error tools by default (writes disabled, no admin token)", () => {
        expect.assertions(3);

        const names = toolDefinitions(false).map((tool) => tool.name);

        expect(names).toStrictEqual(["lunora_list_functions", "lunora_list_tables", "lunora_get_function_schema", "lunora_run_query", "lunora_explain_error"]);
        // Not in the default tier: it returns raw rows through the ADMIN writer,
        // so RLS and column masks do not apply to what it hands the model.
        expect(names).not.toContain("lunora_find_related");
        expect(toolDefinitions(false).every((tool) => tool.inputSchema.type === "object")).toBe(true);
    });

    it("adds the mutation/action tools when writes are enabled", () => {
        expect.assertions(2);

        const names = toolDefinitions(true).map((tool) => tool.name);

        expect(names).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
            "lunora_explain_error",
            "lunora_run_mutation",
            "lunora_run_action",
        ]);
        expect(names).toHaveLength(READ_ONLY_TOOL_DEFINITIONS.length + ERROR_TOOL_DEFINITIONS.length + WRITE_TOOL_DEFINITIONS.length);
    });
});

describe("callTool", () => {
    it("lunora_list_functions returns the function list as JSON text", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_list_functions", {});

        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual(MOCK_FUNCTIONS);
    });

    it("lunora_get_function_schema returns kind + args for a known function path", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_get_function_schema", { functionPath: "messages:list" });

        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual({
            args: [
                { kind: "string", name: "cursor", optional: true },
                { kind: "number", name: "limit", optional: true },
            ],
            kind: "query",
            path: "messages:list",
        });
    });

    it("lunora_get_function_schema returns an error result for an unknown function path", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_get_function_schema", { functionPath: "no:such" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("no:such");
    });

    it("lunora_get_function_schema returns an error result when functionPath is missing", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_get_function_schema", {});

        expect(result.isError).toBe(true);
        expect(mock.listFunctions).not.toHaveBeenCalled();
    });

    it("lunora_get_function_schema returns an error result when functionPath is empty", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_get_function_schema", { functionPath: "" });

        expect(result.isError).toBe(true);
        expect(mock.listFunctions).not.toHaveBeenCalled();
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

        await proposeAndConfirm(mock.asClient, "lunora_run_mutation", { functionPath: "messages:send" });

        expect(mock.mutation).toHaveBeenCalledWith({ __lunoraRef: "messages:send" }, {}, { shardKey: undefined });
    });

    it("coerces an empty-string shardKey to undefined so the unsharded default is used", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await callTool(mock.asClient, "lunora_run_query", { args: {}, functionPath: "messages:list", shardKey: "" });

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: "messages:list" }, {}, { shardKey: undefined });
    });

    it("rejects a non-object args payload (e.g. an array) with an error result instead of coercing to {}", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_query", { args: [1, 2, 3], functionPath: "messages:list" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("args");
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("parses a JSON-stringified args object (as LLMs commonly emit) and forwards it", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await callTool(mock.asClient, "lunora_run_query", { args: '{"limit":5}', functionPath: "messages:list" });

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: "messages:list" }, { limit: 5 }, { shardKey: undefined });
    });

    it("rejects an args string that is not valid JSON with an error result", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_query", { args: "not json", functionPath: "messages:list" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("args");
        expect(mock.query).not.toHaveBeenCalled();
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

        const result = await proposeAndConfirm(mock.asClient, "lunora_run_mutation", { functionPath: "messages:send" });

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

        const result = await proposeAndConfirm(mock.asClient, "lunora_run_action", { functionPath: "sync:stripe" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("boom");
    });

    it("refuses a write tool when writes are disabled (read-only default), without touching the client", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_mutation", { functionPath: "messages:send" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("read-only");
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("rejects a run whose functionPath is not a discovered public function", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_query", { functionPath: "internal:secret" });

        expect(result.isError).toBe(true);
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("rejects running a mutation through the query tool (kind mismatch)", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:send" });

        expect(result.isError).toBe(true);
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("serializes a bigint result (v.int64) as a decimal string instead of throwing", async () => {
        expect.assertions(3);

        const mock = mockClient();

        // `decodeWire` revives a `v.int64()` leaf as a real bigint; raw
        // `JSON.stringify` would throw and mis-report the success as a tool error.
        mock.query.mockResolvedValueOnce({ count: 7, id: 9_007_199_254_740_993n });

        const result = await callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" });

        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual({ count: 7, id: "9007199254740993" });
        expect(result.content[0]!.text).not.toContain("BigInt");
    });

    it("serializes ArrayBuffer / typed-array (v.bytes) results as base64 instead of {} or an index-keyed object", async () => {
        expect.assertions(3);

        const mock = mockClient();

        mock.query.mockResolvedValueOnce({ blob: new Uint8Array([1, 2, 3]).buffer, view: new Uint8Array([1, 2, 3]) });

        const result = await callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" });

        expect(result.isError).toBeUndefined();
        // btoa of bytes [1,2,3] is "AQID"; a raw stringify would yield {} for the
        // ArrayBuffer and {"0":1,"1":2,"2":3} for the Uint8Array.
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual({ blob: "AQID", view: "AQID" });
        expect(result.content[0]!.text).not.toContain('"0"');
    });

    it("caches listFunctions across run-tool calls on the same client (one fetch, not one per call)", async () => {
        expect.assertions(3);

        const mock = mockClient();

        await callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" });
        await callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" });
        await callTool(mock.asClient, "lunora_get_function_schema", { functionPath: "messages:list" });

        // Three tool calls that each need the registry share a single fetch.
        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
        expect(mock.query).toHaveBeenCalledTimes(2);
        expect(mock.query).toHaveBeenLastCalledWith({ __lunoraRef: "messages:list" }, {}, { shardKey: undefined });
    });

    it("shares one in-flight listFunctions fetch across concurrent run-tool calls", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await Promise.all([
            callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" }),
            callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" }),
        ]);

        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
    });

    it("lunora_find_related calls the findRelated admin op with the traversal options", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(
            mock.asClient,
            "lunora_find_related",
            {
                depth: 2,
                direction: "in",
                edges: ["tickets.customerId"],
                id: "c1",
                limit: 10,
                shardKey: "org-1",
                table: "customers",
            },
            false,
            false,
            true,
        );

        expect(result.isError).toBeUndefined();
        expect(mock.query).toHaveBeenCalledWith(
            { __lunoraRef: ADMIN_FUNCTIONS.findRelated },
            { depth: 2, direction: "in", edges: ["tickets.customerId"], id: "c1", limit: 10, table: "customers" },
            { shardKey: "org-1" },
        );
        // Advertised read-only (it writes nothing), but gated with the
        // observability tier rather than the write tier — the risk it carries is
        // disclosure, not mutation.
        expect(ROW_READ_TOOL_DEFINITIONS.find((tool) => tool.name === "lunora_find_related")?.annotations?.readOnlyHint).toBe(true);
    });

    it("lunora_find_related omits absent options rather than sending undefined", async () => {
        expect.assertions(1);

        const mock = mockClient();

        await callTool(mock.asClient, "lunora_find_related", { id: "c1", table: "customers" }, false, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.findRelated }, { id: "c1", table: "customers" }, {});
    });

    it("lunora_find_related is refused at dispatch without the data-reads opt-in", async () => {
        expect.assertions(3);

        const mock = mockClient();
        // Omission is not the guarantee — a client that ignores the advertised
        // list must still be refused, and must not reach the deployment.
        const result = await callTool(mock.asClient, "lunora_find_related", { id: "c1", table: "customers" });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("LUNORA_MCP_ALLOW_DATA_READS");
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("lunora_find_related refuses a call with no table or id", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const noTable = await callTool(mock.asClient, "lunora_find_related", { id: "c1" }, false, false, true);
        const noId = await callTool(mock.asClient, "lunora_find_related", { table: "customers" }, false, false, true);

        expect(noTable.isError).toBe(true);
        expect(noId.isError).toBe(true);
    });

    it("does not cache a failed listFunctions fetch (a later call retries)", async () => {
        expect.assertions(3);

        const mock = mockClient();

        mock.listFunctions.mockRejectedValueOnce(new Error("registry offline"));

        const failed = await callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" });

        expect(failed.isError).toBe(true);

        // The rejected fetch is evicted, so the next call refetches and succeeds.
        const ok = await callTool(mock.asClient, "lunora_run_query", { functionPath: "messages:list" });

        expect(ok.isError).toBeUndefined();
        expect(mock.listFunctions).toHaveBeenCalledTimes(2);
    });
});

/**
 * The write-confirmation handshake.
 *
 * `allowWrites` answers "may this server write at all"; it never answered "was
 * THIS write reviewed". These cover the second question: the first call must be
 * inert, the second must be bound to the exact action the first proposed, and
 * neither may weaken the `allowWrites` gate that still sits in front of both.
 */
describe("write confirmation handshake", () => {
    it("returns action_required on the first call and executes nothing", async () => {
        expect.assertions(5);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_mutation", { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" }, true);
        const payload = parseResult(result) as ActionRequired;

        expect(result.isError).toBeUndefined();
        expect(payload.status).toBe("action_required");
        expect(payload.proposedAction).toStrictEqual({
            args: { roomId: "r1", text: "hi" },
            functionPath: "messages:send",
            kind: "mutation",
            tool: "lunora_run_mutation",
        });
        expect(payload.actionDigest).toMatch(/^[\w-]{20,}$/);
        // The whole point: proposing must not write.
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("executes once the matching digest comes back with confirmed: true", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" };
        const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", input);
        const result = await callTool(mock.asClient, "lunora_run_mutation", { ...input, actionDigest, confirmed: true }, true);

        expect(result.isError).toBeUndefined();
        expect(mock.mutation).toHaveBeenCalledWith({ __lunoraRef: "messages:send" }, { roomId: "r1", text: "hi" }, { shardKey: undefined });
        expect(parseResult(result)).toStrictEqual({ id: "m1" });
    });

    it("rejects a digest issued for different args and writes nothing", async () => {
        expect.assertions(3);

        const mock = mockClient();
        // Reviewed: a message to room r1. Submitted: the same call aimed at r2.
        const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" });
        const result = await callTool(
            mock.asClient,
            "lunora_run_mutation",
            { actionDigest, args: { roomId: "r2", text: "hi" }, confirmed: true, functionPath: "messages:send" },
            true,
        );

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("confirmation rejected");
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("binds every field the proposal exposes, so a field added later cannot slip past the digest", async () => {
        expect.assertions(4);

        const mock = mockClient();
        const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send", idempotencyKey: "k1", shardKey: "room-1" };
        const { actionDigest, proposedAction } = await propose(mock.asClient, "lunora_run_mutation", input);

        // The exhaustiveness gate, and the reason `canonicalize` signs the
        // proposal WHOLE rather than listing its fields. Signing it whole means a
        // new field is digest-bound the moment it exists — but it would also be
        // shown to the human here with no tamper coverage below. Failing this
        // list is the prompt to add that coverage; widening it silently is the
        // mistake it exists to catch.
        expect(Object.keys(proposedAction).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "args",
            "functionPath",
            "idempotencyKey",
            "kind",
            "shardKey",
            "tool",
        ]);

        // Each caller-settable field changed one at a time, replayed under the
        // digest a human approved for the ORIGINAL values. (`tool` and `kind`
        // are covered by the mutation-digest-cannot-confirm-an-action test.)
        const refusals = await Promise.all(
            [
                { ...input, args: { roomId: "r2", text: "hi" } },
                { ...input, idempotencyKey: "k2" },
                { ...input, shardKey: "room-2" },
            ].map(async (variant) => callTool(mock.asClient, "lunora_run_mutation", { ...variant, actionDigest, confirmed: true }, true)),
        );

        expect(refusals.map((refusal) => refusal.isError)).toStrictEqual([true, true, true]);
        expect(refusals.every((refusal) => refusal.content[0]!.text.includes("confirmation rejected"))).toBe(true);
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("rejects a digest issued for a different shardKey", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const args = { roomId: "r1", text: "hi" };
        const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", { args, functionPath: "messages:send", shardKey: "room-1" });
        const result = await callTool(
            mock.asClient,
            "lunora_run_mutation",
            { actionDigest, args, confirmed: true, functionPath: "messages:send", shardKey: "room-2" },
            true,
        );

        expect(result.isError).toBe(true);
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("is unaffected by argument key order — the digest is over a canonical form", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", {
            args: { roomId: "r1", text: "hi" },
            functionPath: "messages:send",
        });
        // Same arguments, keys typed in the other order — a re-serialization an
        // MCP client or model can do for free. It must still be the same action.
        const result = await callTool(
            mock.asClient,
            "lunora_run_mutation",
            { actionDigest, args: { text: "hi", roomId: "r1" }, confirmed: true, functionPath: "messages:send" },
            true,
        );

        expect(result.isError).toBeUndefined();
        expect(mock.mutation).toHaveBeenCalledTimes(1);
    });

    it("does not let a mutation's digest confirm an action", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", { functionPath: "messages:send" });
        const result = await callTool(mock.asClient, "lunora_run_action", { actionDigest, confirmed: true, functionPath: "sync:stripe" }, true);

        expect(result.isError).toBe(true);
        expect(mock.action).not.toHaveBeenCalled();
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("does not honour a digest minted against a different deployment", async () => {
        expect.assertions(2);

        const staging = mockClient("https://staging.example.workers.dev");
        const production = mockClient("https://prod.example.workers.dev");
        const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" };
        const { actionDigest } = await propose(staging.asClient, "lunora_run_mutation", input);
        const result = await callTool(production.asClient, "lunora_run_mutation", { ...input, actionDigest, confirmed: true }, true);

        expect(result.isError).toBe(true);
        expect(production.mutation).not.toHaveBeenCalled();
    });

    it("re-proposes instead of executing when confirmed: true arrives without a digest", async () => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_run_action", { confirmed: true, functionPath: "sync:stripe" }, true);
        const payload = parseResult(result) as ActionRequired;

        expect(result.isError).toBeUndefined();
        expect(payload.status).toBe("action_required");
        expect(mock.action).not.toHaveBeenCalled();
    });

    it("binds the idempotencyKey into the digest: same key replays, a new key needs its own review", async () => {
        expect.assertions(4);

        const mock = mockClient();
        const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send", idempotencyKey: "retry-1" };
        const first = await propose(mock.asClient, "lunora_run_mutation", input);

        expect(first.proposedAction.idempotencyKey).toBe("retry-1");

        // Same key, same args — the digest a timed-out client already holds.
        const replay = await propose(mock.asClient, "lunora_run_mutation", input);

        expect(replay.actionDigest).toBe(first.actionDigest);

        // A deliberately-second identical write under a new key is a new action,
        // so it cannot ride the first review's digest.
        const relabelled = await callTool(
            mock.asClient,
            "lunora_run_mutation",
            { ...input, actionDigest: first.actionDigest, confirmed: true, idempotencyKey: "retry-2" },
            true,
        );

        expect(relabelled.isError).toBe(true);
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    it("keeps the allowWrites gate in front of the handshake: a valid digest is still refused", async () => {
        expect.assertions(4);

        const mock = mockClient();
        const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" };
        // Mint a genuinely valid confirmation on a writes-enabled server...
        const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", input);
        // ...then present it to a read-only one.
        const result = await callTool(mock.asClient, "lunora_run_mutation", { ...input, actionDigest, confirmed: true });

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("read-only");
        expect(mock.mutation).not.toHaveBeenCalled();
        // And the tools stay omitted from the advertised list, not merely refused.
        expect(toolDefinitions(false).map((tool) => tool.name)).not.toContain("lunora_run_mutation");
    });

    it("advertises the confirmation fields on both write tools", () => {
        expect.assertions(3);

        const names = WRITE_TOOL_DEFINITIONS.map((tool) => tool.name);
        const hasConfirmationFields = WRITE_TOOL_DEFINITIONS.every((tool) =>
            ["actionDigest", "confirmed", "idempotencyKey"].every((key) => key in tool.inputSchema.properties),
        );

        expect(names).toStrictEqual(["lunora_run_mutation", "lunora_run_action"]);
        expect(hasConfirmationFields).toBe(true);
        // Only `functionPath` may be required — the first call is the one that
        // proposes, so it cannot be made to carry a digest.
        expect(WRITE_TOOL_DEFINITIONS.every((tool) => tool.inputSchema.required?.length === 1)).toBe(true);
    });
});
