"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import type { AdminView, OrganizationTotals } from "../core/admin-organizations";
import { ORGANIZATION_SEARCH_MAX, planOptions } from "../core/admin-organizations";
import type { AdminSubscriptionRow, PastDueSubscriptions, SubscriptionsView } from "../core/admin-subscriptions";
import {
    DEFAULT_SUBSCRIPTIONS_VIEW,
    selectSubscriptions,
    subscriptionsSubtitle,
    subscriptionStateOptions,
    withPastDueFirst,
} from "../core/admin-subscriptions";
import type { Plan } from "../core/billing";
import { planLabel, relativeTime } from "../core/format";
import type { OrganizationRow } from "../core/types";
import { Card, Empty } from "./primitives";

interface AdminOrganizationsProps {
    now: number;

    /**
     * Fetch the next page — `usePaginatedQuery`'s `loadMore` over `saas.listOrganizations`.
     * Pass it only while more pages remain (`status === "CanLoadMore"`).
     */
    onLoadMore?: () => void;

    /**
     * The admin changed the search or a filter. The list is filtered on the server, so
     * the route owns the view and turns it into the query's arguments with
     * `toOrganizationFilter` — debounce the search there, or every keystroke restarts
     * the list at its first page.
     */
    onViewChange: (view: AdminView) => void;
    /** The plan catalog, for the plan filter — every plan, not only those on loaded pages. */
    plans: ReadonlyArray<Pick<Plan, "id" | "name">>;
    /** The pages loaded so far — `usePaginatedQuery`'s `results`. `undefined` while the first page is in flight. */
    rows: ReadonlyArray<OrganizationRow> | undefined;
    /** IANA zone an older update's date is shown in — the viewer's. UTC when omitted. */
    timeZone?: string;
    /** `saas.organizationTotals` over the same filter. The header waits for it. */
    totals: OrganizationTotals | undefined;
    view: AdminView;
}

/**
 * The platform admin's organisation table.
 *
 * Read-only by design. Every write an admin might want here belongs to the
 * tenant's own shard, and reaching into it from a cross-tenant screen is how a
 * tenancy boundary stops meaning anything — the supported path is better-auth's
 * impersonation, which puts the admin inside the tenant with the tenant's own
 * authorisation applied.
 *
 * Controlled: the rows arrive already searched and filtered. The
 * toolbar stays mounted while a new filter's first page loads, so the search
 * box keeps its focus.
 */
const AdminOrganizations = ({ now, onLoadMore, onViewChange, plans, rows, timeZone, totals, view }: AdminOrganizationsProps): ReactNode => {
    let body: ReactNode;

    if (!rows) {
        body = <div aria-busy="true" className="lu-saas-list lu-saas-list--loading" />;
    } else if (rows.length === 0) {
        body = <Empty title="Nothing matches that filter" />;
    } else {
        body = (
            <table className="lu-saas-table">
                <thead>
                    <tr>
                        <th scope="col">Organization</th>
                        <th scope="col">Plan</th>
                        <th scope="col">Seats</th>
                        <th scope="col">Updated</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((organization) => (
                        <tr key={organization._id}>
                            <td>
                                {organization.name}
                                <code className="lu-saas-row__slug">{organization.slug}</code>
                            </td>
                            <td>{planLabel(organization.plan)}</td>
                            <td>{organization.seats}</td>
                            <td>{relativeTime(organization.updatedAt, now, timeZone)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }

    return (
        <Card subtitle={totals ? `${totals.organizations.toString()} organizations · ${totals.seats.toString()} seats` : undefined} title="Organizations">
            <div className="lu-saas-toolbar">
                <input
                    aria-label="Search organizations"
                    className="lu-saas-input"
                    maxLength={ORGANIZATION_SEARCH_MAX}
                    onChange={(event) => {
                        onViewChange({ ...view, search: event.target.value });
                    }}
                    placeholder="Search"
                    type="search"
                    value={view.search}
                />
                <select
                    aria-label="Filter by plan"
                    className="lu-saas-select"
                    onChange={(event) => {
                        onViewChange({ ...view, plan: event.target.value });
                    }}
                    value={view.plan}
                >
                    {planOptions(plans).map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>

            {body}

            {rows && onLoadMore ? (
                <button className="lu-saas-button lu-saas-button--quiet" onClick={onLoadMore} type="button">
                    Load more
                </button>
            ) : undefined}
        </Card>
    );
};

interface AdminSubscriptionsProps {
    /**
     * Whether pages remain beyond `rows` — `status === "CanLoadMore" || status === "LoadingMore"`.
     * Kept apart from `onLoadMore`, which is absent while a page is loading: the header
     * must still say its totals are partial then. Defaults to whether `onLoadMore` is given.
     */
    hasMore?: boolean;

    /**
     * Fetch the next page — `usePaginatedQuery`'s `loadMore`. Pass it only while
     * more pages remain (`status === "CanLoadMore"`); without it the rows are read
     * as the whole table.
     */
    onLoadMore?: () => void;

    /**
     * The organisations these subscriptions bill, for names — in the saas
     * template, the `organization` each subscription row carries. A subscription
     * whose organisation is missing renders with its id.
     */
    organizations: ReadonlyArray<OrganizationRow> | undefined;

    /**
     * Every past-due subscription — the saas template's `payment.adminPastDueSubscriptions`.
     * Listed first whatever page they fall on, and the header's past-due count is
     * then the whole table's. Without it, past-due rows show only as their pages load.
     */
    pastDue?: PastDueSubscriptions;
    plans: ReadonlyArray<Plan>;
    /** The pages loaded so far — `usePaginatedQuery`'s `results`. `undefined` while the first page is in flight. */
    rows: ReadonlyArray<AdminSubscriptionRow> | undefined;
}

/**
 * Every tenant's subscription, dunning tenants first. Read-only for the same
 * reason as the organisation table: a change to a subscription is made in the
 * provider's dashboard or through the tenant's own billing page, and the
 * webhook brings it back here.
 */
const AdminSubscriptions = ({ hasMore, onLoadMore, organizations, pastDue, plans, rows: paged }: AdminSubscriptionsProps): ReactNode => {
    const [view, setView] = useState<SubscriptionsView>(DEFAULT_SUBSCRIPTIONS_VIEW);

    if (!paged) {
        return (
            <Card title="Subscriptions">
                <div aria-busy="true" className="lu-saas-list lu-saas-list--loading" />
            </Card>
        );
    }

    const rows = withPastDueFirst(pastDue?.rows ?? [], paged);
    const visible = selectSubscriptions(rows, organizations ?? [], plans, view);

    return (
        <Card subtitle={subscriptionsSubtitle(paged, hasMore ?? onLoadMore !== undefined, pastDue)} title="Subscriptions">
            <div className="lu-saas-toolbar">
                <input
                    aria-label="Search subscriptions"
                    className="lu-saas-input"
                    onChange={(event) => {
                        setView({ ...view, search: event.target.value });
                    }}
                    placeholder="Search"
                    type="search"
                    value={view.search}
                />
                <select
                    aria-label="Filter by state"
                    className="lu-saas-select"
                    onChange={(event) => {
                        setView({ ...view, state: event.target.value });
                    }}
                    value={view.state}
                >
                    {subscriptionStateOptions(rows).map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>

            {visible.length === 0 ? (
                <Empty title={rows.length === 0 ? "No subscriptions yet" : "Nothing matches that filter"} />
            ) : (
                <table className="lu-saas-table">
                    <thead>
                        <tr>
                            <th scope="col">Organization</th>
                            <th scope="col">Plan</th>
                            <th scope="col">State</th>
                            <th scope="col">Seats</th>
                            <th scope="col">Renewal</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((subscription) => (
                            <tr key={subscription.key}>
                                <td>
                                    {subscription.organization}
                                    <code className="lu-saas-row__slug">{subscription.id}</code>
                                </td>
                                <td>{subscription.plan}</td>
                                <td>{planLabel(subscription.state)}</td>
                                <td>{subscription.quantity}</td>
                                <td>{subscription.renewal}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {onLoadMore ? (
                <button className="lu-saas-button lu-saas-button--quiet" onClick={onLoadMore} type="button">
                    Load more
                </button>
            ) : undefined}
        </Card>
    );
};

export type { AdminOrganizationsProps, AdminSubscriptionsProps };
export { AdminOrganizations, AdminSubscriptions };
