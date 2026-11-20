/**
 * The tenant's Cloudflare fetch options survive the Outbound Worker's redirect
 * walk, except `resolveOverride` under an enforcing policy. Only workerd gives a
 * `Request` a `cf`, so the node suite cannot see one dropped: every hop is
 * rebuilt from its URL, which starts with none.
 */
import { describe, expect, it } from "vitest";

import { stampLineage } from "../../src/dispatcher/lineage";
import { forwardWithEgress } from "../../src/egress/forward";
import type { EgressPolicy } from "../../src/egress/policy";

const CF = { cacheEverything: true, cacheTtl: 120 };

const ENFORCE: EgressPolicy = { mode: "enforce", origins: ["https://tenant.example"], v: 1 };

const lineageEnv = {
    LUNORA_LINEAGE_SECRET: "test-secret",
    lineage: "0.00112233445566778899aabbccddeeff",
};

describe("outbound redirect walk", () => {
    it("sends the tenant's cf options on every hop, lineage stamped included", async () => {
        const seen: unknown[] = [];
        const upstream = async (request: Request): Promise<Response> => {
            seen.push(request.cf);

            return seen.length === 1 ? new Response(null, { headers: { location: "https://www.tenant.example/y" }, status: 301 }) : new Response("ok");
        };

        const response = await forwardWithEgress(new Request("https://tenant.example/x", { cf: CF }), undefined, upstream, (hop) =>
            stampLineage(hop, lineageEnv, Date.now()),
        );

        expect(response.status).toBe(200);
        expect(seen).toStrictEqual([CF, CF]);
    });

    it("never sends resolveOverride under an enforcing policy, on the first hop or a redirect", async () => {
        const seen: unknown[] = [];
        const upstream = async (request: Request): Promise<Response> => {
            seen.push(request.cf);

            return seen.length === 1 ? new Response(null, { headers: { location: "https://tenant.example/y" }, status: 301 }) : new Response("ok");
        };

        const response = await forwardWithEgress(
            new Request("https://tenant.example/x", { cf: { ...CF, resolveOverride: "elsewhere.example.net" } }),
            ENFORCE,
            upstream,
        );

        expect(response.status).toBe(200);
        expect(seen).toStrictEqual([CF, CF]);
    });

    it("never sends resolveOverride under an enforcing policy when the tenant handles redirects itself", async () => {
        const seen: unknown[] = [];
        const upstream = async (request: Request): Promise<Response> => {
            seen.push(request.cf);

            return new Response("ok");
        };

        await forwardWithEgress(
            new Request("https://tenant.example/x", { cf: { ...CF, resolveOverride: "elsewhere.example.net" }, redirect: "manual" }),
            ENFORCE,
            upstream,
        );

        expect(seen).toStrictEqual([CF]);
    });
});
