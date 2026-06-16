import type { Subscription } from "@lunora/payment";
import { resolveEntitlements } from "@lunora/payment";

import type { QuotaResource } from "../src/billing/plans";
import { CIRRUS_CLOUD_PLANS, effectiveLimit } from "../src/billing/plans";
import { action, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/**
 * Billing (CLOUD-PLAN.md §4) on `@lunora/payment`. The org id is the payment
 * `referenceId`, so a subscription, customer, and metered usage all key on the
 * organization. `ctx.payments` is the facade codegen wires onto the action/
 * mutation context when these functions reach for it; the payment store rides
 * this request's `ctx.db` (the `.global()` payment tables in the control-plane
 * D1), and the provider adapter comes from `createShardDO({ payment })` in
 * `src/server.ts`.
 *
 * Checkout/portal/webhook need a configured provider (Stripe keys); entitlement
 * reads (`entitlements`, `subscription`) work offline — an org with no active
 * subscription resolves to the free-plan baseline.
 */

const QUOTA_RESOURCES: QuotaResource[] = ["projects", "members", "previewDeployments"];

interface SubscriptionRow {
    cancelAtPeriodEnd?: boolean;
    currentPeriodEnd?: number;
    priceId: string;
    provider: string;
    referenceId: string;
    state: string;
}

/**
 * Start a provider Checkout session for the org's subscription. Owners/admins
 * only. Returns the redirect URL the studio sends the browser to.
 */
export const checkout = action({
    args: {
        cancelUrl: v.string(),
        organizationId: v.id("organizations"),
        priceId: v.string(),
        successUrl: v.string(),
    },
    handler: async (context, { cancelUrl, organizationId, priceId, successUrl }): Promise<{ url: string }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const result = await context.payments.createCheckout({
            cancelUrl,
            mode: "subscription",
            priceId,
            referenceId: organizationId,
            successUrl,
        });

        return { url: result.url };
    },
});

/** Open the provider billing portal for the org (owners/admins only). */
export const portal = action({
    args: { organizationId: v.id("organizations"), returnUrl: v.string() },
    handler: async (context, { organizationId, returnUrl }): Promise<{ url: string }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        return context.payments.createPortalSession(organizationId, returnUrl);
    },
});

/**
 * Resolved entitlements for an org (members). Reads webhook-synced subscription
 * state and maps it through {@link CIRRUS_CLOUD_PLANS}: the active plan names,
 * granted features, and the effective per-resource limits (free baseline when
 * there's no active subscription, so a non-subscriber is bounded, never
 * unlimited).
 */
export const entitlements = query({
    args: { organizationId: v.id("organizations") },
    handler: async (
        context,
        { organizationId },
        // The limits key union is inlined (not the `QuotaResource` alias): codegen
        // copies this annotation verbatim into the generated api and can't resolve
        // a cross-module type name.
    ): Promise<{ features: string[]; limits: Record<"members" | "previewDeployments" | "projects", number>; plans: string[] }> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.subscriptions.findMany({ where: { referenceId: organizationId } });
        const resolved = resolveEntitlements(CIRRUS_CLOUD_PLANS, page as unknown as Subscription[]);

        const limits = Object.fromEntries(QUOTA_RESOURCES.map((resource) => [resource, effectiveLimit(resolved, resource)])) as Record<QuotaResource, number>;

        return { features: [...resolved.features], limits, plans: [...resolved.plans] };
    },
});

/** The org's subscriptions (members) — drives the studio billing tab. */
export const subscription = query({
    args: { organizationId: v.id("organizations") },
    handler: async (context, { organizationId }): Promise<SubscriptionRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.subscriptions.findMany({ where: { referenceId: organizationId } });

        return page;
    },
});

/**
 * Apply a verified provider webhook. Public by design — webhooks are
 * unauthenticated but signature-verified inside `ctx.payments.handleWebhook`
 * (a forged body without a valid signature is rejected). The edge route
 * (`POST /v1/billing/webhook`) forwards the raw body + signature here so the
 * verification + store write happen where `ctx.payments` exists.
 */
export const processWebhook = action({
    args: { body: v.string(), signature: v.string() },
    handler: async (context, { body, signature }): Promise<{ applied: boolean; status: number }> => {
        const request = new Request("https://internal/billing/webhook", {
            body,
            headers: { "stripe-signature": signature },
            method: "POST",
        });
        const response = await context.payments.handleWebhook(request);
        const result: { applied?: boolean } = await response.json();

        return { applied: result.applied ?? false, status: response.status };
    },
});
