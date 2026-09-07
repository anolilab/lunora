import { afterEach, describe, expect, it, vi } from "vitest";

import { createPaidMcpServer } from "../src/paid";
import { serveStateless } from "../src/serve-stateless";
import type { ToolResult } from "../src/tools";

vi.mock(import("../src/serve-stateless"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, serveStateless: vi.fn<typeof actual.serveStateless>(actual.serveStateless) };
});

/** The worker-level x402 charge vocabulary shared by every paid tool. */
const charge = {
    network: "base",
    recipient: { evm: "0x1111111111111111111111111111111111111111" },
} as const;

const NO_INPUT = { properties: {}, type: "object" } as const;

const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/**
 * A facilitator double: answers `/supported` with a single `exact` kind on Base
 * (all a paywall's `initialize()` needs) and rejects `/verify` + `/settle` — the
 * unpaid paths under test never settle, so any settle call is a bug to surface.
 */
const stubFacilitator = (): ReturnType<typeof vi.fn> => {
    const supported = { kinds: [{ network: "eip155:8453", scheme: "exact", x402Version: 2 }] };

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) => {
        const url = requestUrl(input);

        if (url.endsWith("/supported")) {
            return Promise.resolve(Response.json(supported, { status: 200 }));
        }

        return Promise.reject(new Error(`unexpected facilitator call: ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

/** A Streamable-HTTP client POST: one JSON-RPC message, dual Accept header. */
const mcpRequest = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request("https://worker.example/mcp", {
        body: JSON.stringify(body),
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
        method: "POST",
    });

/** A Streamable-HTTP client POST carrying a raw (possibly unparseable) body. */
const rawMcpRequest = (rawBody: string, headers: Record<string, string> = {}): Request =>
    new Request("https://worker.example/mcp", {
        body: rawBody,
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
        method: "POST",
    });

const initializeBody = {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: { capabilities: {}, clientInfo: { name: "test", version: "0.0.0" }, protocolVersion: "2025-06-18" },
} as const;

const callBody = (name: string): unknown => {
    return { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } };
};

const text = (value: string): ToolResult => {
    return { content: [{ text: value, type: "text" }] };
};

describe("createPaidMcpServer", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(serveStateless).mockClear();
    });

    it("challenges an unpaid paid-tool call with 402 and never runs the handler", async () => {
        expect.assertions(4);

        const fetchMock = stubFacilitator();
        const handler = vi.fn<() => ToolResult>(() => text("secret report"));

        const mcp = createPaidMcpServer({ charge });
        mcp.paidTool({ description: "the paid report", inputSchema: NO_INPUT, name: "premium_report", price: "$0.05" }, handler);

        const response = await mcp.fetchHandler(mcpRequest(callBody("premium_report")));

        expect(response.status).toBe(402);
        expect(response.headers.get("PAYMENT-REQUIRED") ?? response.headers.get("payment-required")).not.toBeNull();
        expect(handler).not.toHaveBeenCalled();
        // Only /supported was hit — no verify/settle for an unpaid request.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not paywall a free tool — its call never touches the facilitator", async () => {
        expect.assertions(3);

        const fetchMock = stubFacilitator();

        const mcp = createPaidMcpServer({ charge });
        mcp.tool({ description: "echo", inputSchema: NO_INPUT, name: "ping" }, () => text("pong"));

        // Handshake first, then the free-tool call; a fresh stateless server per request.
        await mcp.fetchHandler(mcpRequest(initializeBody));
        const response = await mcp.fetchHandler(mcpRequest(callBody("ping")));

        expect(response.status).toBe(200);

        const payload = (await response.json()) as { result: { content: { text: string }[] } };

        expect(payload.result.content[0]?.text).toBe("pong");
        // A free tool must never be gated → the facilitator is untouched.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("advertises free and paid tools together over tools/list", async () => {
        expect.assertions(2);

        stubFacilitator();

        const mcp = createPaidMcpServer({ charge });
        mcp.tool({ description: "echo", inputSchema: NO_INPUT, name: "ping" }, () => text("pong"));
        mcp.paidTool({ description: "the paid report", inputSchema: NO_INPUT, name: "premium_report", price: "$0.05" }, () => text("secret"));

        await mcp.fetchHandler(mcpRequest(initializeBody));
        const response = await mcp.fetchHandler(mcpRequest({ id: 3, jsonrpc: "2.0", method: "tools/list", params: {} }));

        const payload = (await response.json()) as { result: { tools: { name: string }[] } };
        const names = payload.result.tools.map((tool) => tool.name);

        expect(names).toContain("ping");
        expect(names).toContain("premium_report");
    });

    it("does not gate a non-call method (initialize) — the facilitator is untouched", async () => {
        expect.assertions(2);

        const fetchMock = stubFacilitator();

        const mcp = createPaidMcpServer({ charge });
        mcp.paidTool({ description: "paid", inputSchema: NO_INPUT, name: "premium_report", price: "$0.05" }, () => text("secret"));

        const response = await mcp.fetchHandler(mcpRequest(initializeBody));

        expect(response.status).toBe(200);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a JSON-RPC batch that references a paid tool (fail-closed)", async () => {
        expect.assertions(2);

        const fetchMock = stubFacilitator();

        const mcp = createPaidMcpServer({ charge });
        mcp.paidTool({ description: "paid", inputSchema: NO_INPUT, name: "premium_report", price: "$0.05" }, () => text("secret"));

        const response = await mcp.fetchHandler(mcpRequest([callBody("premium_report")]));

        expect(response.status).toBe(400);
        // Refused before any facilitator or dispatch work.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails closed on an unparseable body when a tool is priced — never dispatches", async () => {
        expect.assertions(3);

        const fetchMock = stubFacilitator();

        const mcp = createPaidMcpServer({ charge });
        mcp.paidTool({ description: "paid", inputSchema: NO_INPUT, name: "premium_report", price: "$0.05" }, () => text("secret"));

        const response = await mcp.fetchHandler(rawMcpRequest("{not json"));

        expect(response.status).toBe(400);
        // The underlying SDK transport (serveStateless) is never reached — this
        // module can't tell whether the unparseable body targeted the paid tool,
        // so it refuses before dispatch rather than let the transport's own
        // re-parse decide.
        expect(serveStateless).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an unparseable body before dispatch even when no tool is priced", async () => {
        expect.assertions(2);

        stubFacilitator();

        const mcp = createPaidMcpServer({ charge });
        mcp.tool({ description: "echo", inputSchema: NO_INPUT, name: "ping" }, () => text("pong"));

        const response = await mcp.fetchHandler(rawMcpRequest("{not json"));

        // The shared bounded read owns the parse, so the JSON-RPC parse error
        // is answered here rather than one layer down in the transport.
        expect(response.status).toBe(400);
        expect(serveStateless).not.toHaveBeenCalled();
    });

    it("refuses an oversized body before buffering it, like every other transport", async () => {
        expect.assertions(3);

        const fetchMock = stubFacilitator();

        const mcp = createPaidMcpServer({ charge });
        mcp.paidTool({ description: "paid", inputSchema: NO_INPUT, name: "premium_report", price: "$0.05" }, () => text("secret"));

        // Declared oversize: refused on the header, before the body is read.
        const response = await mcp.fetchHandler(rawMcpRequest("{}", { "content-length": String(64 * 1024 * 1024) }));

        expect(response.status).toBe(413);
        expect(serveStateless).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("honours a custom maxRequestBytes on the paid transport", async () => {
        expect.assertions(2);

        stubFacilitator();

        const mcp = createPaidMcpServer({ charge, maxRequestBytes: 16 });
        mcp.tool({ description: "echo", inputSchema: NO_INPUT, name: "ping" }, () => text("pong"));

        const response = await mcp.fetchHandler(mcpRequest(callBody("ping")));

        expect(response.status).toBe(413);
        expect(serveStateless).not.toHaveBeenCalled();
    });

    it("returns a throwing paid tool as an isError result, not a JSON-RPC protocol error", async () => {
        expect.assertions(3);

        const mcp = createPaidMcpServer({ charge });
        mcp.tool({ description: "boom", inputSchema: NO_INPUT, name: "explode" }, () => {
            throw new Error("handler blew up");
        });

        const response = await mcp.fetchHandler(mcpRequest(callBody("explode")));
        const payload = (await response.json()) as { error?: unknown; result?: { content: { text: string }[]; isError?: boolean } };

        // Settlement precedes dispatch, so the caller has already paid: a
        // protocol-level error is invisible to a client that renders only tool
        // results, and the model is shown nothing for its money.
        expect(payload.error).toBeUndefined();
        expect(payload.result?.isError).toBe(true);
        expect(payload.result?.content[0]?.text).toContain("handler blew up");
    });

    it("rejects registering the same tool name twice", () => {
        expect.assertions(1);

        const mcp = createPaidMcpServer({ charge });
        mcp.tool({ description: "echo", inputSchema: NO_INPUT, name: "ping" }, () => text("pong"));

        expect(() => {
            mcp.paidTool({ description: "clash", inputSchema: NO_INPUT, name: "ping", price: "$0.01" }, () => text("x"));
        }).toThrow(/already registered/);
    });
});
