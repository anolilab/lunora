import { resolveEntitlements } from "@lunora/payment";
import { describe, expect, it } from "vitest";

import { effectiveLimit, FREE_LIMITS, LUNORA_CLOUD_PLANS, withinQuota } from "../src/billing/plans";

/** Build a fake Entitlements that grants a fixed set of numeric limits. */
const entitlementsWith = (limits: Record<string, number>): Parameters<typeof effectiveLimit>[0] => {
    return {
        features: new Set<string>(),
        has: () => false,
        limit: (key: string) => limits[key],
        plans: [],
    };
};

describe("billing plans + quota", () => {
    it("falls back to the free baseline when there is no active subscription", () => {
        // resolveEntitlements with no subscriptions grants nothing → free fallback.
        const entitlements = resolveEntitlements(LUNORA_CLOUD_PLANS, []);

        expect(effectiveLimit(entitlements, "projects")).toBe(FREE_LIMITS["projects"]);
        expect(withinQuota(entitlements, "projects", 0)).toBe(true);
        expect(withinQuota(entitlements, "projects", 1)).toBe(false);
    });

    it("uses a granted limit over the free baseline", () => {
        const pro = entitlementsWith({ projects: 20 });

        expect(effectiveLimit(pro, "projects")).toBe(20);
        expect(withinQuota(pro, "projects", 19)).toBe(true);
        expect(withinQuota(pro, "projects", 20)).toBe(false);
    });

    it("bounds every resource even with empty entitlements", () => {
        const none = entitlementsWith({});

        for (const resource of ["projects", "members", "previewDeployments"] as const) {
            expect(effectiveLimit(none, resource)).toBe(FREE_LIMITS[resource]);
        }
    });
});
