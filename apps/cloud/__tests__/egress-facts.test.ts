import { describe, expect, it, vi } from "vitest";

import { createPlanResolver, UNAVAILABLE_PLAN } from "../src/plans/plan-resolver";

/**
 * The control plane's egress answer (plan 477 §5B). A valid policy reaches the
 * script's facts; one that does not validate refuses the script. It is never
 * dropped, because dropping it would serve the tenant with no policy.
 */

const resolverFor = (body: unknown) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));

    return { fetch, resolve: createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp.example", fetch }) };
};

describe("control-plane egress answer", () => {
    it("serves a valid policy as the script's egress facts, normalised", async () => {
        const { resolve } = resolverFor({
            egress: { mode: "enforce", origins: ["HTTPS://API.example.com:443", "https://cdn.example.com"], v: 1 },
            plan: "pro",
        });

        await expect(resolve("acme")).resolves.toStrictEqual({
            egress: { mode: "enforce", origins: ["https://api.example.com", "https://cdn.example.com"], v: 1 },
            plan: "pro",
        });
    });

    it("serves a script with no egress field with no egress facts", async () => {
        const { resolve } = resolverFor({ plan: "free" });

        await expect(resolve("acme")).resolves.toStrictEqual({ plan: "free" });
    });

    it.each([
        { egress: { mode: "enforce", origins: ["https://api.example.com/v1"], v: 1 }, name: "an origin with a path" },
        { egress: { mode: "enforce", origins: ["https://*.example.com"], v: 1 }, name: "a wildcard origin" },
        { egress: { mode: "block", origins: [], v: 1 }, name: "an unknown mode" },
        { egress: { mode: "enforce", origins: [], v: 2 }, name: "an unsupported version" },
        { egress: "enforce", name: "a non-object" },
        { egress: null, name: "an explicit null" },
    ])("refuses the script when the egress answer is $name, rather than serving it unrestricted", async ({ egress }) => {
        const { resolve } = resolverFor({ egress, plan: "pro" });

        await expect(resolve("acme")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });
});
