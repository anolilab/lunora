import { afterEach, describe, expect, it, vi } from "vitest";

import outbound from "../src/outbound/worker";

/**
 * The Outbound Worker composes egress enforcement after lineage (plan 477 §4.4).
 * Lineage behaviour is unchanged; these tests pin the composition, not the
 * lineage signature (`recursion.test.ts` covers that).
 */

const egressParameter = JSON.stringify({ mode: "enforce", origins: ["https://api.example.com"], v: 1 });

describe("outbound Worker egress composition", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("forwards a request with no egress parameter exactly as before", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

        const response = await outbound.fetch(new Request("https://evil.example.net/x"), {});

        expect(response.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect((fetchSpy.mock.calls[0]?.[0] as Request).url).toBe("https://evil.example.net/x");
    });

    it("refuses a denied origin under an enforcing parameter without reaching the network", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

        const response = await outbound.fetch(new Request("https://evil.example.net/x"), { egress: egressParameter });

        expect(response.status).toBe(403);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses, rather than forwards, a parameter that is present but malformed", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

        const response = await outbound.fetch(new Request("https://api.example.com/x"), { egress: "{not a policy" });

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toStrictEqual({ error: "egress_policy_invalid" });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("stamps lineage on every hop of an allowed request, including the one a redirect reaches", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { headers: { location: "https://api.example.com/y" }, status: 302 }))
            .mockResolvedValue(new Response("ok", { status: 200 }));

        const response = await outbound.fetch(new Request("https://api.example.com/x", { headers: { "x-lunora-lineage": "forged" } }), {
            egress: egressParameter,
            LUNORA_LINEAGE_SECRET: "test-secret",
            lineage: "0.00112233445566778899aabbccddeeff",
        });

        expect(response.status).toBe(200);
        expect(fetchSpy.mock.calls.map(([input]) => (input as Request).url)).toStrictEqual(["https://api.example.com/x", "https://api.example.com/y"]);
        expect(fetchSpy.mock.calls.map(([input]) => (input as Request).headers.get("x-lunora-lineage"))).toStrictEqual([
            expect.stringMatching(/^v1\.1\./),
            expect.stringMatching(/^v1\.1\./),
        ]);
    });
});
