import type { Entitlements, EntitlementsConfig } from "@cirrus/payment";

/**
 * Cirrus Cloud plans + quota evaluation (CLOUD-PLAN.md §4 / Phase 4). Built on
 * `@cirrus/payment`'s entitlements model: a plan grants numeric `limits` and
 * `features` when an active subscription holds one of its `priceIds`. An org
 * with no active subscription resolves to no entitlements, so we fall back to
 * the `free` plan's limits as the baseline.
 *
 * `priceIds` are placeholders here; the real provider price ids are configured
 * per environment when the payment provider (Stripe/Polar via `@cirrus/payment`)
 * is wired.
 */
export const CIRRUS_CLOUD_PLANS: EntitlementsConfig = {
    plans: {
        enterprise: {
            features: ["customDomains", "logStreams", "sso", "dedicatedCell"],
            limits: { members: 1000, previewDeployments: 1000, projects: 1000 },
            priceIds: ["price_enterprise"],
        },
        free: {
            features: [],
            limits: { members: 1, previewDeployments: 1, projects: 1 },
            priceIds: ["price_free"],
        },
        pro: {
            features: ["customDomains", "logStreams"],
            limits: { members: 10, previewDeployments: 50, projects: 20 },
            priceIds: ["price_pro_monthly", "price_pro_yearly"],
        },
    },
};

/** Baseline limits for an org with no active subscription. */
export const FREE_LIMITS: Record<string, number> = CIRRUS_CLOUD_PLANS.plans["free"]?.limits ?? {};

export type QuotaResource = "members" | "previewDeployments" | "projects";

/**
 * Effective limit for a resource under the resolved entitlements — the granted
 * limit, falling back to the free-plan baseline (so a non-subscriber is still
 * bounded, never unlimited).
 */
export const effectiveLimit = (entitlements: Entitlements, resource: QuotaResource): number => entitlements.limit(resource) ?? FREE_LIMITS[resource] ?? 0;

/** Whether `resource` has room for one more given the current count. */
export const withinQuota = (entitlements: Entitlements, resource: QuotaResource, current: number): boolean => current < effectiveLimit(entitlements, resource);
