/**
 * The tenant's Cloudflare fetch options survive the Outbound Worker's redirect
 * walk. Only workerd gives a `Request` a `cf`, so the node suite cannot see one
 * dropped: every hop is rebuilt from its URL, which starts with none.
 */
import { describe, expect, it } from "vitest";

import { stampLineage } from "../../src/dispatcher/lineage";
import { forwardWithEgress } from "../../src/egress/forward";

const CF = { cacheEverything: true, cacheTtl: 120 };

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
});
