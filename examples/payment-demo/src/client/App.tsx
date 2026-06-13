import { CheckoutButton, CustomerPortalButton, useCirrus, useQuery } from "@cirrus/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api.js";

interface SubscriptionRow {
    providerSubscriptionId: string;
    state: string;
}

/**
 * Demo UI: enter a Stripe price id, click Subscribe → the `checkout` action
 * returns a hosted-checkout URL and `CheckoutButton` redirects to it. The
 * subscription list re-renders the moment the webhook syncs a change into the
 * store (reactive `useQuery`).
 */
export const App = (): ReactElement => {
    const client = useCirrus();
    const [priceId, setPriceId] = useState("price_123");

    const subscriptions = useQuery(api.billing.mySubscriptions, {}) as SubscriptionRow[] | undefined;

    return (
        <main style={{ fontFamily: "system-ui", margin: "0 auto", maxWidth: 480, padding: 24 }}>
            <h1>Cirrus Payment Demo</h1>

            <label style={{ display: "block", marginBottom: 8 }}>
                Stripe price id
                <input onChange={(event) => setPriceId(event.target.value)} style={{ display: "block", width: "100%" }} value={priceId} />
            </label>

            <CheckoutButton onCheckout={() => client.action(api.billing.checkout, { priceId })}>Subscribe</CheckoutButton>{" "}
            <CustomerPortalButton onPortal={() => client.action(api.billing.portal, {})}>Manage billing</CustomerPortalButton>

            <h2>Your subscriptions</h2>
            {subscriptions === undefined ? (
                <p>Loading…</p>
            ) : (
                <ul>
                    {subscriptions.map((subscription) => (
                        <li key={subscription.providerSubscriptionId}>
                            {subscription.providerSubscriptionId} — {subscription.state}
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
};
