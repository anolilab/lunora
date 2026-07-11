import { useLunora, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface BillingSectionProps {
    organizationId: OrgId;
}

/**
 * Billing tab (§4). Reads the org's resolved entitlements and webhook-synced
 * subscriptions live, and drives Creem checkout / the hosted billing portal through
 * the `billing.checkout` / `billing.portal` actions (which redirect the browser
 * to the provider). Price ids are environment config; entered here rather than
 * hardcoded in the client.
 */
export const BillingSection = ({ organizationId }: BillingSectionProps): ReactElement => {
    const client = useLunora();
    const entitlements = useQuery(api.billing.entitlements, { organizationId });
    const subscriptions = useQuery(api.billing.subscription, { organizationId });

    const [priceId, setPriceId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const startCheckout = (): void => {
        setError(null);
        setBusy(true);

        void (async () => {
            try {
                const { origin } = globalThis.location;
                const { url } = await client.action(api.billing.checkout, {
                    cancelUrl: `${origin}/?billing=cancel`,
                    organizationId,
                    priceId,
                    successUrl: `${origin}/?billing=success`,
                });
                globalThis.location.href = url;
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "checkout failed");
                setBusy(false);
            }
        })();
    };

    const openPortal = (): void => {
        setError(null);
        setBusy(true);

        void (async () => {
            try {
                const { url } = await client.action(api.billing.portal, { organizationId, returnUrl: globalThis.location.origin });
                globalThis.location.href = url;
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "portal failed");
                setBusy(false);
            }
        })();
    };

    return (
        <div className="stack">
            <section className="card">
                <h3>Plan &amp; entitlements</h3>
                {entitlements === undefined ? (
                    <p className="muted">Loading…</p>
                ) : (
                    <div className="stack">
                        <p>
                            Active plan: <span className="badge">{entitlements.plans.length > 0 ? entitlements.plans.join(", ") : "free"}</span>
                        </p>
                        <div className="metrics">
                            <div className="metric">
                                <span className="metric-value">{entitlements.limits.projects}</span>
                                <span className="muted">projects</span>
                            </div>
                            <div className="metric">
                                <span className="metric-value">{entitlements.limits.members}</span>
                                <span className="muted">members</span>
                            </div>
                            <div className="metric">
                                <span className="metric-value">{entitlements.limits.previewDeployments}</span>
                                <span className="muted">previews</span>
                            </div>
                        </div>
                        {entitlements.features.length > 0 ? (
                            <p className="muted">Features: {entitlements.features.join(", ")}</p>
                        ) : (
                            <p className="muted">No add-on features on this plan.</p>
                        )}
                    </div>
                )}
            </section>

            <section className="card">
                <h3>Subscriptions</h3>
                <AsyncList
                    empty="No subscription — this org is on the free plan."
                    render={(rows) => (
                        <ul className="list">
                            {rows.map((sub) => (
                                <li className="row" key={sub.priceId + sub.provider}>
                                    <span className="row-title">{sub.priceId}</span>
                                    <span className="badge">{sub.state}</span>
                                    {sub.cancelAtPeriodEnd ? <span className="muted">cancels at period end</span> : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    rows={subscriptions}
                />
            </section>

            <section className="card">
                <h3>Manage billing</h3>
                <form
                    className="inline-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        startCheckout();
                    }}
                >
                    <input
                        aria-label="Price id"
                        onChange={(event) => {
                            setPriceId(event.target.value);
                        }}
                        placeholder="prod_… (from your Creem dashboard)"
                        required
                        value={priceId}
                    />
                    <button className="primary" disabled={busy} type="submit">
                        Start checkout
                    </button>
                    <button className="link" disabled={busy} onClick={openPortal} type="button">
                        Open billing portal
                    </button>
                </form>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
            </section>
        </div>
    );
};
