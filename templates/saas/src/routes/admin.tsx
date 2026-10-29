import type { SubscriptionError } from "@lunora/react";
import { usePaginatedQuery, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../../lunora/_generated/api";
import { PLANS } from "../../lunora/plans";
import { AdminOrganizations, AdminSubscriptions, AdminUsers } from "../../lunora/saas-ui/react";
import { authClient } from "../auth-client";

import "../../lunora/saas-ui/styles.css";

/** Subscriptions per page of the admin table. */
const SUBSCRIPTIONS_PAGE = 50;

export const Route = createFileRoute("/admin")({
    component: AdminPage,
});

/**
 * The platform admin view: users, organisations and subscriptions.
 *
 * Organisations come from the `.global()` `saas_organizations` projection and
 * subscriptions from the root shard's billing tables — the two cross-tenant
 * reads the shard model allows, each one read, no fan-out. Users come from
 * better-auth, which also enforces what this screen does to them: a suspension
 * is a ban, and impersonation is better-auth's own.
 *
 * Every read refuses anyone without the platform admin role (better-auth's
 * `user.role`), so this route needs no gate of its own beyond not linking to it
 * from the app nav. Make yourself an admin by setting your `user.role` to
 * `admin` in D1 — see the README.
 */
function AdminPage() {
    // A query the server refuses never resolves, so the tables would load
    // forever. The refusal arrives here instead.
    const [failure, setFailure] = useState<SubscriptionError>();
    const organizations = useQuery(api.saas.listOrganizations, {}, { onError: setFailure });
    // No `shardKey`: the billing tables live on the root shard. Paged, because the
    // table holds every subscription any tenant has ever had.
    const subscriptions = usePaginatedQuery(api.payment.adminSubscriptions, {}, { initialNumItems: SUBSCRIPTIONS_PAGE, onError: setFailure });
    // Every past-due subscription, listed first: a newest-first page would leave an
    // older tenant in dunning out of sight until someone paged back to it.
    const pastDue = useQuery(api.payment.adminPastDueSubscriptions, {}, { onError: setFailure });
    const { data: session } = authClient.useSession();
    const [now] = useState(() => Date.now());
    // Calendar days are the viewer's, not the Worker's (always UTC). The table
    // only renders once its live query resolves in the browser, so this is the
    // browser's zone by then.
    const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

    if (failure) {
        return (
            <main className="lu-saas-card" style={{ margin: "3rem auto", maxWidth: "44rem" }}>
                <p role="alert">
                    {failure.code === "FORBIDDEN" || failure.code === "UNAUTHORIZED"
                        ? "This page is for platform admins."
                        : "Could not load the admin view — try again."}
                </p>
            </main>
        );
    }

    return (
        <main style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }}>
            {session ? (
                <AdminUsers
                    client={authClient.admin}
                    now={now}
                    onSessionChange={() => {
                        // A full load: the session now belongs to the impersonated user.
                        globalThis.location.assign("/dashboard");
                    }}
                    viewerId={session.user.id}
                />
            ) : undefined}
            <AdminOrganizations now={now} rows={organizations} timeZone={timeZone} />
            <AdminSubscriptions
                onLoadMore={
                    subscriptions.status === "CanLoadMore"
                        ? () => {
                              subscriptions.loadMore(SUBSCRIPTIONS_PAGE);
                          }
                        : undefined
                }
                organizations={organizations}
                pastDue={pastDue}
                plans={PLANS}
                rows={subscriptions.status === "LoadingFirstPage" ? undefined : subscriptions.results}
            />
        </main>
    );
}
