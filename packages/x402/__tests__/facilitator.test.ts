import { describe, expect, it } from "vitest";

import { createFacilitatorClient } from "../src/facilitator";

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
