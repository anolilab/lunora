/**
 * The plan catalog — the ONE list of plans, prices and features.
 *
 * The pricing page (`src/routes/settings.billing.tsx`) renders it and
 * `lunora/server.ts` derives the payment entitlements from it, so a plan id,
 * price id or feature name cannot mean one thing to the page and another to
 * `ctx.payments.check`. Plain data and one pure function, with no imports, so the
 * browser bundle can take it without pulling in anything server-side.
 *
 * Replace the `price_*` ids with your provider's.
 */

/**
 * The metered feature `ctx.payments.track` records and `ctx.payments.check` reads.
 * One name, shared by the catalog's limit key and both payment functions, so the
 * allowance a plan grants is the one the check consults.
 */
export const API_CALLS = "api_calls";

interface CatalogPlan {
    /** Marketing copy for the pricing table. One line. */
    blurb: string;
    /** ISO 4217, e.g. `"USD"`. */
    currency: string;
    /**
     * `api_calls` allowance per billing period. `0` grants none. The free plan has
     * no price, so `entitlementsFromPlans` never reaches it: an organisation without
     * an active paid subscription is denied `api_calls`. The `0` records that policy
     * instead of leaving the plan's allowance unstated.
     */
    apiCalls: number;
    /** Named capabilities this plan unlocks. */
    features: ReadonlyArray<string>;
    /** Stable id — also what `saas_organizations.plan` stores (`free` for a new organisation). */
    id: string;
    name: string;
    /** Provider price id for checkout. Absent on the free plan — there is nothing to buy. */
    priceId?: string;
    /** Minor units (cents). `0` renders as "Free". */
    priceMinor: number;
    /**
     * Maximum members. `undefined` means unmetered. Shown on the billing page's seat
     * meter and handed to the payment entitlements; nothing here stops an invitation
     * at the limit. `saas_organizations.plan` is not yet synced from the
     * subscription, so a cap keyed on it would hold paying organisations to the
     * free allowance — sync the plan first, then enforce in better-auth's
     * `membershipLimit`.
     */
    seats?: number;
}

export const PLANS: ReadonlyArray<CatalogPlan> = [
    { apiCalls: 0, blurb: "One member, to try it out", currency: "USD", features: [], id: "free", name: "Free", priceMinor: 0, seats: 1 },
    {
        apiCalls: 10_000,
        blurb: "Your whole team, unlimited projects",
        currency: "USD",
        features: ["export", "admin"],
        id: "pro",
        name: "Pro",
        priceId: "price_pro",
        priceMinor: 2900,
        seats: 10,
    },
    {
        apiCalls: 100_000,
        blurb: "SSO and unmetered seats",
        currency: "USD",
        features: ["export", "admin", "sso"],
        id: "scale",
        name: "Scale",
        priceId: "price_scale",
        priceMinor: 9900,
    },
];

/**
 * Plan catalog → the payment entitlements `createPayment` resolves `check` against.
 * Only priced plans appear: a plan without a `priceId` cannot be matched to a
 * subscription, so it grants nothing.
 */
export const entitlementsFromPlans = (
    plans: ReadonlyArray<CatalogPlan>,
): { plans: Record<string, { features: ReadonlyArray<string>; limits: Record<string, number>; priceIds: ReadonlyArray<string> }> } => ({
    plans: Object.fromEntries(
        plans.flatMap((plan) =>
            plan.priceId === undefined
                ? []
                : [
                      [
                          plan.id,
                          {
                              features: plan.features,
                              limits: { [API_CALLS]: plan.apiCalls, ...(plan.seats === undefined ? {} : { seats: plan.seats }) },
                              priceIds: [plan.priceId],
                          },
                      ],
                  ],
        ),
    ),
});
