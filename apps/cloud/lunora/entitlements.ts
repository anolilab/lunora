import type { Entitlements, ProviderId, Subscription, SubscriptionState } from "@lunora/payment";
import { resolveEntitlements } from "@lunora/payment";
import { LunoraError } from "@lunora/server";

import { plansByReference } from "../src/billing/plan-of";
import type { PlanName, QuotaResource } from "../src/billing/plans";
import { effectiveLimit, highestPlan, LUNORA_CLOUD_PLANS } from "../src/billing/plans";
import type { Doc as StoredRow, Id } from "./_generated/dataModel.js";
import type { QueryCtx as QueryContext } from "./_generated/server.js";
import { collectAll } from "./paginate";

/**
 * Live entitlement resolution. Quota is enforced against the
 * org's **synced subscription state**, not the static `organizations.plan`
 * column — the billing (Creem) webhook writes `payment_subscriptions`, so reading them here is the
 * single source of truth (the `plan` column is just the nominal tier the org was
 * created under). An org with no active subscription resolves to the free-plan
 * baseline, so a non-subscriber is always bounded.
 */

/**
 * Adapt a stored subscription row to `@lunora/payment`'s `Subscription`.
 *
 * `Subscription.id` is the *provider's* id, not Lunora's row id — the package
 * maps it to and from `providerSubscriptionId` (`rowToSubscription` /
 * `subscriptionToRow` in `@lunora/payment`'s database store), and
 * `(provider, providerSubscriptionId)` is the unique key its webhook sync
 * reconciles on. Mapping `_id` here would round-trip a Lunora id into that
 * column.
 */
export const toSubscription = (row: StoredRow<"payment_subscriptions">): Subscription => {
    return {
        ...row,
        id: row.providerSubscriptionId,
        // `payment_subscriptions` is `.externallyManaged()` — the payment webhook sync
        // owns these two columns, so the schema keeps them `v.string()` instead
        // of restating the provider layer's unions. Narrowed here rather than
        // filtered: a value this build does not recognize must not silently drop
        // a paying org's subscription out of entitlement resolution.
        provider: row.provider as ProviderId,
        state: row.state as SubscriptionState,
    };
};

/** Resolve an org's entitlements from its synced subscription state. */
export const orgEntitlements = async (context: QueryContext, organizationId: Id<"organizations">): Promise<Entitlements> => {
    const { page } = await context.db.payment_subscriptions.findMany({ where: { referenceId: organizationId } });

    return resolveEntitlements(
        LUNORA_CLOUD_PLANS,
        page.map((row) => toSubscription(row)),
    );
};

/** The plan an org is on, from its synced subscriptions (`src/billing/plan-of.ts`). */
export const orgPlan = async (context: QueryContext, organizationId: Id<"organizations">): Promise<PlanName> => {
    const entitlements = await orgEntitlements(context, organizationId);

    return highestPlan(entitlements.plans);
};

/**
 * The plan of every organization that has subscriptions, from one read of the
 * subscription table. Organizations absent from the map are on `free`.
 */
export const planByOrganization = async (context: QueryContext): Promise<Map<string, string>> => {
    const subscriptions = await collectAll<StoredRow<"payment_subscriptions">>((cursor) => context.db.payment_subscriptions.findMany({ cursor }));

    return plansByReference(subscriptions.map((row) => toSubscription(row)));
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
