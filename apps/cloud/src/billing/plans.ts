import type { Entitlements, EntitlementsConfig } from "@lunora/payment";

/**
 * Lunora Cloud plans + quota evaluation. Built on
 * `@lunora/payment`'s entitlements model: a plan grants numeric `limits` and
 * `features` when an active subscription holds one of its `priceIds`. An org
 * with no active subscription resolves to no entitlements, so we fall back to
 * the `free` plan's limits as the baseline.
 *
 * `limits.backupRetention` is how many daily tenant data snapshots a project
 * keeps (`src/backup/tenant-policy.ts`) — a retention setting, not a quota.
 *
 * `limits.boxes` caps the customer machines an org may enrol for `celld-vps`
 * (plan 458 G16), each of which is also charged per month
 * (`BOX_CREDITS_PER_MONTH`, `src/billing/overage.ts`). Free has none: a box is a
 * paid add-on, and the free tier's single project fits Workers for Platforms.
 * Pro's 3 cover a production box plus a staging or regional one for a team of
 * ten; enterprise's 50 sits where its 1000-project ceiling would spread over
 * dedicated machines, and is a support conversation past that.
 *
 * `limits.cloudflareAccounts` caps the Cloudflare accounts an org may connect
 * for `cloudflare-workers` (MULTIPLATFORM.md Phase 3). Unlike a box it carries
 * no per-account charge: the tenant's compute is billed to the customer's own
 * Cloudflare account, so what Lunora Cloud charges for is the control plane —
 * the plan itself. Free gets one, enough to deploy its one project there; pro's
 * five cover production plus staging accounts for a team; enterprise's hundred
 * is an account per business unit, and a support conversation past that.
 *
 * `priceIds` are placeholders here; Creem is product-based, so these map to
 * real Creem product ids configured per environment when the provider (Creem
 * via `@lunora/payment/creem`) is wired.
 */
export const LUNORA_CLOUD_PLANS: EntitlementsConfig = {
    plans: {
        enterprise: {
            features: ["customDomains", "logStreams", "sso", "dedicatedCell"],
            limits: { backupRetention: 30, boxes: 50, cloudflareAccounts: 100, members: 1000, previewDeployments: 1000, projects: 1000 },
            priceIds: ["price_enterprise"],
        },
        free: {
            features: [],
            limits: { backupRetention: 3, boxes: 0, cloudflareAccounts: 1, members: 1, previewDeployments: 1, projects: 1 },
            priceIds: ["price_free"],
        },
        pro: {
            features: ["customDomains", "logStreams"],
            limits: { backupRetention: 14, boxes: 3, cloudflareAccounts: 5, members: 10, previewDeployments: 50, projects: 20 },
            priceIds: ["price_pro_monthly", "price_pro_yearly"],
        },
    },
};

/** Baseline limits for an org with no active subscription. */
export const FREE_LIMITS: Record<string, number> = LUNORA_CLOUD_PLANS.plans["free"]?.limits ?? {};

export type QuotaResource = "boxes" | "cloudflareAccounts" | "members" | "previewDeployments" | "projects";

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
