import { useLunora, useQuery } from "@lunora/react";
import { CheckoutButton, CustomerPortalButton } from "@lunora/react/payment";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";

/**
 * Demo UI: enter a Stripe price id, click Subscribe → the `checkout` action
 * returns a hosted-checkout URL and `CheckoutButton` redirects to it. The
 * subscription list re-renders the moment the webhook syncs a change into the
 * store (reactive `useQuery`).
 */
export const App = (): ReactElement => {
    const client = useLunora();
    const [priceId, setPriceId] = useState("price_123");

    // No cast and no local row type: `api` carries the query's return type, so
    // `subscriptions` infers end to end from the server. A hand-written mirror
    // behind an `as` is free to drift from what the handler actually returns —
    // which is the one thing this framework is supposed to make impossible.
    const subscriptions = useQuery(api.billing.mySubscriptions, {});

    return (
        <main style={{ fontFamily: "system-ui", margin: "0 auto", maxWidth: 480, padding: 24 }}>
            <h1>Lunora Payment Demo</h1>
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
                            {/* Outranks `state`: a subscription can be `active` AND ending. */}
                            {subscription.cancelAtPeriodEnd ? " (cancels at period end)" : ""}
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
};
