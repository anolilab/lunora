import { resolveEntitlements } from "@lunora/payment";

import { evaluateDunning } from "../src/billing/dunning";
import type { QuotaResource } from "../src/billing/plans";
import { effectiveLimit, LUNORA_CLOUD_PLANS } from "../src/billing/plans";
import type { Id } from "./_generated/dataModel.js";
import { action, internalMutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { toSubscription } from "./entitlements";
import { rateLimit } from "./guards";
import { collectAll } from "./paginate";
import { boundedString, LIMITS } from "./validators";

/**
 * Billing (CLOUD-PLAN.md §4) on `@lunora/payment`. The org id is the payment
 * `referenceId`, so a subscription, customer, and metered usage all key on the
 * organization. `ctx.payments` is the facade codegen wires onto the action/
 * mutation context when these functions reach for it; the payment store rides
 * this request's `ctx.db` (the `.global()` payment tables in the control-plane
 * D1), and the provider adapter comes from `createShardDO({ payment })` in
 * `src/server.ts`.
 *
 * Checkout/portal/webhook need a configured provider (Creem keys); entitlement
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
export const checkout = action
    .use(rateLimit("billing"))
    .input({
        cancelUrl: boundedString(LIMITS.url),
        organizationId: v.id("organizations"),
        priceId: boundedString(LIMITS.name),
        successUrl: boundedString(LIMITS.url),
    })
    .action(async ({ ctx: context, args: { cancelUrl, organizationId, priceId, successUrl } }): Promise<{ url: string }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const result = await context.payments.createCheckout({
            cancelUrl,
            mode: "subscription",
            priceId,
            referenceId: organizationId,
            successUrl,
        });

        return { url: result.url };
    });

/** Open the provider billing portal for the org (owners/admins only). */
export const portal = action
    .use(rateLimit("billing"))
    .input({
        organizationId: v.id("organizations"),
        returnUrl: boundedString(LIMITS.url),
    })
    .action(async ({ ctx: context, args: { organizationId, returnUrl } }): Promise<{ url: string }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        return context.payments.createPortalSession(organizationId, returnUrl);
    });

/**
 * Resolved entitlements for an org (members). Reads webhook-synced subscription
 * state and maps it through {@link LUNORA_CLOUD_PLANS}: the active plan names,
 * granted features, and the effective per-resource limits (free baseline when
 * there's no active subscription, so a non-subscriber is bounded, never
 * unlimited).
 */
export const entitlements = query
    .input({ organizationId: v.id("organizations") })
    .query(
        async ({
            ctx: context,
            args: { organizationId },
        }): Promise<{ features: string[]; limits: Record<"members" | "previewDeployments" | "projects", number>; plans: string[] }> => {
            await assertMember(context, organizationId);

            const { page } = await context.db.subscriptions.findMany({ where: { referenceId: organizationId } });
            const resolved = resolveEntitlements(
                LUNORA_CLOUD_PLANS,
                page.map((row) => toSubscription(row)),
            );

            const limits = Object.fromEntries(QUOTA_RESOURCES.map((resource) => [resource, effectiveLimit(resolved, resource)])) as Record<
                QuotaResource,
                number
            >;

            return { features: [...resolved.features], limits, plans: [...resolved.plans] };
        },
    );

/** The org's subscriptions (members) — drives the studio billing tab. */
export const subscription = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<SubscriptionRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.subscriptions.findMany({ where: { referenceId: organizationId } });

        return page;
    });

/**
 * Apply a verified provider webhook. Public by design — webhooks are
 * unauthenticated but signature-verified inside `ctx.payments.handleWebhook`
 * (a forged body without a valid signature is rejected). The edge route
 * (`POST /v1/billing/webhook`) forwards the raw body + signature here so the
 * verification + store write happen where `ctx.payments` exists.
 */
export const processWebhook = action
    .use(rateLimit("webhook"))
    .input({
        body: boundedString(LIMITS.webhookBody),
        signature: boundedString(LIMITS.signature),
    })
    .action(async ({ ctx: context, args: { body, signature } }): Promise<{ applied: boolean; status: number }> => {
        const request = new Request("https://internal/billing/webhook", {
            body,
            headers: { "creem-signature": signature },
            method: "POST",
        });
        const response = await context.payments.handleWebhook(request);
        const result: { applied?: boolean } = await response.json();

        return { applied: result.applied ?? false, status: response.status };
    });

/**
 * Dunning enforcement (GAPS.md C2): payment failure → 14-day grace → suspend.
 * Reads the synced subscription states per org (the billing webhook keeps them
 * current), stamps/clears `paymentFailedAt`, and suspends orgs whose grace ran
 * out — lifting only its own suspensions on recovery (spend-cap/support ones
 * stay). SYSTEM only (cron dispatch).
 */
export const enforceDunning = internalMutation.mutation(async ({ ctx: context }): Promise<{ graced: number; recovered: number; suspended: number }> => {
    const { now } = context;
    // Both reads drain every page. A single `findMany({})` page stops at 1000 rows, so
    // any organization past that boundary was never dunned — no grace stamp, no
    // suspension, and no recovery either — while the sweep still reported success.
    const subscriptions = await collectAll<SubscriptionRow>((cursor) => context.db.subscriptions.findMany({ cursor }));
    const statesByOrg = new Map<string, string[]>();

    for (const row of subscriptions) {
        const states = statesByOrg.get(row.referenceId) ?? [];

        states.push(row.state);
        statesByOrg.set(row.referenceId, states);
    }

    const organizations = await collectAll<{
        _id: string;
        paymentFailedAt?: number;
        suspendedAt?: number;
        suspendedReason?: string;
    }>((cursor) => context.db.organizations.findMany({ cursor }));

    // Map the evaluated phase to the patch this org needs (or null for no-op);
    // extracted so the loop stays a flat apply.
    const patchFor = (
        organization: { paymentFailedAt?: number; suspendedAt?: number; suspendedReason?: string },
        decision: ReturnType<typeof evaluateDunning>,
    ): null | { counter: "graced" | "recovered" | "suspended"; patch: Record<string, unknown> } => {
        if (decision.phase === "ok") {
            if (organization.paymentFailedAt == null && organization.suspendedReason !== "dunning") {
                return null;
            }

            return {
                counter: "recovered",
                patch: {
                    paymentFailedAt: undefined,
                    ...(organization.suspendedReason === "dunning" ? { suspendedAt: undefined, suspendedReason: undefined } : {}),
                },
            };
        }

        if (decision.phase === "grace") {
            return organization.paymentFailedAt == null ? { counter: "graced", patch: { paymentFailedAt: decision.paymentFailedAt } } : null;
        }

        return organization.suspendedAt == null
            ? { counter: "suspended", patch: { paymentFailedAt: decision.paymentFailedAt, suspendedAt: now, suspendedReason: "dunning" } }
            : null;
    };

    const counters = { graced: 0, recovered: 0, suspended: 0 };

    for (const organization of organizations) {
        const decision = evaluateDunning({
            now,
            paymentFailedAt: organization.paymentFailedAt,
            subscriptionStates: statesByOrg.get(organization._id) ?? [],
        });
        const outcome = patchFor(organization, decision);

        if (outcome) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organization._id as Id<"organizations">, outcome.patch);

            if (outcome.counter === "suspended") {
                // eslint-disable-next-line no-await-in-loop -- one audit row per transition
                await context.db.insert("auditLog", {
                    action: "organization.suspend",
                    actorUserId: "system:dunning",
                    createdAt: now,
                    organizationId: organization._id,
                    target: "payment failure grace exhausted",
                });
            }

            counters[outcome.counter] += 1;
        }
    }

    return counters;
});
