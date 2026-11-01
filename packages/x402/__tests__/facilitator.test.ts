import { afterEach, describe, expect, it, vi } from "vitest";

import { createFacilitatorClient } from "../src/facilitator";

/** CDP's hosted facilitator base, as documented; the client appends `/verify` and `/settle`. */
const CDP_BASE = "https://api.cdp.coinbase.com/platform/v2/x402";
const CDP_AUTH = { authorization: "Bearer cdp-token" }; // secret-scanner:allow -- test fixture, not a real credential

const requirements = {
    amount: "10000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    extra: { name: "USD Coin", version: "2" },
    maxTimeoutSeconds: 60,
    network: "eip155:8453",
    payTo: "0x1111111111111111111111111111111111111111",
    scheme: "exact",
} as const;

const payload = {
    accepted: requirements,
    payload: { authorization: {}, signature: "0x" },
    x402Version: 2,
} as const;

const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/** Records each facilitator request and answers the hosted routes with a canned body. */
const stubHostedFacilitator = (responses: Record<string, unknown>) => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => {
        const url = urlOf(input);
        const route = url.slice(CDP_BASE.length + 1);
        const body = responses[route];

        if (body === undefined) {
            return Promise.reject(new Error(`unexpected facilitator call: ${url}`));
        }

        return Promise.resolve(Response.json(body, { status: 200 }));
    });

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

describe("createFacilitatorClient", () => {
    it("throws when no facilitator config is provided", () => {
        expect(() => createFacilitatorClient()).toThrow(/No facilitator URL configured/);
    });

    it("throws when the configured url is empty", () => {
        expect(() => createFacilitatorClient({ url: "" })).toThrow(/No facilitator URL configured/);
    });

    it("honours the configured facilitator url", () => {
        const client = createFacilitatorClient({ url: "https://facilitator.example/x402" });

        expect(client.url).toBe("https://facilitator.example/x402");
    });

    it("applies configured auth headers to every endpoint", async () => {
        const headers = { authorization: "Bearer cdp-token" }; // secret-scanner:allow -- test fixture, not a real credential
        const client = createFacilitatorClient({ headers, url: "https://facilitator.example/x402" });

        const endpoints = ["verify", "settle", "supported"];
        const results = await Promise.all(endpoints.map((endpoint) => client.createAuthHeaders(endpoint)));

        for (const auth of results) {
            expect(auth.headers).toEqual(headers);
        }
    });

    it("snapshots the header map so later mutation of the input is ignored", async () => {
        const headers: Record<string, string> = { authorization: "Bearer one" };
        const client = createFacilitatorClient({ headers, url: "https://facilitator.example/x402" });

        headers.authorization = "Bearer two";

        const auth = await client.createAuthHeaders("verify");

        expect(auth.headers).toEqual({ authorization: "Bearer one" });
    });
});

describe("hosted facilitator endpoints", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("posts verification to the hosted /verify route with the configured auth", async () => {
        const fetchMock = stubHostedFacilitator({ verify: { isValid: true, payer: requirements.payTo } });
        const client = createFacilitatorClient({ headers: CDP_AUTH, url: CDP_BASE });

        const result = await client.verify(payload, requirements);

        expect(result).toMatchObject({ isValid: true, payer: requirements.payTo });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

        expect(url).toBe(`${CDP_BASE}/verify`);
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer cdp-token");
        expect(typeof init.body === "string" ? JSON.parse(init.body) : undefined).toMatchObject({ x402Version: 2 });
    });

    it("posts settlement to the hosted /settle route with the configured auth", async () => {
        const fetchMock = stubHostedFacilitator({
            settle: { network: requirements.network, payer: requirements.payTo, success: true, transaction: "0xabc" },
        });
        const client = createFacilitatorClient({ headers: CDP_AUTH, url: CDP_BASE });

        const result = await client.settle(payload, requirements);

        expect(result).toMatchObject({ success: true, transaction: "0xabc" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

        expect(url).toBe(`${CDP_BASE}/settle`);
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer cdp-token");
    });
});
