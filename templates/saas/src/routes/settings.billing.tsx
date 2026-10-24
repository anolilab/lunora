import { useAction, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../../lunora/_generated/api";
import { PLANS } from "../../lunora/plans";
import { currentSubscription } from "../../lunora/saas-ui/core";
import { BillingPanel, PricingTable } from "../../lunora/saas-ui/react";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/settings/billing")({
    component: BillingPage,
});

/** Roles the server lets start a checkout or open the portal (`BILLING_ADMIN_ROLES` in `lunora/payment/index.ts`). */
const BILLING_ADMIN_ROLES = new Set(["admin", "owner"]);

const message = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong — try again.");

/**
 * The billing page. The plan catalog is `lunora/plans.ts` — the same list the
 * server derives its entitlements from, so the page cannot offer a feature the
 * gate does not know.
 *
 * Billing belongs to an organisation, so this resolves who is looking first: a
 * signed-out visitor or one with no active organisation gets the matching
 * message instead of buttons whose actions the server would refuse.
 *
 * No `shardKey` on these calls, on purpose: a provider webhook arrives with no
 * tenant to route by, so the billing tables live on the root shard and carry
 * the organisation in `referenceId` instead. The functions derive that from the
 * verified claim, so they are tenant-scoped all the same.
 */
function BillingPage() {
    // `authorizeShard` turns an anonymous caller away from every shard, the root
    // included, so a signed-out visitor sees this subscription fail rather than
    // resolve to `null`.
    const [signedOut, setSignedOut] = useState(false);
    const me = useQuery(api.saas.me, {}, { onError: () => setSignedOut(true) });

    if (me === undefined && !signedOut) {
        return <main aria-busy="true" style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }} />;
    }

    if (!me?.organizationId) {
        return (
            <main className="lu-saas-card" style={{ margin: "3rem auto", maxWidth: "44rem" }}>
                <p>{me ? "Create or switch to an organization to manage its billing." : "Sign in to manage billing."}</p>
            </main>
        );
    }

    // The member count off the admin projection, which better-auth's
    // organization hooks keep current (`lunora/auth/index.ts`).
    return <OrganizationBilling memberCount={me.seats ?? 1} orgRole={me.orgRole} />;
}

interface OrganizationBillingProps {
    memberCount: number;
    orgRole: string | undefined;
}

function OrganizationBilling({ memberCount, orgRole }: OrganizationBillingProps) {
    const subscriptions = useQuery(api.payment.mySubscriptions, {});
    // `useAction` returns `{ call, pending, … }` rather than a callable, the same
    // shape as `useMutation` — destructure at the call site.
    const { call: checkout } = useAction(api.payment.checkout);
    const { call: portal } = useAction(api.payment.portal);
    const [error, setError] = useState<string>();

    // An organisation that cancelled and re-subscribed has both rows stored.
    const subscription = currentSubscription(subscriptions);
    // Only hides the controls — `checkout` and `portal` enforce the role
    // server-side either way.
    const canManageBilling = orgRole?.split(",").some((role) => BILLING_ADMIN_ROLES.has(role.trim())) ?? false;

    const redirectTo = async (start: () => Promise<{ url: string }>) => {
        setError(undefined);

        try {
            const { url } = await start();

            globalThis.location.assign(url);
        } catch (error_) {
            setError(message(error_));
        }
    };

    return (
        <main style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }}>
            <BillingPanel
                memberCount={memberCount}
                // The provider has no customer to open a portal for until the first
                // checkout, so a new organisation is offered the plans instead.
                onManage={canManageBilling && subscription !== undefined ? async () => redirectTo(async () => portal({})) : undefined}
                plans={PLANS}
                subscription={subscription}
            />
            {error ? (
                <p className="lu-saas-error" role="alert">
                    {error}
                </p>
            ) : undefined}
            {canManageBilling ? (
                <PricingTable onSelect={async (priceId) => redirectTo(async () => checkout({ priceId }))} plans={PLANS} subscription={subscription} />
            ) : (
                <p>Ask an organization admin or owner to change the plan.</p>
            )}
        </main>
    );
}
