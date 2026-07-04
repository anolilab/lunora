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

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createChargeMiddleware", () => {
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
});

describe("withX402", () => {
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
