/**
 * Real-workerd boot smoke for `@lunora/x402`: the charge rail's challenge path.
 *
 * `@x402/core` and the lazily imported scheme modules (`@x402/evm` + viem,
 * `@x402/svm`) load and run in the real runtime. Covered: the `withX402`
 * HTTP-action wrapper initialises against the facilitator double and challenges
 * an unpaid request with a real 402 through the test worker's `fetch` handler;
 * the `.x402({ price })` procedure seam (`createProcedureChargeGate`) challenges
 * an unpaid RPC, names the `functionPath` as the challenge `resource`, and never
 * dispatches; and the SVM scheme challenges on a Solana network.
 *
 * The facilitator answers only `/supported` here, so any `/verify` or `/settle`
 * call fails the test. Paying the challenge is `x402-roundtrip.workerd.test.ts`.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChargeMiddleware } from "../../src/charge/middleware";
import { createProcedureChargeGate } from "../../src/charge/procedure";
import type { X402ChargeConfig } from "../../src/config";
import { stubFacilitator } from "./_facilitator";

const chargeConfig: X402ChargeConfig = {
    network: "base",
    price: "$0.01",
    recipient: { evm: "0x1111111111111111111111111111111111111111" },
};

describe("@lunora/x402 (workerd)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("withX402 boots in a real worker fetch handler and challenges unpaid requests with 402", async () => {
        expect.hasAssertions();

        const facilitator = stubFacilitator();

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
        expect(facilitator.calls).toStrictEqual(["supported"]);
    });

    it("the .x402({ price }) procedure seam challenges an unpaid RPC and names the functionPath", async () => {
        expect.hasAssertions();

        const facilitator = stubFacilitator();
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
        expect(facilitator.calls).toStrictEqual(["supported"]);

        const header = response.headers.get("payment-required");

        expect(header).not.toBeNull();

        const challenge = JSON.parse(atob(header as string)) as { resource?: { url?: string } };

        expect(challenge.resource?.url).toBe("reports:latest");
    });

    it("charge config errors fail loudly in workerd (missing recipient for the network family)", async () => {
        expect.hasAssertions();

        await expect(createChargeMiddleware({ ...chargeConfig, recipient: {} })).rejects.toMatchObject({
            code: "ENV_INVALID",
            message: expect.stringMatching(/needs recipient\.evm set/u),
        });
    });

    it("challenges an unpaid request on a Solana network", async () => {
        expect.hasAssertions();

        stubFacilitator({ supported: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });

        const middleware = await createChargeMiddleware({
            network: "solana-devnet",
            price: "$0.01",
            recipient: { svm: "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" },
        });
        const handler = vi.fn<() => Response>(() => new Response("paid-secret"));

        const response = await middleware.handle(new Request("https://x402-smoke.test/paid/report"), handler);

        expect(response.status).toBe(402);
        expect(handler).not.toHaveBeenCalled();

        const challenge = JSON.parse(atob(response.headers.get("payment-required") ?? "")) as { accepts: { network: string }[] };

        expect(challenge.accepts[0]?.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    });
});
