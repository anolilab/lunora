import type { SubscriptionError } from "@lunora/react";
import { usePaginatedQuery, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api";
import { PLANS } from "../../lunora/plans";
import type { AdminView } from "../../lunora/saas-ui/core";
import { DEFAULT_ADMIN_VIEW, toOrganizationFilter } from "../../lunora/saas-ui/core";
import { AdminOrganizations, AdminSubscriptions, AdminUsers } from "../../lunora/saas-ui/react";
import { authClient } from "../auth-client";

import "../../lunora/saas-ui/styles.css";

/** How often the admin tables' clock advances. */
const CLOCK_TICK_MS = 60_000;

/** Subscriptions per page of the admin table. */
const SUBSCRIPTIONS_PAGE = 50;

/** Organisations per page of the admin table. */
const ORGANIZATIONS_PAGE = 50;

/** How long the search box waits for typing to stop before it restarts the organisation list. */
const SEARCH_DEBOUNCE_MS = 250;

/** `value`, once it has held still for `delayMs`. */
const useDebounced = <T,>(value: T, delayMs: number): T => {
    const [settled, setSettled] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => {
            setSettled(value);
        }, delayMs);

        return () => {
            clearTimeout(timer);
        };
    }, [value, delayMs]);

    return settled;
};

export const Route = createFileRoute("/admin")({
    component: AdminPage,
});

/**
 * The platform admin view: users, organisations and subscriptions.
 *
 * Organisations come from the `.global()` `saas_organizations` projection and
 * subscriptions from the root shard's billing tables — the two cross-tenant
 * reads the shard model allows, each one read, no fan-out. Both are paged, and
 * the organisation search, filter and totals run on the server. Users come from
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
    const [view, setView] = useState<AdminView>(DEFAULT_ADMIN_VIEW);
    const search = useDebounced(view.search, SEARCH_DEBOUNCE_MS);
    const filter = toOrganizationFilter({ ...view, search });
    const organizations = usePaginatedQuery(api.saas.listOrganizations, filter, { initialNumItems: ORGANIZATIONS_PAGE, onError: setFailure });
    const totals = useQuery(api.saas.organizationTotals, filter, { onError: setFailure });
    // No `shardKey`: the billing tables live on the root shard. Paged, because the
    // table holds every subscription any tenant has ever had.
    const subscriptions = usePaginatedQuery(api.payment.adminSubscriptions, {}, { initialNumItems: SUBSCRIPTIONS_PAGE, onError: setFailure });
    // Every past-due subscription, listed first: a newest-first page would leave an
    // older tenant in dunning out of sight until someone paged back to it.
    const pastDue = useQuery(api.payment.adminPastDueSubscriptions, {}, { onError: setFailure });
    // Each subscription row carries its organisation (the list above is paged and
    // filtered, so it cannot name them), read once per page on the server.
    const billedOrganizations = [...(pastDue?.rows ?? []), ...subscriptions.results].flatMap((row) =>
        row.organization === undefined ? [] : [row.organization],
    );
    const { data: session } = authClient.useSession();
    // The clock the tables read, advanced each minute: a timed suspension that has
    // lapsed has to turn back into Active (with Suspend offered), and "4m ago" has
    // to keep counting, without a reload.
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => {
            setNow(Date.now());
        }, CLOCK_TICK_MS);

        return () => {
            clearInterval(timer);
        };
    }, []);
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
            <AdminOrganizations
                now={now}
                onLoadMore={
                    organizations.status === "CanLoadMore"
                        ? () => {
                              organizations.loadMore(ORGANIZATIONS_PAGE);
                          }
                        : undefined
                }
                onViewChange={setView}
                plans={PLANS}
                rows={organizations.status === "LoadingFirstPage" ? undefined : organizations.results}
                timeZone={timeZone}
                totals={totals}
                view={view}
            />
            <AdminSubscriptions
                hasMore={subscriptions.status === "CanLoadMore" || subscriptions.status === "LoadingMore"}
                onLoadMore={
                    subscriptions.status === "CanLoadMore"
                        ? () => {
                              subscriptions.loadMore(SUBSCRIPTIONS_PAGE);
                          }
                        : undefined
                }
                organizations={billedOrganizations}
                pastDue={pastDue}
                plans={PLANS}
                rows={subscriptions.status === "LoadingFirstPage" ? undefined : subscriptions.results}
            />
        </main>
    );
}
