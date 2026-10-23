import { describe, expect, it } from "vitest";

import { functionToolsFromOpenRpc, toolNameOf } from "../src/function-tools";
import method from "./_helpers/openrpc";

const spec = (...methods: Record<string, unknown>[]): Record<string, unknown> => {
    return {
        info: { title: "Lunora RPC", version: "0.0.0" },
        methods,
        openrpc: "1.3.2",
    };
};

const LIST = method("messages:list", "query", { args: { limit: { type: "integer" } } });
const SEND = method("messages:send", "mutation", { args: { text: { type: "string" } }, argsRequired: true });
const SYNC = method("sync:stripe", "action");

describe("functionToolsFromOpenRpc", () => {
    it("exposes queries always and writes only when allowed", () => {
        expect.assertions(2);

        const names = (allowWrites: boolean) =>
            functionToolsFromOpenRpc(spec(LIST, SEND, SYNC), { allowWrites })
                .definitions.map((tool) => tool.name)
                .toSorted((a, b) => a.localeCompare(b));

        expect(names(false)).toEqual(["messages_list"]);
        expect(names(true)).toEqual(["messages_list", "messages_send", "sync_stripe"]);
    });

    it("gives writes the handshake fields and write annotations, and queries read-only annotations", () => {
        expect.assertions(5);

        const { definitions } = functionToolsFromOpenRpc(spec(LIST, SEND), { allowWrites: true });
        const list = definitions.find((tool) => tool.name === "messages_list");
        const send = definitions.find((tool) => tool.name === "messages_send");

        expect(list?.annotations).toMatchObject({ readOnlyHint: true });
        expect(list?.inputSchema.properties).not.toHaveProperty("confirmed");
        expect(send?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false, readOnlyHint: false });
        expect(send?.inputSchema.properties).toHaveProperty("confirmed");
        expect(send?.inputSchema.properties).toHaveProperty("actionDigest");
    });

    it("nests the argument schema under args and keeps shardKey optional", () => {
        expect.assertions(4);

        const { definitions } = functionToolsFromOpenRpc(spec(SEND), { allowWrites: true });
        const [send] = definitions;
        const [sendArgs] = SEND["params"] as Record<string, unknown>[];

        expect(send?.inputSchema.properties?.["args"]).toEqual(sendArgs?.["schema"]);
        expect(send?.inputSchema.required).toEqual(["args"]);
        expect(send?.inputSchema.properties).toHaveProperty("shardKey");
        expect(send?.inputSchema.required).not.toContain("shardKey");
    });

    it("leaves args optional when the function declares no arguments", () => {
        expect.assertions(1);

        const [tool] = functionToolsFromOpenRpc(spec(method("clock:now", "query")), { allowWrites: false }).definitions;

        expect(tool?.inputSchema.required).toEqual([]);
    });

    it("sanitises a namespace with a slash into a valid tool name", () => {
        expect.assertions(2);

        const [tool] = functionToolsFromOpenRpc(spec(method("billing/invoices:create", "query")), { allowWrites: false }).definitions;

        expect(toolNameOf("billing/invoices:create")).toBe("billing_invoices_create");
        expect(tool?.name).toBe("billing_invoices_create");
    });

    it("throws when two functions sanitise to the same tool name", () => {
        expect.assertions(1);

        expect(() => functionToolsFromOpenRpc(spec(method("a/b:c", "query"), method("a_b:c", "query")), { allowWrites: false })).toThrow(
            /both map to the MCP tool name "a_b_c"/,
        );
    });

    it("throws for a tool name longer than 64 characters", () => {
        expect.assertions(1);

        const long = `${"a".repeat(70)}:fn`;

        expect(() => functionToolsFromOpenRpc(spec(method(long, "query")), { allowWrites: false })).toThrow(/the limit is 64/);
    });

    it("throws for a document without a methods array", () => {
        expect.assertions(2);

        expect(() => functionToolsFromOpenRpc({ info: {} }, { allowWrites: false })).toThrow(/openRpcSpec must be the OpenRPC document/);
        expect(() => functionToolsFromOpenRpc(null, { allowWrites: false })).toThrow(/openRpcSpec must be the OpenRPC document/);
    });

    it("skips a method whose kind is not invocable over RPC", () => {
        expect.assertions(1);

        const { definitions } = functionToolsFromOpenRpc(spec(method("feed:tail", "stream"), LIST), { allowWrites: true });

        expect(definitions.map((tool) => tool.name)).toEqual(["messages_list"]);
    });

    it("omits outputSchema for the placeholder result", () => {
        expect.assertions(1);

        const [tool] = functionToolsFromOpenRpc(spec(LIST), { allowWrites: false }).definitions;

        expect(tool).not.toHaveProperty("outputSchema");
    });

    it("keeps a declared object output as the success branch of the outputSchema", () => {
        expect.assertions(2);

        const output = { properties: { id: { type: "string" } }, required: ["id"], type: "object" };
        const [tool] = functionToolsFromOpenRpc(spec(method("messages:get", "query", { result: output })), { allowWrites: false }).definitions;

        expect(tool?.outputSchema?.type).toBe("object");
        expect(tool?.outputSchema?.anyOf?.[0]).toEqual(output);
    });

    it("wraps a declared non-object output so the success branch has an object root", () => {
        expect.assertions(1);

        const [tool] = functionToolsFromOpenRpc(spec(method("messages:ids", "query", { result: { items: { type: "string" }, type: "array" } })), {
            allowWrites: false,
        }).definitions;

        expect(tool?.outputSchema?.anyOf?.[0]).toEqual({
            properties: { result: { items: { type: "string" }, type: "array" } },
            required: ["result"],
            type: "object",
        });
    });

    it("admits an error result under the outputSchema, so an SDK client does not reject it", () => {
        expect.assertions(1);

        const output = { properties: { id: { type: "string" } }, required: ["id"], type: "object" };
        const [tool] = functionToolsFromOpenRpc(spec(method("messages:get", "query", { result: output })), { allowWrites: false }).definitions;

        expect(tool?.outputSchema?.anyOf).toHaveLength(2);
    });

    it("gives a write no outputSchema, because its first call returns a proposal", () => {
        expect.assertions(1);

        const send = method("messages:send", "mutation", { args: { text: { type: "string" } }, result: { properties: {}, type: "object" } });
        const [tool] = functionToolsFromOpenRpc(spec(send), { allowWrites: true }).definitions;

        expect(tool).not.toHaveProperty("outputSchema");
    });

    it("marks writeOnly argument names as sensitive in the route", () => {
        expect.assertions(1);

        const { routes } = functionToolsFromOpenRpc(
            spec(method("billing:charge", "mutation", { args: { amount: { type: "integer" }, card: { type: "string", writeOnly: true } } })),
            { allowWrites: true },
        );

        expect(routes.get("billing_charge")?.sensitiveArgs).toEqual(["card"]);
    });

    it("keeps a closed write's route, so a direct call can be refused rather than reported unknown", () => {
        expect.assertions(2);

        const { definitions, routes } = functionToolsFromOpenRpc(spec(SEND), { allowWrites: false });

        expect(definitions).toEqual([]);
        expect(routes.get("messages_send")?.kind).toBe("mutation");
    });

    it("uses the author's doc comment as the description, and still ends a write with the handshake", () => {
        expect.assertions(2);

        const documented = { ...LIST, "x-lunora-description": "Lists the newest messages in a channel." };
        const documentedWrite = { ...SEND, "x-lunora-description": "Posts a message to a channel." };
        const { definitions } = functionToolsFromOpenRpc(spec(documented, documentedWrite), { allowWrites: true });

        expect(definitions.find((tool) => tool.name === "messages_list")?.description).toBe("Lists the newest messages in a channel.");
        expect(definitions.find((tool) => tool.name === "messages_send")?.description).toMatch(/^Posts a message to a channel\. The first call only proposes/);
    });

    it("falls back to the generated sentence when the export has no doc comment", () => {
        expect.assertions(1);

        const { definitions } = functionToolsFromOpenRpc(spec(LIST), { allowWrites: false });

        expect(definitions[0]?.description).toBe('Runs the query "messages:list". Read-only.');
    });
});
