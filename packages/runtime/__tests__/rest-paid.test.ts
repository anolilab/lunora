import { afterEach, describe, expect, it, vi } from "vitest";

// The real charge gate, from source: the runtime deliberately takes no dependency on
// `@lunora/x402`, and a stub gate would not prove what the real x402 v2 header
// names do to the cache.
import { createProcedureChargeGate } from "../../x402/src/charge/procedure";
import { createWorker } from "../src/create-worker";
import { fakeCache } from "./helpers/edge-cache";

/**
 * A paid (`.x402`) procedure on the public REST surface. The edge-cache lookup
 * runs before the paywall, so a paid response stored as `public` would be served
 * to callers who never paid — with the payer's settlement receipt attached.
 */

const PAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const ENDPOINT = "https://app.example/_lunora/rest/reports/premium";

const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/** A facilitator that verifies and settles everything, recording each call. */
const stubFacilitator = (): string[] => {
    const calls: string[] = [];

    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
            const url = urlOf(input);

            calls.push(url.split("/").pop() ?? url);

            if (url.endsWith("/supported")) {
                return Response.json({ kinds: [{ network: "eip155:8453", scheme: "exact", x402Version: 2 }] });
            }

            if (url.endsWith("/verify")) {
                return Response.json({ isValid: true, payer: PAYER });
            }

            if (url.endsWith("/settle")) {
                return Response.json({ network: "eip155:8453", payer: PAYER, success: true, transaction: "0xabc" });
            }

            throw new Error(`unexpected facilitator call ${url}`);
        }),
    );

    return calls;
};

const shardReturning = (body: unknown) => {
    const calls: Request[] = [];

    return {
        calls,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        calls.push(request);

                        return Response.json(body);
                    },
                };
            },
            idFromName: (name: string) => {
                return { __name: name };
            },
        },
    };
};

const collectingContext = () => {
    const pending: Promise<unknown>[] = [];

    return {
        context: { passThroughOnException: () => undefined, waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
        settled: () => Promise.all(pending),
    };
};

/** Answer a 402 challenge the way `@x402/fetch` (v2) does: a `PAYMENT-SIGNATURE` header. */
const paymentSignatureFor = (challenge: Response): string => {
    const required = JSON.parse(atob(challenge.headers.get("payment-required") ?? "")) as { accepts: unknown[]; resource: unknown };

    return btoa(
        JSON.stringify({ accepted: required.accepts[0], payload: { authorization: {}, signature: "0x" }, resource: required.resource, x402Version: 2 }),
    );
};

const gate = () => createProcedureChargeGate({ network: "base", recipient: { evm: RECIPIENT } });

describe("paid (.x402) procedures on the REST surface", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("refuses to construct a worker whose paid REST query declares a public cache", () => {
        expect.assertions(1);

        const shard = shardReturning({ premium: "report" });

        expect(() =>
            createWorker({
                functions: { "reports:premium": { expose: { cache: { maxAge: 60, scope: "public" }, rest: true }, kind: "query", x402: { price: "$0.05" } } },
                shardDO: shard.namespace,
                x402Charge: gate(),
            }),
        ).toThrow(/reports:premium.*paid.*public/s);
    });

    it("answers an unpaid replay after a paid call with a 402 and no receipt", async () => {
        expect.assertions(8);

        const facilitator = stubFacilitator();
        const shard = shardReturning({ premium: "report" });
        const { cache, entries } = fakeCache();
        const { context, settled } = collectingContext();
        const worker = createWorker({
            functions: { "reports:premium": { expose: { cache: { maxAge: 60, scope: "private" }, rest: true }, kind: "query", x402: { price: "$0.05" } } },
            restEdgeCache: cache,
            shardDO: shard.namespace,
            x402Charge: gate(),
        });

        const challenge = await worker.fetch(new Request(ENDPOINT), {}, context);

        expect(challenge.status).toBe(402);

        const paid = await worker.fetch(new Request(ENDPOINT, { headers: { "PAYMENT-SIGNATURE": paymentSignatureFor(challenge) } }), {}, context);

        await settled();

        expect(paid.status).toBe(200);
        expect(paid.headers.get("payment-response")).not.toBeNull();
        expect(paid.headers.get("cache-control") ?? "").not.toMatch(/public/);
        expect(entries.size).toBe(0);

        const replay = await worker.fetch(new Request(ENDPOINT), {}, context);

        expect(replay.status).toBe(402);
        expect(replay.headers.get("payment-response")).toBeNull();
        // Exactly one paid dispatch reached the shard, and it was settled.
        expect([shard.calls.length, facilitator.filter((call) => call === "settle").length]).toStrictEqual([1, 1]);
    });
});
