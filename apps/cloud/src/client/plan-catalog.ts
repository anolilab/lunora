import { INCLUDED_USAGE } from "../billing/overage";
import { LUNORA_CLOUD_PLANS } from "../billing/plans";

/** The nominal tiers an org can be created under (matches `organizations.create`). */
export type PlanId = "enterprise" | "free" | "pro";

/** Card order — cheapest first, as shown in the create flow. */
export const PLAN_ORDER: readonly PlanId[] = ["free", "pro", "enterprise"];

/** Human labels for the entitlement feature flags in {@link LUNORA_CLOUD_PLANS}. */
const FEATURE_LABELS: Record<string, string> = {
    customDomains: "Custom domains",
    dedicatedCell: "Dedicated cell — isolated Cloudflare account",
    logStreams: "Log streams & observability",
    sso: "SAML single sign-on",
};

const PLAN_META: Record<PlanId, { name: string; tagline: string }> = {
    enterprise: { name: "Enterprise", tagline: "SSO, isolation, and scale for larger teams." },
    free: { name: "Free", tagline: "For personal projects and getting started." },
    pro: { name: "Pro", tagline: "For teams shipping to production." },
};

const compact = (value: number): string => new Intl.NumberFormat("en", { notation: "compact" }).format(value);
const plural = (count: number, noun: string): string => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

export interface PlanCard {
    /** Add-on capabilities the plan unlocks (empty on free). */
    features: string[];
    id: PlanId;
    /** Quota lines (projects / members / previews / included usage). */
    quotas: string[];
    name: string;
    tagline: string;
}

/**
 * The plan cards shown when creating an organization, derived from the canonical
 * plan config (`LUNORA_CLOUD_PLANS`) and the included-usage table so the UI can
 * never drift from what the server actually grants.
 */
export const PLAN_CATALOG: readonly PlanCard[] = PLAN_ORDER.map((id) => {
    const plan = LUNORA_CLOUD_PLANS.plans[id];
    const usage = INCLUDED_USAGE[id];
    const projects = plan?.limits?.projects ?? 0;
    const members = plan?.limits?.members ?? 0;
    const previews = plan?.limits?.previewDeployments ?? 0;

    return {
        features: (plan?.features ?? []).map((feature) => FEATURE_LABELS[feature] ?? feature),
        id,
        name: PLAN_META[id].name,
        quotas: [
            plural(projects, "project"),
            plural(members, "team member"),
            plural(previews, "preview deployment"),
            `${compact(usage?.requests ?? 0)} requests / month included`,
            `${compact(usage?.cpuMs ?? 0)} CPU-ms / month included`,
        ],
        tagline: PLAN_META[id].tagline,
    };
});

/** Look up a single plan card by id (falls back to free). */
export const planCard = (id: PlanId): PlanCard => PLAN_CATALOG.find((card) => card.id === id) ?? PLAN_CATALOG[0];

/** Every tier except `free` is paid and routes through Creem checkout. */
export const isPaidPlan = (id: PlanId): boolean => id !== "free";

/**
 * The Creem price/product id to start checkout with for a plan — the first of the
 * plan's configured `priceIds` (per-environment Creem products). `undefined` for
 * a plan with none (e.g. free), so the caller can skip checkout.
 */
export const planPriceId = (id: PlanId): string | undefined => LUNORA_CLOUD_PLANS.plans[id]?.priceIds?.[0];
