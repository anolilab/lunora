/**
 * Both rails against each other in real workerd: the pay rail (`createX402Pay`,
 * raw-key EVM custody) answers the charge rail's 402 by signing an EIP-712
 * authorization with viem INSIDE workerd, and the `withX402`-gated worker
 * verifies and settles it. The smoke suite stops at the challenge; this one
 * crosses the whole exchange, so the signer imports, the secp256k1 signature
 * and the settle-first ordering are all proven on the runtime they ship to.
 *
 * Boundary: the facilitator is a double at the fetch boundary (`/supported`,
 * `/verify`, `/settle`) and no chain is touched. What it receives is the real
 * signed payload, so the assertions read the signature the pay rail produced.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { X402PayConfig } from "../../src/config";
import { createX402Pay, lazyX402Pay } from "../../src/pay";
import type { FacilitatorDouble } from "./_facilitator";
import { PAYER, stubFacilitator } from "./_facilitator";

// The public Hardhat/Anvil account #0 key, which `PAYER` is the address of. Not a real secret.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secret-scanner:allow -- public Hardhat test key #0
const PAID_URL = "https://x402-smoke.test/paid/report";

/**
 * The facilitator calls past initialisation. The test worker memoises its
 * `withX402` middleware for the isolate's life, so `/supported` is fetched only
 * by whichever test reaches it first.
 */
const paymentCalls = (double: FacilitatorDouble): string[] => double.calls.filter((call) => call !== "supported");

/** The pay rail's transport: every request goes to the gated test worker, and is recorded. */
const toWorker =
    (seen: Request[]): typeof fetch =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
        // The pay rail only sends GETs here, so recording a copy leaves no body to consume.
        seen.push(new Request(input, init));

        return SELF.fetch(input, init);
    };

const payConfig = (policy: X402PayConfig["policy"]): X402PayConfig => {
    return { network: "base", policy, signer: { secretName: "AGENT_WALLET_KEY", type: "raw-key" } };
};

describe("@lunora/x402 pay ↔ charge round trip (workerd)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("pays a 402 with a real viem signature and receives the settled resource", async () => {
        expect.hasAssertions();

        const facilitator = stubFacilitator({ settles: true });
        const seen: Request[] = [];
        const pay = await createX402Pay(payConfig({ maxPerCall: "$0.10" }), { fetch: toWorker(seen), getSecret: () => TEST_KEY });

        const response = await pay.fetch(PAID_URL);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("paid-secret");
        expect(response.headers.get("payment-response")).not.toBeNull();
        expect(response.headers.get("cache-control")).toBe("private");

        // Challenge, then one signed retry.
        expect(seen).toHaveLength(2);
        expect(seen[0]!.headers.get("payment-signature")).toBeNull();
        expect(seen[1]!.headers.get("payment-signature")).not.toBeNull();

        // Settle-first: the facilitator settled before the handler produced the body.
        expect(paymentCalls(facilitator)).toStrictEqual(["verify", "settle"]);

        // The facilitator got a genuine 65-byte secp256k1 signature from the test account.
        const verifyBody = facilitator.verifyBodies[0] ?? "";

        expect(verifyBody).toMatch(/"signature":"0x[\da-f]{130}"/iu);
        expect(verifyBody.toLowerCase()).toContain(PAYER.toLowerCase());
    });

    it("withholds the resource when settlement fails after a valid signature", async () => {
        expect.hasAssertions();

        const facilitator = stubFacilitator({ settles: false });
        const pay = await createX402Pay(payConfig({ maxPerCall: "$0.10" }), { fetch: toWorker([]), getSecret: () => TEST_KEY });

        const response = await pay.fetch(PAID_URL);

        expect(response.status).toBe(402);
        await expect(response.text()).resolves.not.toContain("paid-secret");
        expect(paymentCalls(facilitator)).toStrictEqual(["verify", "settle"]);
    });

    it("refuses to sign a price above maxPerCall: no signed retry reaches the worker", async () => {
        expect.hasAssertions();

        const facilitator = stubFacilitator({ settles: true });
        const seen: Request[] = [];
        // The worker charges $0.01; this wallet may spend at most $0.001 per call.
        const pay = await createX402Pay(payConfig({ maxPerCall: "$0.001" }), { fetch: toWorker(seen), getSecret: () => TEST_KEY });

        await expect(pay.fetch(PAID_URL)).rejects.toThrow(/filtered out by policies/u);

        expect(seen).toHaveLength(1);
        expect(facilitator.calls).not.toContain("verify");
        expect(facilitator.calls).not.toContain("settle");
    });

    it("lazyX402Pay builds the rail once and keeps a per-run cap across calls", async () => {
        expect.hasAssertions();

        stubFacilitator({ settles: true });

        const seen: Request[] = [];
        const getSecret = vi.fn<(name: string) => string>(() => TEST_KEY);
        // $0.015 per run admits one $0.01 payment, not two.
        const rail = lazyX402Pay(payConfig({ maxPerRun: "$0.015" }), { fetch: toWorker(seen), getSecret });

        const first = await rail.fetch(PAID_URL);

        expect(first.status).toBe(200);

        await expect(rail.fetch(PAID_URL)).rejects.toThrow(/per-run cap/u);
        expect(getSecret).toHaveBeenCalledTimes(1);
        // Two challenges, one signed retry: the second payment was never signed.
        expect(seen.filter((request) => request.headers.get("payment-signature") !== null)).toHaveLength(1);
    });

    it("sends a request that already carries a payment as-is, reserving nothing", async () => {
        expect.hasAssertions();

        stubFacilitator({ settles: true });

        const seen: Request[] = [];
        // The cap admits exactly one $0.01 payment.
        const rail = lazyX402Pay(payConfig({ maxPerRun: "$0.01" }), { fetch: toWorker(seen), getSecret: () => TEST_KEY });

        // A stale, caller-made payment: the worker answers 402 and the rail hands it back.
        const stale = await rail.fetch(PAID_URL, { headers: { "PAYMENT-SIGNATURE": "stale" } });

        expect(stale.status).toBe(402);

        // Nothing was reserved for it, so the one payment the cap allows still goes through.
        const paid = await rail.fetch(PAID_URL);

        expect(paid.status).toBe(200);
        expect(seen.map((request) => request.headers.get("payment-signature") === "stale")).toStrictEqual([true, false, false]);
    });
});
