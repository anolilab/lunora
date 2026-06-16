import type { Entitlements, EntitlementsConfig } from "@lunora/payment";

/**
 * Cirrus Cloud plans + quota evaluation (CLOUD-PLAN.md §4 / Phase 4). Built on
 * `@lunora/payment`'s entitlements model: a plan grants numeric `limits` and
 * `features` when an active subscription holds one of its `priceIds`. An org
 * with no active subscription resolves to no entitlements, so we fall back to
 * the `free` plan's limits as the baseline.
 *
 * `priceIds` are placeholders here; the real provider price ids are configured
 * per environment when the payment provider (Stripe/Polar via `@lunora/payment`)
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

/**
 * Plan tiers, most-generous first. The single source of precedence — used to
 * pick the effective tier when several plans are active and to order runtime
 * limits. (Quota itself resolves from live subscription entitlements, not a
 * plan name — see `lunora/entitlements.ts`.)
 */
export const PLAN_PRECEDENCE = ["enterprise", "pro", "free"] as const;

/** The most-generous plan among the active ones, or `free` when none match. */
export const highestPlan = (plans: ReadonlyArray<string>): string => PLAN_PRECEDENCE.find((plan) => plans.includes(plan)) ?? "free";

/** Per-request runtime caps applied by the dispatcher via `env.DISPATCHER.get(..., { limits })`. */
export interface RuntimeLimits {
    cpuMs: number;
    subRequests: number;
}

const RUNTIME_LIMITS: Record<string, RuntimeLimits> = {
    enterprise: { cpuMs: 1000, subRequests: 1000 },
    free: { cpuMs: 50, subRequests: 50 },
    pro: { cpuMs: 200, subRequests: 200 },
};

/**
 * Runtime limits for a plan name, used by the dispatcher to cap per-tenant CPU
 * and subrequests (§4 quota enforcement on the request path). Falls back to the
 * free tier for an unknown/absent plan, so a tenant is always bounded.
 */
export const limitsForPlan = (plan: string | undefined): RuntimeLimits => RUNTIME_LIMITS[plan ?? "free"] ?? RUNTIME_LIMITS.free;
