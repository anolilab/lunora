import { LunoraClient } from "@lunora/client";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLunoraMcpServer } from "../src/server";

/** Minimal mock exposing only the methods the tools touch. */
const mockClient = (): {
    asClient: LunoraClient;
    listFunctions: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
} => {
    const listFunctions = vi.fn<() => Promise<{ kind: string; path: string }[]>>(async () => [{ kind: "query", path: "messages:list" }]);
    const query = vi.fn<() => Promise<{ count: number }>>(async () => {
        return { count: 7 };
    });

    const client = { listFunctions, query } as unknown as LunoraClient;

    return { asClient: client, listFunctions, query };
};

/**
 * The low-level SDK `Server` stores request handlers in a private map keyed by
 * request method. We don't drive a transport here; we reach the handlers the
 * same way the SDK does — by looking them up via the request schema's method.
 */
const handlerFor = (server: ReturnType<typeof createLunoraMcpServer>, method: string): ((request: Record<string, unknown>) => unknown) => {
    // eslint-disable-next-line no-underscore-dangle -- reach into the SDK's private handler map; there is no public accessor for registered handlers.
    const handlers = (server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => unknown> })._requestHandlers;
    const handler = handlers.get(method);

    if (handler === undefined) {
        throw new Error(`no handler registered for ${method}`);
    }

    // The SDK re-validates the request against its schema (which pins `method`),
    // so inject the method and a minimal `extra` the signature requires.
    return (request: Record<string, unknown>) => handler({ method, ...request }, { signal: new AbortController().signal });
};

describe("resolveClient", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("throws when neither a client nor a url is provided", () => {
        expect.assertions(1);

        expect(() => createLunoraMcpServer({})).toThrow(/requires either a `client` or a `url`/);
    });

    it("wires the token through setAuthToken when constructed from a url", () => {
        expect.assertions(2);

        const setAuthToken = vi.spyOn(LunoraClient.prototype, "setAuthToken").mockImplementation(() => undefined);

        createLunoraMcpServer({ token: "admin-token", url: "https://example.workers.dev" });

        expect(setAuthToken).toHaveBeenCalledTimes(1);
        expect(setAuthToken).toHaveBeenCalledWith("admin-token");
    });

    it("does not call setAuthToken when no token is given", () => {
        expect.assertions(1);

        const setAuthToken = vi.spyOn(LunoraClient.prototype, "setAuthToken").mockImplementation(() => undefined);

        createLunoraMcpServer({ url: "https://example.workers.dev" });

        expect(setAuthToken).not.toHaveBeenCalled();
    });
});

describe("createLunoraMcpServer request handlers", () => {
    it("listTools returns the full tool definition set", async () => {
        expect.assertions(1);

        const server = createLunoraMcpServer({ client: mockClient().asClient });
        const result = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        expect(result.tools.map((tool) => tool.name)).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
            "lunora_run_mutation",
            "lunora_run_action",
        ]);
    });

    it("callTool dispatches through callTool against the injected client", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const server = createLunoraMcpServer({ client: mock.asClient });
        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: {}, name: "lunora_list_functions" },
        })) as CallToolResult;

        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
        expect(JSON.parse((result.content[0] as { text: string }).text)).toStrictEqual([{ kind: "query", path: "messages:list" }]);
    });

    it("callTool tolerates a request with no arguments bag (defaults to {})", async () => {
        expect.assertions(1);

        const mock = mockClient();
        const server = createLunoraMcpServer({ client: mock.asClient });

        // No `arguments` key at all — the handler coalesces it to `{}`. With no
        // functionPath this is a validation error surfaced as an error result,
        // which is exactly the contract: the handler must not throw/reject.
        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { name: "lunora_run_query" },
        })) as CallToolResult;

        expect(result.isError).toBe(true);
    });
});
