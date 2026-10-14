import { describe, expect, it, vi } from "vitest";

import { createPaidMcpServer } from "../src/paid";
import type { ToolResult } from "../src/tools";

/** Every `deps` the charge middleware was handed, in call order. */
const handleDeps: ({ waitUntil?: (promise: Promise<unknown>) => void } | undefined)[] = [];

// A charge-middleware double. The real x402 paywall's settle/verify machinery is
// tested in `@lunora/x402`; what has to be tested HERE is the one thing this
// package owns — that the Worker's `ctx.waitUntil` reaches `handle`'s third
// argument, since without it `reportReceipt` floats the `onReceipt` sink with no
// registration and workerd cancels it at isolate teardown: the money moves
// on-chain and the receipt row never lands.
vi.mock(import("@lunora/x402/charge"), () => {
    return {
        createChargeMiddleware: () =>
            Promise.resolve({
                handle: async (
                    _request: Request,
                    runHandler: () => Promise<Response> | Response,
                    deps?: { readonly waitUntil?: (promise: Promise<unknown>) => void },
                ): Promise<Response> => {
                    handleDeps.push(deps);

                    return runHandler();
                },
            }),
    };
});

const charge = { network: "base", recipient: { evm: "0x1111111111111111111111111111111111111111" } } as const;
const NO_INPUT = { properties: {}, type: "object" } as const;

const mcpRequest = (body: unknown): Request =>
    new Request("https://worker.example/mcp", {
        body: JSON.stringify(body),
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        method: "POST",
    });

const callBody = (name: string): unknown => {
    return { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } };
};

const text = (value: string): ToolResult => {
    return { content: [{ text: value, type: "text" }] };
};

const paidServer = (): ReturnType<typeof createPaidMcpServer> => {
    const mcp = createPaidMcpServer({ charge });

    mcp.paidTool({ description: "the paid report", inputSchema: NO_INPUT, name: "premium_report", price: "$0.05" }, () => text("secret"));

    return mcp;
};

describe("createPaidMcpServer — waitUntil plumbing", () => {
    it("forwards the Worker execution context's waitUntil to the charge middleware", async () => {
        expect.assertions(2);

        handleDeps.length = 0;

        const kept: Promise<unknown>[] = [];
        const context = {
            waitUntil(promise: Promise<unknown>): void {
                kept.push(promise);
            },
        };

        await paidServer().fetchHandler(mcpRequest(callBody("premium_report")), {}, context);

        const sink = Promise.resolve("receipt row");

        handleDeps[0]?.waitUntil?.(sink);

        expect(handleDeps[0]?.waitUntil).toBeTypeOf("function");
        expect(kept).toStrictEqual([sink]);
    });

    // `ExecutionContext.waitUntil` is receiver-bound: called unbound it throws
    // `TypeError: Illegal invocation`, and `reportReceipt` swallows that — the
    // paid response still lands while the receipt is silently never registered.
    it("invokes waitUntil through the context, never as a detached function", async () => {
        expect.assertions(2);

        handleDeps.length = 0;

        const context = {
            kept: [] as Promise<unknown>[],
            waitUntil(this: unknown, promise: Promise<unknown>): void {
                if (this !== context) {
                    throw new TypeError("Illegal invocation");
                }

                context.kept.push(promise);
            },
        };

        await paidServer().fetchHandler(mcpRequest(callBody("premium_report")), {}, context);

        const sink = Promise.resolve("receipt row");

        expect(() => handleDeps[0]?.waitUntil?.(sink)).not.toThrow();
        expect(context.kept).toStrictEqual([sink]);
    });

    // A non-Workers caller (a test, a plain fetch server) has no execution
    // context; the middleware must then see no `deps` at all rather than a
    // `waitUntil` that throws on use.
    it("passes no deps when the handler is called without an execution context", async () => {
        expect.assertions(1);

        handleDeps.length = 0;

        await paidServer().fetchHandler(mcpRequest(callBody("premium_report")));

        expect(handleDeps[0]).toBeUndefined();
    });
});
