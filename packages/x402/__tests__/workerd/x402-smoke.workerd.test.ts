/**
 * Real-workerd boot smoke for `@lunora/x402`.
 *
 * The Node unit suite covers the protocol flow against fetch stubs; this suite
 * proves the charge rail actually boots in workerd — `@x402/core` + the lazily
 * imported `@x402/evm` scheme module (viem) load and run in the real runtime.
 * Covered: the `withX402` HTTP-action wrapper initialises against a (mocked)
 * facilitator and challenges an unpaid request with a real 402 through a real
 * worker `fetch` handler (via `SELF` — the worker runs in the same isolate as
 * the tests, so the facilitator stub applies to it too); and the
 * `.x402({ price })` procedure seam (`createProcedureChargeGate`) challenges
 * an unpaid RPC with 402, names the `functionPath` as the challenge
 * `resource`, and never dispatches the shard forward.
 *
 * Boundary (documented per the plan): the upstream x402 facilitator is mocked
 * at the fetch boundary (only `/supported` answers, so middleware init
 * succeeds; `/verify` + `/settle` reject). Verify + settle require a
 * client-signed `X-PAYMENT` payload and an on-chain settlement — no real chain
 * calls are made here; the settle-path logic is covered by the Node suite's
 * stubs.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProcedureChargeGate } from "../../src/charge/procedure";
import type { X402ChargeConfig } from "../../src/config";

const chargeConfig: X402ChargeConfig = {
    network: "base",
    price: "$0.01",
    recipient: { evm: "0x1111111111111111111111111111111111111111" },
};

const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/**
 * A facilitator double at the fetch boundary: answers `/supported` with a
 * single `exact` kind on Base (all `initialize()` needs) and rejects `/verify`
 * + `/settle` — the unpaid paths under test never settle, so any settle call
 * is a bug we want to surface. No real network leaves the isolate.
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

describe("@lunora/x402 (workerd)", () => {
    it("withX402 boots in a real worker fetch handler and challenges unpaid requests with 402", async () => {
        expect.hasAssertions();

        const fetchMock = stubFacilitator();

        const first = await SELF.fetch("https://x402-smoke.test/paid/report");

        expect(first.status).toBe(402);
        // The x402 v2 challenge rides the base64 `PAYMENT-REQUIRED` header.
        expect(first.headers.get("payment-required")).not.toBeNull();
        // The paid resource was withheld.
        await expect(first.text()).resolves.not.toContain("paid-secret");

        // Second unpaid request: still 402, and the middleware is memoised —
        // facilitator support was fetched exactly once across both requests.
        const second = await SELF.fetch("https://x402-smoke.test/paid/report");

        expect(second.status).toBe(402);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("the .x402({ price }) procedure seam challenges an unpaid RPC and names the functionPath", async () => {
        expect.hasAssertions();

        const fetchMock = stubFacilitator();
        const gate = createProcedureChargeGate({ network: "base", recipient: { evm: "0x1111111111111111111111111111111111111111" } });

        let dispatched = 0;
        const dispatch = (): Promise<Response> => {
            dispatched += 1;

            return Promise.resolve(new Response("shard-result"));
        };

        const request = new Request("https://x402-smoke.test/_lunora/rpc", { method: "POST" });
        const response = await gate(request, { functionPath: "reports:latest", price: "$0.05" }, dispatch);

        expect(response.status).toBe(402);
        expect(dispatched).toBe(0);
        // Only /supported was hit — no verify/settle for an unpaid request.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const header = response.headers.get("payment-required");

        expect(header).not.toBeNull();

        const challenge = JSON.parse(atob(header as string)) as { resource?: { url?: string } };

        expect(challenge.resource?.url).toBe("reports:latest");
    });

    it("charge config errors fail loudly in workerd (missing recipient for the network family)", async () => {
        expect.hasAssertions();

        const { createChargeMiddleware } = await import("../../src/charge/middleware");

        await expect(createChargeMiddleware({ ...chargeConfig, recipient: {} })).rejects.toThrow(/needs recipient\.evm set/);
    });
});
