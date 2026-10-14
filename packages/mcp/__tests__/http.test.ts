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

    /**
     * The public-function registry memo in `./tools` is keyed by client identity,
     * so a handler that builds a `LunoraClient` per request never hits it and
     * every tool call pays the admin round trip again.
     */
    it("shares one client across requests, so the function registry is fetched once", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ functions: [{ kind: "query", path: "messages:list" }] }));
        const handle = createMcpFetchHandler({ fetch: fetchMock, token: "admin-token", url: "https://app.example" });
        const listCall = (id: number): unknown => {
            return { id, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "lunora_list_functions" } };
        };

        await handle(mcpRequest(initializeBody));

        const first = await handle(mcpRequest(listCall(2)));

        await handle(mcpRequest(listCall(3)));

        expect(first.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports a misconfiguration when the handler is built, not on the first request", () => {
        expect.assertions(1);

        // The client is resolved once, up front — so `url` with no admin bearer
        // fails where `createLunoraMcpServer` documents reporting it.
        expect(() => createMcpFetchHandler({ url: "https://app.example" })).toThrow(/token/u);
    });

    it("honours a custom maxRequestBytes", async () => {
        expect.assertions(1);

        const handle = createMcpFetchHandler({ client: mockClient(), maxRequestBytes: 16 });
        const response = await handle(mcpRequest(initializeBody));

        expect(response.status).toBe(413);
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

    // The whole point of a body limit is that the bytes are never read. A
    // buffer-then-measure guard still returns 413, so status alone proves
    // nothing — `pulls` is what distinguishes "cut the upload off" from "read
    // the whole thing, then complain".
    it("stops reading a chunked body at the limit instead of buffering it", async () => {
        expect.assertions(3);

        const chunkBytes = 256;
        const chunkCount = 1000;
        let pulls = 0;

        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulls >= chunkCount) {
                    controller.close();

                    return;
                }

                pulls += 1;
                controller.enqueue(new Uint8Array(chunkBytes).fill(0x7a));
            },
        });

        const handle = createMcpFetchHandler({ client: mockClient(), maxRequestBytes: 1024 });
        // A streamed body carries no `content-length`, so the cheap header
        // fast-path cannot fire and the streaming bound is the only guard left.
        const request = new Request("https://worker.example/mcp", {
            body,
            // `duplex` is required for a stream body but missing from the DOM
            // `RequestInit` lib type, hence the assertion below.
            duplex: "half",
            headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
            method: "POST",
        } as RequestInit);
        const response = await handle(request);

        expect(response.status).toBe(413);
        expect(request.headers.get("content-length")).toBeNull();
        // 1024/256 = 4 chunks fit, the 5th trips the limit. Anything near
        // `chunkCount` means the body was drained before it was measured.
        expect(pulls).toBeLessThanOrEqual(8);
    });

    it.each([
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["negative", -1],
        ["fractional", 1.5],
    ])("falls back to the default bound when maxRequestBytes is %s", async (_label, maxRequestBytes) => {
        expect.assertions(2);

        const handle = createMcpFetchHandler({ client: mockClient(), maxRequestBytes });
        const oversized = {
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { path: "z".repeat(DEFAULT_MAX_REQUEST_BYTES) }, name: "lunora_run_query" },
        };
        const response = await handle(mcpRequest(oversized));

        expect(response.status).toBe(413);
        await expect(response.text()).resolves.toContain(String(DEFAULT_MAX_REQUEST_BYTES));
    });
});
