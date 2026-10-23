import type { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { callFunctionTool } from "../src/function-server";
import { functionToolsFromOpenRpc } from "../src/function-tools";
import type { ToolResult } from "../src/tool-types";
import method from "./_helpers/openrpc";

const SPEC = {
    methods: [
        method("counter:get", "query", { args: { amount: { format: "int64", type: "string" } } }),
        method("messages:send", "mutation", { args: { text: { type: "string" } }, argsRequired: true }),
        method("messages:list", "query", { result: { items: { type: "string" }, type: "array" } }),
        method("billing:charge", "mutation", { args: { card: { type: "string", writeOnly: true } }, argsRequired: true }),
    ],
    openrpc: "1.3.2",
};

const textOf = (result: ToolResult): unknown => JSON.parse(result.content[0]?.text ?? "null");

/** A client that records every call. Each method resolves to a value the test controls. */
const mockClient = (token: string | null = "caller-token") => {
    const query = vi.fn<() => Promise<unknown>>(async () => {
        return { total: 7 };
    });
    const mutation = vi.fn<() => Promise<unknown>>(async () => {
        return { id: "m1" };
    });
    const action = vi.fn<() => Promise<unknown>>(async () => {
        return { ran: true };
    });
    const client = {
        action,
        getAuthToken: () => token,
        mutation,
        query,
        url: "https://app.example.workers.dev",
    } as unknown as LunoraClient;

    return { action, client, mutation, query };
};

const routesFor = (allowWrites: boolean) => functionToolsFromOpenRpc(SPEC, { allowWrites }).routes;

describe("callFunctionTool — queries", () => {
    it("runs the query as the caller with its arguments decoded, and returns the value", async () => {
        expect.assertions(2);

        const { client, query } = mockClient();
        const result = await callFunctionTool(client, routesFor(false), "counter_get", { args: { amount: "42" } }, false);

        expect(query).toHaveBeenCalledWith({ __lunoraRef: "counter:get" }, { amount: 42n }, { shardKey: undefined });
        expect(textOf(result)).toEqual({ total: 7 });
    });

    it("returns a non-object declared output as structuredContent wrapped in result", async () => {
        expect.assertions(1);

        const { client, query } = mockClient();

        query.mockResolvedValueOnce(["a", "b"]);
        const result = await callFunctionTool(client, routesFor(false), "messages_list", {}, false);

        expect(result.structuredContent).toEqual({ result: ["a", "b"] });
    });

    it("turns a thrown client error into an error result rather than rejecting", async () => {
        expect.assertions(1);

        const { client, query } = mockClient();

        query.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "FORBIDDEN" }));
        const result = await callFunctionTool(client, routesFor(false), "counter_get", {}, false);

        expect(result.isError).toBe(true);
    });

    it("returns NOT_FOUND for a tool the spec does not list", async () => {
        expect.assertions(1);

        const { client } = mockClient();
        const result = await callFunctionTool(client, routesFor(false), "nope", {}, false);

        expect(result.content[0]?.text).toContain("NOT_FOUND");
    });
});

describe("callFunctionTool — writes", () => {
    it("refuses a mutation with FORBIDDEN when writes are off, and never calls the client", async () => {
        expect.assertions(2);

        const { client, mutation } = mockClient();
        const result = await callFunctionTool(client, routesFor(false), "messages_send", { args: { text: "hi" } }, false);

        expect(result.content[0]?.text).toContain("FORBIDDEN");
        expect(mutation).not.toHaveBeenCalled();
    });

    it("returns a proposal on the first call and runs nothing", async () => {
        expect.assertions(3);

        const { client, mutation } = mockClient();
        const result = await callFunctionTool(client, routesFor(true), "messages_send", { args: { text: "hi" } }, true);
        const payload = textOf(result) as { actionDigest: string; status: string };

        expect(payload.status).toBe("action_required");
        expect(payload.actionDigest).toMatch(/^\d{13}\.[\w-]{20,}$/);
        expect(mutation).not.toHaveBeenCalled();
    });

    it("runs the mutation once the proposal's digest is confirmed, online only", async () => {
        expect.assertions(1);

        const { client, mutation } = mockClient();
        const routes = routesFor(true);
        const args = { text: "hi" };
        const proposal = textOf(await callFunctionTool(client, routes, "messages_send", { args }, true)) as { actionDigest: string };

        await callFunctionTool(client, routes, "messages_send", { args, actionDigest: proposal.actionDigest, confirmed: true }, true);

        expect(mutation).toHaveBeenCalledWith({ __lunoraRef: "messages:send" }, args, { onlineOnly: true, shardKey: undefined });
    });

    it("refuses a confirmation whose arguments changed since the proposal", async () => {
        expect.assertions(2);

        const { client, mutation } = mockClient();
        const routes = routesFor(true);
        const proposal = textOf(await callFunctionTool(client, routes, "messages_send", { args: { text: "hi" } }, true)) as { actionDigest: string };
        const result = await callFunctionTool(
            client,
            routes,
            "messages_send",
            { args: { text: "changed" }, actionDigest: proposal.actionDigest, confirmed: true },
            true,
        );

        expect(result.isError).toBe(true);
        expect(mutation).not.toHaveBeenCalled();
    });

    it("calls a sensitive-argument mutation through a sensitive reference, so it is never queued", async () => {
        expect.assertions(1);

        const { client, mutation } = mockClient();
        const routes = routesFor(true);
        const args = { card: "4242" };
        const proposal = textOf(await callFunctionTool(client, routes, "billing_charge", { args }, true)) as { actionDigest: string };

        await callFunctionTool(client, routes, "billing_charge", { args, actionDigest: proposal.actionDigest, confirmed: true }, true);

        expect(mutation).toHaveBeenCalledWith({ __lunoraRef: "billing:charge", sensitive: true }, args, { onlineOnly: true, shardKey: undefined });
    });

    it("refuses a write without a bearer token, and names the bearer rather than an admin token", async () => {
        expect.assertions(2);

        const { client, mutation } = mockClient(null);
        const result = await callFunctionTool(client, routesFor(true), "messages_send", { args: { text: "hi" } }, true);

        expect(result.content[0]?.text).toContain("bearer token");
        expect(mutation).not.toHaveBeenCalled();
    });
});
