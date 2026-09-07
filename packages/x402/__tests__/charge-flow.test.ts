import { x402HTTPResourceServer as X402HTTPResourceServer } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withX402 } from "../src/charge/http-action";
import { createChargeMiddleware } from "../src/charge/middleware";

const chargeConfig = {
    network: "base",
    price: "$0.01",
    recipient: { evm: "0x1111111111111111111111111111111111111111" },
} as const;

const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/**
 * A facilitator double: answers `/supported` with a single `exact` kind on Base
 * (all `initialize()` needs) and rejects `/verify` + `/settle` — the unpaid
 * paths under test never settle, so any settle call is a bug we want to surface.
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

/** A minimal `payment-verified` result — enough for `handle` to reach settlement. */
const paymentVerifiedResult = {
    cancellationDispatcher: { cancel: vi.fn<() => Promise<void>>() },
    paymentPayload: {},
    paymentRequirements: {},
    type: "payment-verified",
} as const;

const successSettlement = {
    headers: { "x-payment-response": "settled" },
    network: "eip155:8453",
    payer: "0xPayer",
    requirements: { amount: "10000", asset: "0xUSDC", payTo: "0x1111111111111111111111111111111111111111" },
    success: true,
    transaction: "0xTX",
} as const;

const failureSettlement = {
    errorReason: "insufficient_funds",
    headers: {},
    response: { body: { error: "insufficient_funds" }, headers: { "content-type": "application/json" }, status: 402 },
    success: false,
} as const;

describe("createChargeMiddleware", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("challenges an unpaid request with 402 and never runs the handler", async () => {
        const fetchMock = stubFacilitator();
        const middleware = await createChargeMiddleware(chargeConfig);

        const handler = vi.fn<() => Response>(() => new Response("secret"));
        const response = await middleware.handle(new Request("https://api.example/report"), handler);

        expect(response.status).toBe(402);
        expect(handler).not.toHaveBeenCalled();
        // Only /supported was hit — no verify/settle for an unpaid request.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("settle-first: a settlement failure never runs the handler (no committed-but-unpaid write)", async () => {
        vi.spyOn(X402HTTPResourceServer.prototype, "initialize").mockResolvedValue(undefined);
        vi.spyOn(X402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue(paymentVerifiedResult as never);

        const processSettlement = vi.spyOn(X402HTTPResourceServer.prototype, "processSettlement").mockResolvedValue(failureSettlement as never);

        const middleware = await createChargeMiddleware(chargeConfig, undefined, { settleBeforeHandler: true });
        const handler = vi.fn<() => Response>(() => new Response("mutated"));

        const response = await middleware.handle(new Request("https://api.example/report"), handler);

        // The handler (the mutation's shard-forward dispatch, in the procedure
        // gate) never ran — settlement was decided first, so nothing committed.
        expect(handler).not.toHaveBeenCalled();
        expect(response.status).toBe(402);

        // Settlement ran before the handler with no `responseHeaders` (there is
        // no response yet at this point).
        expect(processSettlement).toHaveBeenCalledTimes(1);

        const transportContext = processSettlement.mock.calls[0]?.[3];

        expect(transportContext).not.toHaveProperty("responseHeaders");

        vi.restoreAllMocks();
    });

    it("settles before the handler BY DEFAULT — a verify-passing but unsettleable payment runs nothing", async () => {
        vi.spyOn(X402HTTPResourceServer.prototype, "initialize").mockResolvedValue(undefined);
        vi.spyOn(X402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue(paymentVerifiedResult as never);
        vi.spyOn(X402HTTPResourceServer.prototype, "processSettlement").mockResolvedValue(failureSettlement as never);

        // No options at all — `verifyPayment` checks the signed intent, not
        // solvency, so settle-after would run the handler's side effects for free.
        const middleware = await createChargeMiddleware(chargeConfig);
        const handler = vi.fn<() => Response>(() => new Response("side effects"));

        const response = await middleware.handle(new Request("https://api.example/report"), handler);

        expect(handler).not.toHaveBeenCalled();
        expect(response.status).toBe(402);

        vi.restoreAllMocks();
    });

    it("settle-first: on success, reports the receipt via the injected waitUntil before running the handler", async () => {
        vi.spyOn(X402HTTPResourceServer.prototype, "initialize").mockResolvedValue(undefined);
        vi.spyOn(X402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue(paymentVerifiedResult as never);
        vi.spyOn(X402HTTPResourceServer.prototype, "processSettlement").mockResolvedValue(successSettlement as never);

        const onReceipt = vi.fn<() => Promise<void>>(() => Promise.resolve());
        const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

        const middleware = await createChargeMiddleware({ ...chargeConfig, onReceipt }, undefined, { settleBeforeHandler: true });
        const handler = vi.fn<() => Response>(() => new Response("mutated"));

        const response = await middleware.handle(new Request("https://api.example/report"), handler, { waitUntil });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(response.headers.get("x-payment-response")).toBe("settled");

        // The receipt sink ran synchronously (best-effort) and its promise was
        // registered with the injected `waitUntil` so workerd keeps it alive.
        expect(onReceipt).toHaveBeenCalledTimes(1);
        expect(waitUntil).toHaveBeenCalledTimes(1);
        expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);

        vi.restoreAllMocks();
    });

    it("delivers the receipt sink without a waitUntil when none is injected (non-Workers fallback)", async () => {
        vi.spyOn(X402HTTPResourceServer.prototype, "initialize").mockResolvedValue(undefined);
        vi.spyOn(X402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue(paymentVerifiedResult as never);
        vi.spyOn(X402HTTPResourceServer.prototype, "processSettlement").mockResolvedValue(successSettlement as never);

        const onReceipt = vi.fn<() => Promise<void>>(() => Promise.resolve());

        const middleware = await createChargeMiddleware({ ...chargeConfig, onReceipt }, undefined, { settleBeforeHandler: true });
        const handler = vi.fn<() => Response>(() => new Response("mutated"));

        const response = await middleware.handle(new Request("https://api.example/report"), handler);

        expect(response.status).toBe(200);
        expect(onReceipt).toHaveBeenCalledTimes(1);

        vi.restoreAllMocks();
    });

    it("preserves the original handler error when payment cancellation also fails", async () => {
        // Reach the payment-verified branch without a real payment: stub the
        // resource server's init + request processing so the handler runs, then
        // make cancellation itself reject. The caller must still see the handler's
        // error, not the cancellation failure. Cancellation only exists on the
        // opt-in settle-AFTER path, so this one asks for it explicitly.
        vi.spyOn(X402HTTPResourceServer.prototype, "initialize").mockResolvedValue(undefined);
        const cancel = vi.fn<() => Promise<never>>(() => Promise.reject(new Error("cancel exploded")));

        vi.spyOn(X402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue({
            cancellationDispatcher: { cancel },
            type: "payment-verified",
        } as never);
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        const middleware = await createChargeMiddleware(chargeConfig, undefined, { settleBeforeHandler: false });
        const handlerError = new Error("handler boom");

        await expect(
            middleware.handle(new Request("https://api.example/report"), () => {
                throw handlerError;
            }),
        ).rejects.toBe(handlerError);

        // Cancellation was attempted and its failure was surfaced, not thrown.
        expect(cancel).toHaveBeenCalledWith({ error: handlerError, reason: "handler_threw" });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("failed to cancel payment"), expect.any(Error));

        vi.restoreAllMocks();
    });
});

describe("withX402", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("gates a Lunora HTTP-action handler and memoises the middleware", async () => {
        stubFacilitator();
        const handler = vi.fn<(context: { id: string }, request: Request) => Response>(() => new Response("secret"));
        const gated = withX402(chargeConfig, handler);

        const first = await gated({ id: "ctx" }, new Request("https://api.example/report"));
        const second = await gated({ id: "ctx" }, new Request("https://api.example/report"));

        expect(first.status).toBe(402);
        expect(second.status).toBe(402);
        expect(handler).not.toHaveBeenCalled();
        // Two requests, but facilitator support was fetched exactly once.
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("forwards the context's waitUntil so the receipt sink survives the response", async () => {
        stubFacilitator();
        vi.spyOn(X402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue(paymentVerifiedResult as never);
        vi.spyOn(X402HTTPResourceServer.prototype, "processSettlement").mockResolvedValue(successSettlement as never);

        const onReceipt = vi.fn<() => Promise<void>>(() => Promise.resolve());
        const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
        const gated = withX402({ ...chargeConfig, onReceipt }, () => new Response("secret"));

        const response = await gated({ waitUntil }, new Request("https://api.example/report"));

        expect(response.status).toBe(200);
        expect(onReceipt).toHaveBeenCalledTimes(1);
        expect(waitUntil).toHaveBeenCalledTimes(1);
        expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);

        vi.restoreAllMocks();
    });

    it("calls waitUntil through the context so a receiver-bound one does not throw", async () => {
        stubFacilitator();
        vi.spyOn(X402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue(paymentVerifiedResult as never);
        vi.spyOn(X402HTTPResourceServer.prototype, "processSettlement").mockResolvedValue(successSettlement as never);

        const onReceipt = vi.fn<() => Promise<void>>(() => Promise.resolve());
        const registered: Promise<unknown>[] = [];
        // Cloudflare's `ExecutionContext.waitUntil` is receiver-bound: called
        // detached it throws `TypeError: Illegal invocation`, which
        // `reportReceipt` swallows — the paid response still lands, but the
        // receipt promise is never registered and the async sink dies with the
        // request. This context reproduces that binding requirement.
        const context = {
            token: "ctx",
            waitUntil(this: unknown, promise: Promise<unknown>): void {
                if ((this as { token?: string } | undefined)?.token !== "ctx") {
                    throw new TypeError("Illegal invocation");
                }

                registered.push(promise);
            },
        };

        const gated = withX402({ ...chargeConfig, onReceipt }, () => new Response("secret"));
        const response = await gated(context, new Request("https://api.example/report"));

        expect(response.status).toBe(200);
        expect(registered).toHaveLength(1);

        vi.restoreAllMocks();
    });

    it("does not cache a failed initialisation", async () => {
        const failing = vi.fn<() => Promise<Response>>(() => Promise.reject(new Error("facilitator down")));

        vi.stubGlobal("fetch", failing);

        const gated = withX402(chargeConfig, () => new Response("secret"));

        await expect(gated({}, new Request("https://api.example/report"))).rejects.toThrow(/Failed to initialize|facilitator down/);

        // Recover: the next request re-initialises against a healthy facilitator.
        const fetchMock = stubFacilitator();
        const response = await gated({}, new Request("https://api.example/report"));

        expect(response.status).toBe(402);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
