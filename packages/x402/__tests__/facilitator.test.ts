import { describe, expect, it } from "vitest";

import { DEFAULT_FACILITATOR_URL } from "../src/config";
import { createFacilitatorClient } from "../src/facilitator";

describe("createFacilitatorClient", () => {
    it("defaults to the public facilitator with no auth", async () => {
        const client = createFacilitatorClient();

        expect(client.url).toBe(DEFAULT_FACILITATOR_URL);

        // No configured headers → no auth on any endpoint.
        const auth = await client.createAuthHeaders("verify");

        expect(auth.headers).toEqual({});
    });

    it("honours an overridden facilitator url", () => {
        const client = createFacilitatorClient({ url: "https://facilitator.example/x402" });

        expect(client.url).toBe("https://facilitator.example/x402");
    });

    it("applies configured auth headers to every endpoint", async () => {
        const headers = { authorization: "Bearer cdp-token" }; // secret-scanner:allow -- test fixture, not a real credential
        const client = createFacilitatorClient({ headers });

        const endpoints = ["verify", "settle", "supported"];
        const results = await Promise.all(endpoints.map((endpoint) => client.createAuthHeaders(endpoint)));

        for (const auth of results) {
            expect(auth.headers).toEqual(headers);
        }
    });

    it("snapshots the header map so later mutation of the input is ignored", async () => {
        const headers: Record<string, string> = { authorization: "Bearer one" };
        const client = createFacilitatorClient({ headers });

        headers.authorization = "Bearer two";

        const auth = await client.createAuthHeaders("verify");

        expect(auth.headers).toEqual({ authorization: "Bearer one" });
    });
});
