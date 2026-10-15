import { useAction, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";

import { api } from "../../lunora/_generated/api";
import { PLANS } from "../../lunora/plans";
import { BillingPanel, PricingTable } from "../../lunora/saas-ui/react";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/settings/billing")({
    component: BillingPage,
});

/**
 * The billing page. The plan catalog is `lunora/plans.ts` — the same list the
 * server derives its entitlements from, so the page cannot offer a feature the
 * gate does not know.
 *
 * No `shardKey` on these calls, on purpose: a provider webhook arrives with no
 * tenant to route by, so the billing tables live on the root shard and carry
 * the organisation in `referenceId` instead. The functions derive that from the
 * verified claim, so they are tenant-scoped all the same.
 */
function BillingPage() {
    const me = useQuery(api.saas.me, {});
    const subscriptions = useQuery(api.payment.mySubscriptions, me?.organizationId === undefined ? "skip" : {});
    // `useAction` returns `{ call, pending, … }` rather than a callable, the same
    // shape as `useMutation` — destructure at the call site.
    const { call: checkout } = useAction(api.payment.checkout);
    const { call: portal } = useAction(api.payment.portal);

    // The member count off the admin projection, which better-auth's
    // organization hooks keep current (`lunora/auth/index.ts`).
    const memberCount = me?.seats ?? 1;

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
