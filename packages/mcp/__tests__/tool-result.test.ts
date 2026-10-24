import type { LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";

import type { McpTool } from "../src/compose";
import { createToolServer } from "../src/compose";
import { createLocalMcpServer } from "../src/local";
import { createLunoraMcpServer } from "../src/server";
import { errorFromThrown, errorResult, ok, okStructured } from "../src/tool-result";

describe("errorResult", () => {
    it("is isError with the code and message in both structuredContent and one text block", () => {
        expect.assertions(1);

        expect(errorResult("NOT_FOUND", "function not found: x")).toStrictEqual({
            content: [{ text: "NOT_FOUND: function not found: x", type: "text" }],
            isError: true,
            structuredContent: { code: "NOT_FOUND", message: "function not found: x" },
        });
    });
});

describe("errorFromThrown", () => {
    it("passes the message of a non-internal LunoraError through with its code", () => {
        expect.assertions(1);

        expect(errorFromThrown(new LunoraError("BAD_REQUEST", '"functionPath" is required'))).toStrictEqual(
            errorResult("BAD_REQUEST", '"functionPath" is required'),
        );
    });

    it("shows only the catalog title for an internal code, never its message", () => {
        expect.assertions(1);

        const result = errorFromThrown(new LunoraError("INTERNAL", "SQLITE_TOOBIG at table messages"));

        expect(result).toStrictEqual(errorResult("INTERNAL", "Internal error"));
    });

    it("keeps the catalog code and public message of an error the client rebuilt from a server rejection", () => {
        expect.assertions(2);

        const rebuilt = Object.assign(new Error("function not found or not public: messages:list"), {
            code: "NOT_FOUND",
            [Symbol.for("lunora.serverVerdict")]: true,
        });

        expect(errorFromThrown(rebuilt)).toStrictEqual(errorResult("NOT_FOUND", "function not found or not public: messages:list"));
        // An internal code still shows only its title, as for a LunoraError.
        expect(
            errorFromThrown(Object.assign(new Error("SQLITE_TOOBIG at table messages"), { code: "INTERNAL", [Symbol.for("lunora.serverVerdict")]: true })),
        ).toStrictEqual(errorResult("INTERNAL", "Internal error"));
    });

    it("keeps the code and message of a coded rejection from the admin path", async () => {
        expect.assertions(1);

        const { LunoraClient } = await import("@lunora/client");
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({ error: { code: "FORBIDDEN", message: "admin token rejected" } }, { status: 403 }),
        );
        const client = new LunoraClient({ fetch, url: "https://app.example" });

        const failure = await client.listFunctions().catch((error: unknown) => error);

        expect(errorFromThrown(failure).structuredContent).toStrictEqual({ code: "FORBIDDEN", message: "admin token rejected" });
    });

    it("does not forward the message of a plain error a caller threw with a catalog code", () => {
        expect.assertions(1);

        const secret = "sk_live_correct-horse-battery-staple";

        expect(errorFromThrown(Object.assign(new Error(secret), { code: "BAD_REQUEST" })).structuredContent).toStrictEqual({
            code: "INTERNAL",
            message: "the tool call failed unexpectedly",
        });
    });

    it("does not treat a code the catalog does not know as a contract", () => {
        expect.assertions(2);

        const result = errorFromThrown(Object.assign(new Error("connect ECONNREFUSED billing-db.internal:443"), { code: "ECONNREFUSED" }));

        expect(result.structuredContent).toStrictEqual({ code: "INTERNAL", message: "the tool call failed unexpectedly" });
        expect(JSON.stringify(result)).not.toContain("billing-db.internal");
    });

    it("reduces a plain Error to a fixed INTERNAL message, dropping any raw text", () => {
        expect.assertions(2);

        const result = errorFromThrown(new Error("fetch https://token@upstream.example failed"));

        expect(result.structuredContent).toStrictEqual({ code: "INTERNAL", message: "the tool call failed unexpectedly" });
        expect(JSON.stringify(result)).not.toContain("upstream.example");
    });
});

describe("error results survive a real SDK client", () => {
    // The SDK client validates `structuredContent` against `outputSchema` even
    // when `isError` is set. A unit test on errorResult cannot see that, so the
    // error path is driven through a connected client here.
    const connected = async (server: Server): Promise<Client> => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await server.connect(serverTransport);

        const client = new Client({ name: "tool-result-test", version: "1.0.0" });

        await client.connect(clientTransport);
        // listTools primes the client's output-schema validators, as a real session does.
        await client.listTools();

        return client;
    };

    it("delivers a tool error whose outputSchema requires success fields", async () => {
        expect.assertions(2);

        const client = await connected(createLocalMcpServer({ docs: false }));
        const result = await client.callTool({ arguments: {}, name: "lunora_explain_error" });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: "BAD_REQUEST" });

        await client.close();
    });

    it("validates a composed tool's success and error results when its own output schema types code as a number", async () => {
        expect.assertions(4);

        // A composed tool whose own `code` is a number: the error shape must not replace it.
        const numeric: McpTool = {
            definition: {
                annotations: { readOnlyHint: true },
                description: "reports a numeric code",
                inputSchema: { properties: { fail: { type: "boolean" } }, type: "object" },
                name: "numeric_code",
                outputSchema: { properties: { code: { type: "number" } }, required: ["code"], type: "object" },
            },
            handle: async ({ fail }: Record<string, unknown>) => {
                if (fail === true) {
                    throw new LunoraError("NOT_FOUND", "no such row");
                }

                return okStructured({ code: 7 });
            },
        };
        const client = await connected(createToolServer({ name: "numeric", version: "1.0.0" }, [numeric]));

        // The SDK client throws on a result that fails the output schema, so reaching
        // the assertions means both results validated.
        const success = await client.callTool({ arguments: { fail: false }, name: "numeric_code" });
        const failure = await client.callTool({ arguments: { fail: true }, name: "numeric_code" });

        expect(success.structuredContent).toStrictEqual({ code: 7 });
        expect(success.isError).not.toBe(true);
        expect(failure.isError).toBe(true);
        expect(failure.structuredContent).toStrictEqual({ code: "NOT_FOUND", message: "no such row" });

        await client.close();
    });

    it("delivers an observability tool error through the deployment server", async () => {
        expect.assertions(3);

        const query = vi.fn<() => Promise<never>>(async () => {
            throw new LunoraError("NOT_FOUND", "no such shard");
        });
        const client = { listFunctions: vi.fn<() => Promise<unknown[]>>(async () => []), query } as unknown as LunoraClient;
        const sdkClient = await connected(createLunoraMcpServer({ allowObservability: true, client, token: "admin-token" }));
        const result = await sdkClient.callTool({ arguments: {}, name: "lunora_get_logs" });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toStrictEqual({ code: "NOT_FOUND", message: "no such shard" });
        expect(query).toHaveBeenCalledTimes(1);

        await sdkClient.close();
    });
});

describe("ok serialises collections a v.any() field can carry", () => {
    it("writes a Map as an object keyed by its keys, and a Set as an array, instead of {}", () => {
        expect.assertions(2);

        const { content } = ok({ byId: new Map([["a", 1]]), tags: new Set(["x", "y"]) });
        const { text } = content[0] as { text: string };

        expect(JSON.parse(text)).toStrictEqual({ byId: { a: 1 }, tags: ["x", "y"] });
        expect(text).not.toContain("{}");
    });
});
