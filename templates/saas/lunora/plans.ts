/**
 * The plan catalog — the ONE list of plans, prices and features.
 *
 * The pricing page (`src/routes/settings.billing.tsx`) renders it and
 * `lunora/server.ts` derives the payment entitlements from it, so a plan id,
 * price id or feature name cannot mean one thing to the page and another to
 * `ctx.payments.check`. Plain data with no imports, so the browser bundle can
 * take it without pulling in anything server-side.
 *
 * Replace the `price_*` ids with your provider's.
 */
interface CatalogPlan {
    /** Marketing copy for the pricing table. One line. */
    blurb: string;
    /** ISO 4217, e.g. `"USD"`. */
    currency: string;
    /** Named capabilities this plan unlocks. */
    features: ReadonlyArray<string>;
    /** Stable id — also what `saas_organizations.plan` stores (`free` for a new organisation). */
    id: string;
    name: string;
    /** Provider price id for checkout. Absent on the free plan — there is nothing to buy. */
    priceId?: string;
    /** Minor units (cents). `0` renders as "Free". */
    priceMinor: number;
    /** Maximum members. `undefined` means unmetered. */
    seats?: number;
}

export const PLANS: ReadonlyArray<CatalogPlan> = [
    { blurb: "One organization, three projects", currency: "USD", features: [], id: "free", name: "Free", priceMinor: 0, seats: 1 },
    {
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
        blurb: "SSO and unmetered seats",
        currency: "USD",
        features: ["export", "admin", "sso"],
        id: "scale",
        name: "Scale",
        priceId: "price_scale",
        priceMinor: 9900,
    },
];
