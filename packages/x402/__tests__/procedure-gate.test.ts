import { afterEach, describe, expect, it, vi } from "vitest";

import { createProcedureChargeGate } from "../src/charge/procedure";

const gateConfig = {
    network: "base",
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

/** The RPC endpoint every paid procedure POSTs to — the URL alone can't tell two paid functions apart. */
const rpcRequest = (): Request => new Request("https://api.example/_lunora/rpc", { method: "POST" });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createProcedureChargeGate", () => {
    it("challenges an unpaid paid procedure with 402 and never dispatches", async () => {
        const fetchMock = stubFacilitator();
        const gate = createProcedureChargeGate(gateConfig);

        const dispatch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response("shard-result")));
        const response = await gate(rpcRequest(), { functionPath: "reports:latest", price: "$0.05" }, dispatch);

        expect(response.status).toBe(402);
        expect(dispatch).not.toHaveBeenCalled();
        // Only /supported was hit — no verify/settle for an unpaid request.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("names the functionPath as the x402 challenge `resource`", async () => {
        stubFacilitator();
        const gate = createProcedureChargeGate(gateConfig);

        const response = await gate(rpcRequest(), { functionPath: "reports:latest", price: "$0.05" }, () => Promise.resolve(new Response("x")));

        // x402 v2 carries the challenge in the base64 `PAYMENT-REQUIRED` header
        // (the body stays empty), naming the paid resource at `.resource.url`.
        const header = response.headers.get("payment-required");

        expect(header).not.toBeNull();

        const challenge = JSON.parse(atob(header as string)) as { resource?: { url?: string } };

        expect(challenge.resource?.url).toBe("reports:latest");
    });

    it("memoises one initialised middleware per functionPath", async () => {
        const fetchMock = stubFacilitator();
        const gate = createProcedureChargeGate(gateConfig);

        // Same function twice → facilitator support fetched exactly once.
        await gate(rpcRequest(), { functionPath: "reports:latest", price: "$0.05" }, () => Promise.resolve(new Response("x")));
        await gate(rpcRequest(), { functionPath: "reports:latest", price: "$0.05" }, () => Promise.resolve(new Response("x")));

        expect(fetchMock).toHaveBeenCalledTimes(1);

        // A different function initialises its own middleware (its own price + resource).
        await gate(rpcRequest(), { functionPath: "reports:export", price: "$0.10" }, () => Promise.resolve(new Response("x")));

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failed initialisation", async () => {
        const failing = vi.fn<() => Promise<Response>>(() => Promise.reject(new Error("facilitator down")));

        vi.stubGlobal("fetch", failing);

        const gate = createProcedureChargeGate(gateConfig);
        const spec = { functionPath: "reports:latest", price: "$0.05" } as const;

        await expect(gate(rpcRequest(), spec, () => Promise.resolve(new Response("x")))).rejects.toThrow(/Failed to initialize|facilitator down/u);

        // Recover: the next request re-initialises against a healthy facilitator.
        const fetchMock = stubFacilitator();
        const response = await gate(rpcRequest(), spec, () => Promise.resolve(new Response("x")));

        expect(response.status).toBe(402);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
