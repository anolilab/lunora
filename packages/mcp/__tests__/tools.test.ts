import type { FunctionDescriptor, LunoraClient } from "@lunora/client";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { describe, expect, it, vi } from "vitest";

import { ERROR_TOOL_DEFINITIONS } from "../src/error-tools";
import type { ToolResult } from "../src/tools";
import { callTool, READ_ONLY_TOOL_DEFINITIONS, ROW_READ_TOOL_DEFINITIONS, toolDefinitions, WRITE_TOOL_DEFINITIONS } from "../src/tools";
import { CONFIRMATION_TTL_MS } from "../src/write-confirmation";

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
    expiresAt: string;
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

/**
 * One row per gated tool family, so every gate is held to the SAME contract
 * rather than whichever half of it its own test happened to cover.
 *
 * `flag` is the position of that family's opt-in in the
 * `(allowWrites, allowObservability, allowDataReads)` triple both exported
 * helpers take.
 */
const GATED_FAMILIES = [
    { envVariable: "LUNORA_MCP_ALLOW_WRITES", flag: 0, tool: "lunora_run_mutation" },
    { envVariable: "LUNORA_MCP_ALLOW_OBSERVABILITY", flag: 1, tool: "lunora_get_logs" },
    { envVariable: "LUNORA_MCP_ALLOW_DATA_READS", flag: 2, tool: "lunora_find_related" },
] as const;

/** The opt-in triple with `flag` set to `value` and every other gate closed. */
const gates = (flag: number, value: unknown): [boolean, boolean, boolean] => {
    const triple: unknown[] = [false, false, false];

    triple[flag] = value;

    return triple as [boolean, boolean, boolean];
};

/** Nothing reached the deployment — a refusal must not even resolve the function registry. */
const expectDeploymentUntouched = (mock: ReturnType<typeof mockClient>): void => {
    expect(mock.listFunctions).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.mutation).not.toHaveBeenCalled();
    expect(mock.action).not.toHaveBeenCalled();
};

/**
 * The gate contract, per family.
 *
 * Each gate must do BOTH halves: omit its tools from the advertised list, and
 * refuse them at dispatch. Omission alone is not the guarantee — a client that
 * ignores the advertised list must still be refused — and a refusal alone would
 * put a tool an agent cannot use in front of it on every turn.
 */
describe("tool family gates", () => {
    it.each(GATED_FAMILIES)("omits $tool from the advertised list until $envVariable opts in", ({ flag, tool }) => {
        expect.assertions(2);

        expect(toolDefinitions(...gates(flag, false)).map((definition) => definition.name)).not.toContain(tool);
        expect(toolDefinitions(...gates(flag, true)).map((definition) => definition.name)).toContain(tool);
    });

    it.each(GATED_FAMILIES)(
        "refuses $tool at dispatch without $envVariable, naming it, and never reaches the deployment",
        async ({ envVariable, flag, tool }) => {
            expect.assertions(6);

            const mock = mockClient();
            const result = await callTool(mock.asClient, tool, { functionPath: "messages:send", id: "c1", table: "customers" }, ...gates(flag, false));

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain(envVariable);

            expectDeploymentUntouched(mock);
        },
    );

    /**
     * Fail closed: only the boolean `true` opts in. These flags are plumbed from
     * env vars through exported helpers, so a caller that forwarded the RAW
     * string would otherwise open every gate with `"false"` — the single value
     * most likely to be forwarded by someone meaning the opposite.
     */
    it.each(GATED_FAMILIES)("keeps $tool closed for a truthy non-boolean opt-in ($envVariable)", async ({ flag, tool }) => {
        expect.assertions(10);

        for (const truthy of ["false", "0", 1]) {
            expect(toolDefinitions(...gates(flag, truthy)).map((definition) => definition.name)).not.toContain(tool);
        }

        const mock = mockClient();

        for (const truthy of ["false", "0", 1]) {
            // eslint-disable-next-line no-await-in-loop -- three sequential probes over one mock; concurrency would only obscure which value leaked.
            const result = await callTool(mock.asClient, tool, { functionPath: "messages:send", id: "c1", table: "customers" }, ...gates(flag, truthy));

            expect(result.isError).toBe(true);
        }

        expectDeploymentUntouched(mock);
    });

    it("keeps lunora_explain_error exposed and dispatchable with every gate closed", async () => {
        expect.assertions(3);

        const mock = mockClient();

        expect(toolDefinitions(false).map((definition) => definition.name)).toContain("lunora_explain_error");

        const result = await callTool(mock.asClient, "lunora_explain_error", { code: "CONFLICT" }, false, false, false);

        expect(result.isError).toBeUndefined();
        // Answered from the compiled-in catalog: no deployment is consulted.
        expect(mock.query).not.toHaveBeenCalled();
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
        // `<expiresAt>.<signature>`: the deadline is carried in the digest
        // itself, because a stateless server has nowhere else to keep it.
        expect(payload.actionDigest).toMatch(/^\d{13}\.[\w-]{20,}$/);
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

        // Same key, same args — the digest a timed-out client already holds still
        // confirms, inside its window. (The digest STRING is no longer identical
        // across two proposals, because each carries its own deadline; what the
        // key buys is that the one already in hand keeps working.)
        const replay = await callTool(mock.asClient, "lunora_run_mutation", { ...input, actionDigest: first.actionDigest, confirmed: true }, true);

        expect(replay.isError).toBeUndefined();

        // A deliberately-second identical write under a new key is a new action,
        // so it cannot ride the first review's digest.
        const relabelled = await callTool(
            mock.asClient,
            "lunora_run_mutation",
            { ...input, actionDigest: first.actionDigest, confirmed: true, idempotencyKey: "retry-2" },
            true,
        );

        expect(relabelled.isError).toBe(true);
        // Only the in-window replay ran; the relabelled call wrote nothing.
        expect(mock.mutation).toHaveBeenCalledTimes(1);
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

    /**
     * The window, which is the part of "was this reviewed" a stateless server
     * can actually enforce.
     *
     * The handshake binds INTENT, not human presence — a client that confirms
     * its own proposal is indistinguishable from one that asked somebody, and no
     * server-side check can separate them (see `../src/write-confirmation`). What
     * an expiry removes is the OTHER half of the original finding: a digest that
     * outlives its review, so one approved `payments:refund` stays confirmable in
     * every later session for as long as the deployment URL and admin bearer
     * hold. These pin that window shut.
     */
    it("refuses a digest past its window and writes nothing", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        try {
            const mock = mockClient();
            const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" };
            const { actionDigest, expiresAt } = await propose(mock.asClient, "lunora_run_mutation", input);

            expect(Date.parse(expiresAt)).toBe(Date.now() + CONFIRMATION_TTL_MS);

            // One millisecond past the deadline the digest itself carries.
            vi.setSystemTime(Date.now() + CONFIRMATION_TTL_MS + 1);

            const result = await callTool(mock.asClient, "lunora_run_mutation", { ...input, actionDigest, confirmed: true }, true);

            expect(result.isError).toBe(true);
            // Refused as EXPIRED, not re-proposed: a fresh digest handed back to a
            // call that said `confirmed: true` reads like an accepted confirmation.
            expect(result.content[0]!.text).toContain("has expired");
            expect(mock.mutation).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("still honours a digest inside its window", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const mock = mockClient();
            const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" };
            const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", input);

            // A human taking most of the window to read the proposal.
            vi.setSystemTime(Date.now() + CONFIRMATION_TTL_MS - 1000);

            const result = await callTool(mock.asClient, "lunora_run_mutation", { ...input, actionDigest, confirmed: true }, true);

            expect(result.isError).toBeUndefined();
            expect(mock.mutation).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not let a forged deadline extend a digest", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        try {
            const mock = mockClient();
            const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" };
            const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", input);
            // The deadline travels in the clear, so a holder can edit it — but it
            // is signed alongside the proposal, so editing it breaks the signature.
            const signature = actionDigest.slice(actionDigest.indexOf(".") + 1);
            const forged = `${String(Date.now() + 10 * CONFIRMATION_TTL_MS)}.${signature}`;

            vi.setSystemTime(Date.now() + CONFIRMATION_TTL_MS + 1);

            const result = await callTool(mock.asClient, "lunora_run_mutation", { ...input, actionDigest: forged, confirmed: true }, true);

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain("does not match this call");
            expect(mock.mutation).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("treats a digest with no deadline or a junk deadline as a mismatch", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const input = { args: { roomId: "r1", text: "hi" }, functionPath: "messages:send" };
        const { actionDigest } = await propose(mock.asClient, "lunora_run_mutation", input);
        const signature = actionDigest.slice(actionDigest.indexOf(".") + 1);
        // Shapes that reach here straight out of the model's arguments bag: the
        // pre-expiry digest format, and a deadline that is not an integer.
        const malformed = [signature, `1e99.${signature}`, `.${signature}`, `-1.${signature}`, "not-a-digest"];

        const refusals = await Promise.all(
            malformed.map(async (candidate) => callTool(mock.asClient, "lunora_run_mutation", { ...input, actionDigest: candidate, confirmed: true }, true)),
        );

        expect(refusals.every((refusal) => refusal.isError === true)).toBe(true);
        expect(mock.mutation).not.toHaveBeenCalled();
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
