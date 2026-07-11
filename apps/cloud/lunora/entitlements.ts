import type { Entitlements, Subscription } from "@lunora/payment";
import { resolveEntitlements } from "@lunora/payment";
import { LunoraError } from "@lunora/server";

import type { QuotaResource } from "../src/billing/plans";
import { effectiveLimit, LUNORA_CLOUD_PLANS } from "../src/billing/plans";
import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx as QueryContext } from "./_generated/server.js";

/**
 * Live entitlement resolution (CLOUD-PLAN.md §4). Quota is enforced against the
 * org's **synced subscription state**, not the static `organizations.plan`
 * column — the billing (Creem) webhook writes `subscriptions`, so reading them here is the
 * single source of truth (the `plan` column is just the nominal tier the org was
 * created under). An org with no active subscription resolves to the free-plan
 * baseline, so a non-subscriber is always bounded.
 */

/** Resolve an org's entitlements from its synced subscription state. */
export const orgEntitlements = async (context: QueryContext, organizationId: Id<"organizations">): Promise<Entitlements> => {
    const { page } = await context.db.subscriptions.findMany({ where: { referenceId: organizationId } });

    return resolveEntitlements(LUNORA_CLOUD_PLANS, page as unknown as Subscription[]);
};

/** The effective per-resource limit for an org, resolved from its subscriptions. */
export const orgLimit = async (context: QueryContext, organizationId: Id<"organizations">, resource: QuotaResource): Promise<number> =>
    effectiveLimit(await orgEntitlements(context, organizationId), resource);

/**
 * Throw `FORBIDDEN` when adding one more `resource` would exceed the org's plan
 * limit. `current` is the present count of that resource.
 */
export const assertWithinQuota = async (
    context: QueryContext,
    organizationId: Id<"organizations">,
    resource: QuotaResource,
    current: number,
): Promise<void> => {
    const limit = await orgLimit(context, organizationId, resource);

    if (current >= limit) {
        throw new LunoraError("FORBIDDEN", `${resource} quota reached for this plan (limit ${String(limit)})`);
    }
};
