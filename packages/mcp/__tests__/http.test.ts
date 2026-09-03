import type { LunoraClient } from "@lunora/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpFetchHandler } from "../src/http";
import { DEFAULT_MAX_REQUEST_BYTES } from "../src/serve-stateless";

/** Minimal mock exposing only the methods the tools touch. */
const mockClient = (): LunoraClient => {
    const listFunctions = vi.fn<() => Promise<{ kind: string; path: string }[]>>(async () => [{ kind: "query", path: "messages:list" }]);

    return { listFunctions } as unknown as LunoraClient;
};

/**
 * A Streamable-HTTP client POSTs one JSON-RPC message per request and must
 * advertise it accepts both JSON and the SSE stream the transport may open.
 */
const mcpRequest = (body: unknown): Request =>
    new Request("https://worker.example/mcp", {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
        },
        method: "POST",
    });

/** The MCP `initialize` handshake — the first message any client sends. */
const initializeBody = {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
        protocolVersion: "2025-06-18",
    },
} as const;

describe("createMcpFetchHandler", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("answers the initialize handshake with the Lunora server info over Streamable HTTP", async () => {
        expect.assertions(4);

        const handle = createMcpFetchHandler({ client: mockClient() });
        const response = await handle(mcpRequest(initializeBody));

        expect(response.status).toBe(200);

        const payload = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };

        expect(payload.result.serverInfo.name).toBe("lunora");
        expect(typeof payload.result.protocolVersion).toBe("string");
        expect(payload.result.protocolVersion.length).toBeGreaterThan(0);
    });

    it("lists the deployment tools over HTTP the same way the stdio transport does", async () => {
        expect.assertions(2);

        const handle = createMcpFetchHandler({ client: mockClient() });

        // `initialize` first (stateless: each request stands alone, but the
        // transport still requires the handshake message to precede others).
        await handle(mcpRequest(initializeBody));

        const response = await handle(mcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }));

        expect(response.status).toBe(200);

        const payload = (await response.json()) as { result: { tools: { name: string }[] } };
        const names = payload.result.tools.map((tool) => tool.name);

        expect(names).toContain("lunora_list_functions");
    });

    it("is stateless — a fresh handler serves each request without a shared session", async () => {
        expect.assertions(1);

        const handle = createMcpFetchHandler({ client: mockClient() });
        const response = await handle(mcpRequest(initializeBody));

        // Stateless mode must not hand back a session id for the client to pin.
        expect(response.headers.get("mcp-session-id")).toBeNull();
    });

    /**
     * This handler carries the deployment's ADMIN bearer on every tool call, so
     * one POST of a JSON-RPC array is one authorized request amplified into as
     * many privileged upstream calls as the array has entries. It is refused
     * before a server is ever built for it.
     */
    it("refuses a batched request without dispatching any of it", async () => {
        expect.assertions(2);

        const client = mockClient();
        const handle = createMcpFetchHandler({ client });
        const response = await handle(mcpRequest([initializeBody, initializeBody, initializeBody]));

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toContain("batched requests are not supported");
    });

    it("refuses a body over the size limit", async () => {
        expect.assertions(2);

        const handle = createMcpFetchHandler({ client: mockClient() });
        const oversized = {
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { path: "z".repeat(DEFAULT_MAX_REQUEST_BYTES) }, name: "lunora_run_query" },
        };
        const response = await handle(mcpRequest(oversized));

        expect(response.status).toBe(413);
        await expect(response.text()).resolves.toContain("exceeds");
    });
});
