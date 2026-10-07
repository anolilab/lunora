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

import { createChargeMiddleware } from "../../src/charge/middleware";
import type { X402PayConfig } from "../../src/config";
import { createX402Pay, lazyX402Pay } from "../../src/pay";

// A well-known public Hardhat/Anvil test key (account #0). Not a real secret.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secret-scanner:allow -- public Hardhat test key #0
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PAID_URL = "https://x402-smoke.test/paid/report";

const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

interface FacilitatorDouble {
    /** The last path segment of every facilitator call, in order. */
    readonly calls: string[];
    /** The raw `/verify` request bodies. */
    readonly verifyBodies: string[];
}

/** Answer `/supported` + `/verify`, and `/settle` with `settles` (true: success, false: an insufficient-funds refusal). */
const stubFacilitator = (settles: boolean): FacilitatorDouble => {
    const double: FacilitatorDouble = { calls: [], verifyBodies: [] };

    vi.stubGlobal(
        "fetch",
        vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = requestUrl(input);

            double.calls.push(url.split("/").pop() ?? url);

            if (url.endsWith("/supported")) {
                return Response.json({ kinds: [{ network: "eip155:8453", scheme: "exact", x402Version: 2 }] });
            }

            if (url.endsWith("/verify")) {
                double.verifyBodies.push(typeof init?.body === "string" ? init.body : "");

                return Response.json({ isValid: true, payer: TEST_ADDRESS });
            }

            if (url.endsWith("/settle")) {
                return Response.json(
                    settles
                        ? { network: "eip155:8453", payer: TEST_ADDRESS, success: true, transaction: "0xabc" }
                        : { errorReason: "insufficient_funds", network: "eip155:8453", success: false, transaction: "" },
                );
            }

            throw new Error(`unexpected facilitator call: ${url}`);
        }),
    );

    return double;
};

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

        const facilitator = stubFacilitator(true);
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
        expect(verifyBody.toLowerCase()).toContain(TEST_ADDRESS.toLowerCase());
    });

    it("withholds the resource when settlement fails after a valid signature", async () => {
        expect.hasAssertions();

        const facilitator = stubFacilitator(false);
        const pay = await createX402Pay(payConfig({ maxPerCall: "$0.10" }), { fetch: toWorker([]), getSecret: () => TEST_KEY });

        const response = await pay.fetch(PAID_URL);

        expect(response.status).toBe(402);
        await expect(response.text()).resolves.not.toContain("paid-secret");
        expect(paymentCalls(facilitator)).toStrictEqual(["verify", "settle"]);
    });

    it("refuses to sign a price above maxPerCall: no signed retry reaches the worker", async () => {
        expect.hasAssertions();

        const facilitator = stubFacilitator(true);
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

        stubFacilitator(true);

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
});

/**
 * The Solana charge rail in workerd: `@x402/svm`'s server scheme registers and
 * challenges on a Solana network.
 *
 * Not here: the pay side. A full SVM payment needs a recent blockhash from a
 * Solana RPC, which this suite does not fake, and deriving the signer cannot run
 * under this pool at all: the plugin resolves with the `browser` main field,
 * which remaps `@solana/kit` onto its browser build, and that build refuses
 * WebCrypto outside a browser secure context. A wrangler bundle resolves the
 * package's `workerd` export instead (no secure-context assertion in its output),
 * so the gap is in the test pool, not the deployed worker; the Node suite covers
 * the derivation.
 */
describe("@lunora/x402 Solana charge rail (workerd)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("challenges an unpaid request on a Solana network", async () => {
        expect.hasAssertions();

        vi.stubGlobal(
            "fetch",
            vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
                if (requestUrl(input).endsWith("/supported")) {
                    return Response.json({ kinds: [{ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", scheme: "exact", x402Version: 2 }] });
                }

                throw new Error(`unexpected facilitator call: ${requestUrl(input)}`);
            }),
        );

        const middleware = await createChargeMiddleware({
            network: "solana-devnet",
            price: "$0.01",
            recipient: { svm: "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" },
        });
        const handler = vi.fn<() => Response>(() => new Response("paid-secret"));

        const response = await middleware.handle(new Request(PAID_URL), handler);

        expect(response.status).toBe(402);
        expect(handler).not.toHaveBeenCalled();

        const challenge = JSON.parse(atob(response.headers.get("payment-required") ?? "")) as { accepts: { network: string }[] };

        expect(challenge.accepts[0]?.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    });
});
