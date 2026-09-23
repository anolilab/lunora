import { useAction, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../lunora/_generated/api";
import type { Plan } from "../../lunora/saas-ui/core";
import { BillingPanel, PricingTable } from "../../lunora/saas-ui/react";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/settings/billing")({
    component: BillingPage,
});

/**
 * The plan catalog the pricing page renders.
 *
 * It has to agree with `ENTITLEMENTS` in `lunora/server.ts` — same plan ids,
 * same feature names, same price ids. They are separate on purpose: that one
 * gates a mutation and is the one that matters; this one renders a price and is
 * the one a designer edits. Keeping the gate out of the marketing copy is how
 * an edit here stays unable to hand anybody a feature.
 */
const PLANS: ReadonlyArray<Plan> = [
    { blurb: "One organization, three projects", currency: "USD", features: ["projects"], id: "free", name: "Free", priceMinor: 0, seats: 1 },
    {
        blurb: "Your whole team, unlimited projects",
        currency: "USD",
        features: ["projects", "export", "admin"],
        id: "pro",
        name: "Pro",
        priceId: "price_pro",
        priceMinor: 2900,
        seats: 10,
    },
    {
        blurb: "SSO and unmetered seats",
        currency: "USD",
        features: ["projects", "export", "admin", "sso"],
        id: "scale",
        name: "Scale",
        priceId: "price_scale",
        priceMinor: 9900,
    },
];

function BillingPage() {
    // Billing lives on the organization, so both of these are already
    // tenant-scoped: the functions derive the reference from the verified claim.
    const subscriptions = useQuery(api.payment.mySubscriptions, {});
    // `useAction` returns `{ call, pending, … }` rather than a callable, the same
    // shape as `useMutation` — destructure at the call site.
    const { call: checkout } = useAction(api.payment.checkout);
    const { call: portal } = useAction(api.payment.portal);

    // Members come from better-auth, which is not a Lunora table — wire your
    // organization's member list in here. Until then the seat meter reads 1.
    const memberCount = 1;

    const subscription = subscriptions?.[0];

    return (
        <main style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }}>
            <BillingPanel
                memberCount={memberCount}
                onManage={async () => {
                    const { url } = await portal({});

                    globalThis.location.assign(url);
                }}
                plans={PLANS}
                subscription={subscription}
            />
            <PricingTable
                onSelect={async (priceId) => {
                    const { url } = await checkout({ priceId });

                    globalThis.location.assign(url);
                }}
                plans={PLANS}
                subscription={subscription}
            />
        </main>
    );
}
